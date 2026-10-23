import { OrderError } from "../errors.js";
import { request } from "./http.js";

const url = (path: string): string => `${process.env.PAYMENTS_SERVICE_URL}/internal${path}`;

/**
 * Start (or resume) the payment for an order. Idempotent per order.
 * Returns { status: "PENDING" | "SUCCESS", payment: { reference,
 * authorizationUrl, accessCode, amount, currency } }.
 */
export interface PaymentSession {
  status: "PENDING" | "SUCCESS" | (string & {});
  payment: {
    reference: string;
    authorizationUrl?: string | null;
    accessCode?: string | null;
    amount?: number;
    currency?: string;
    status?: string;
  };
}

export async function initializePayment({
  orderId,
  userId,
  email,
  amount,
  currency,
}: {
  orderId: string;
  userId: string;
  email: string;
  amount: number;
  currency: string;
}): Promise<PaymentSession> {
  const { status, data } = await request(
    "Payments service",
    url("/payments"),
    { method: "POST", body: { orderId, userId, email, amount, currency } }
  );

  if (
    status === 200 &&
    typeof data?.status === "string" &&
    typeof data?.payment?.reference === "string"
  ) {
    return data;
  }

  if (status === 400 || status === 409 || status === 422) {
    throw new OrderError(data?.message ?? "Payment was rejected", status);
  }

  throw new OrderError("Unexpected response from Payments service", 502);
}

/**
 * Ask Payments to refund an order's accepted payment. Idempotent.
 * Resolves once Payments has taken responsibility for the refund (it
 * retries on its own); rejects when the answer is unknown.
 */
export async function requestRefund(
  orderId: string,
  reason?: string
): Promise<string> {
  const { status, data } = await request(
    "Payments service",
    url("/payments/refund"),
    { method: "POST", body: { orderId, reason } }
  );

  if (status === 200 && typeof data?.state === "string") {
    if (data.state === "FAILED") {
      // Paystack refused repeatedly; retrying from here won't help.
      console.error(
        "CRITICAL: refund failed and needs manual handling for order",
        orderId
      );
    }

    return data.state;
  }

  throw new Error(`Refund request failed with status ${status}`);
}

/**
 * Ask Payments to re-check the order's payments with Paystack right now
 * ("I just paid"). Payments tells Orders the result through the normal
 * callback. Returns { status: "NONE" | "PENDING" | "SUCCESS" | "FAILED" }.
 */
export async function verifyPayment(
  orderId: string
): Promise<{ status: string }> {
  const { status, data } = await request(
    "Payments service",
    url("/payments/verify"),
    { method: "POST", body: { orderId } }
  );

  if (status === 200 && typeof data?.status === "string") {
    return data;
  }

  throw new OrderError("Unexpected response from Payments service", 502);
}
