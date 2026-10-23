import { OrderError } from "../errors.js";
import { request } from "./http.js";

const url = (path: string): string => `${process.env.PRODUCTS_SERVICE_URL}/internal${path}`;

/**
 * Reserve stock. Idempotent per reservationId.
 * Returns { productId, name, price }.
 * Throws OrderError 400/404/409 for rejections, 503 if unreachable.
 */
export interface ReservedProduct {
  productId: string;
  name: string;
  price: number;
}

export async function reserve(
  productId: string,
  quantity: number,
  reservationId: string
): Promise<ReservedProduct> {
  const { status, data } = await request(
    "Products service",
    url("/reservations"),
    { method: "POST", body: { productId, quantity, reservationId } }
  );

  if (
    status === 200 &&
    typeof data?.productId === "string" &&
    typeof data?.name === "string" &&
    typeof data?.price === "number"
  ) {
    return data;
  }

  if (status === 400 || status === 404 || status === 409) {
    throw new OrderError(data?.message ?? "Stock reservation failed", status);
  }

  throw new OrderError("Unexpected response from Products service", 502);
}

/**
 * Give reserved stock back. Resolves to true if stock was restored,
 * false if there was nothing to release. Rejects when the outcome is
 * unknown, so Promise.allSettled callers see it as a failure.
 */
export async function release(
  productId: string,
  quantity: number,
  reservationId: string
): Promise<boolean> {
  const { status, data } = await request(
    "Products service",
    url("/reservations/release"),
    { method: "POST", body: { productId, quantity, reservationId } }
  );

  if (status === 200 && typeof data?.released === "boolean") {
    return data.released;
  }

  throw new Error(`Release failed with status ${status}`);
}

/**
 * Tell Products the order committed so it can drop its marker.
 * Rejects on failure; the Products reconciler will finish the job.
 */
export async function finalize(
  productId: string,
  reservationId: string
): Promise<void> {
  const { status } = await request(
    "Products service",
    url("/reservations/finalize"),
    { method: "POST", body: { productId, reservationId } }
  );

  if (status !== 200) {
    throw new Error(`Finalize failed with status ${status}`);
  }
}

/**
 * Hand stock back after a confirmed order is cancelled. Idempotent per
 * returnId. Resolves to true if this call returned the stock, false if
 * that returnId was already applied. Rejects when the outcome is unknown.
 */
export async function returnStock(
  productId: string,
  quantity: number,
  returnId: string
): Promise<boolean> {
  const { status, data } = await request(
    "Products service",
    url("/stock/return"),
    { method: "POST", body: { productId, quantity, returnId } }
  );

  if (status === 200 && typeof data?.returned === "boolean") {
    return data.returned;
  }

  throw new Error(`Stock return failed with status ${status}`);
}
