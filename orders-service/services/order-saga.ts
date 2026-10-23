import type { Prisma } from "@prisma/client";

import { prisma } from "../config/prisma.js";
import {
  type ReservedProduct,
  reserve,
  release,
  finalize,
  returnStock,
} from "../clients/products.client.js";
import { requestRefund } from "../clients/payments.client.js";
import { toMinorUnits } from "./money.js";

/**
 * Order sagas, orchestrated here and persisted in Postgres.
 *
 * The order row is written BEFORE any other service is touched, so the
 * intent survives a crash. Every later step is idempotent and every state
 * change is a conditional update ("... WHERE status = 'PENDING'"), so the
 * request handler and the recovery worker can drive the same order at the
 * same time without double-committing or double-releasing.
 *
 * CREATE saga
 *   1. insert order            PENDING / RUNNING            (route)
 *   2. reserve stock           Products, per item, idempotent
 *   3. commit                  items + total, AWAITING_PAYMENT / DONE (one tx)
 *   4. finalize markers        Products, best effort
 *   Failure after 1 and before 3:
 *     mark FAILED / COMPENSATING first (conditional), THEN release stock,
 *     then DONE. Marking first means a commit that is secretly in flight
 *     can never be undone: only one of the two conditional updates wins.
 *
 * PAYMENT
 *   The Payments service tells us (applyPaymentSuccess) when Paystack has
 *   verifiably received the money. AWAITING_PAYMENT -> CONFIRMED is a
 *   conditional update, so a payment can only ever confirm a live order.
 *   Money for any other order state is rejected, and Payments refunds it.
 *
 * CANCEL saga (AWAITING_PAYMENT or CONFIRMED)
 *   mark CANCELLED / COMPENSATING (conditional), return stock per item
 *   (idempotent per returnId) and, if the order was paid, refund the
 *   payment (idempotent), then DONE. Unpaid orders past paymentDueAt are
 *   cancelled the same way by the recovery worker.
 *
 * Anything left COMPENSATING, or RUNNING for too long, is picked up by the
 * recovery worker. An unknown outcome is never treated as a failure: we
 * re-read the order and only roll back when it is verifiably still PENDING.
 */

// Reservation rejections that will never succeed on retry.
const REJECTION_STATUSES = new Set([400, 404, 409, 422]);

const maxAgeMs = () => Number(process.env.SAGA_MAX_AGE_MS) || 10 * 60 * 1000;
const paymentTtlMs = () =>
  Number(process.env.PAYMENT_TTL_MS) || 30 * 60 * 1000;

export type OrderWithItems = Prisma.OrderGetPayload<{
  include: { items: true };
}>;

export interface RequestedItem {
  productId: string;
  quantity: number;
}

/** What a create-saga step (or a replayed request) resolves to. */
export type SagaOutcome =
  | { outcome: "placed"; order: OrderWithItems }
  | { outcome: "failed"; status: number; message: string; order?: OrderWithItems }
  | { outcome: "retry"; order?: OrderWithItems };

export type PaymentAnswer =
  | { accepted: true }
  | { accepted: false; reason: string };

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function loadOrder(id: string): Promise<OrderWithItems | null> {
  return prisma.order.findUnique({
    where: { id },
    include: { items: true },
  });
}

/** Like loadOrder, for rows that must exist (orders are never deleted). */
export async function mustLoadOrder(id: string): Promise<OrderWithItems> {
  const order = await loadOrder(id);

  if (!order) {
    throw new Error(`Order ${id} disappeared`);
  }

  return order;
}

/** Translate an order's stored state into a saga outcome. */
export function outcomeFromOrder(order: OrderWithItems | null): SagaOutcome {
  if (!order) {
    return { outcome: "retry" };
  }

  if (order.status === "FAILED") {
    return {
      outcome: "failed",
      status: order.failureStatus ?? 409,
      message: order.failureReason ?? "Order failed",
      order,
    };
  }

  if (order.status === "PENDING") {
    return { outcome: "retry", order };
  }

  // AWAITING_PAYMENT, CONFIRMED, FULFILLED or CANCELLED: the create saga
  // is over and the order exists.
  return { outcome: "placed", order };
}

/**
 * Hand stock (and, for a paid order, the money) back for a FAILED or
 * CANCELLED order, then mark the saga DONE. Returns true when everything
 * was handed back. Safe to call repeatedly; failures are logged and left
 * for the worker.
 */
export async function runCompensation(order: OrderWithItems): Promise<boolean> {
  try {
    let results: PromiseSettledResult<unknown>[];

    if (order.status === "FAILED") {
      results = await Promise.allSettled(
        ((order.requestedItems ?? []) as unknown as RequestedItem[]).map(
          ({ productId, quantity }) =>
            release(productId, quantity, String(order.reservationId))
        )
      );
    } else if (order.status === "CANCELLED") {
      const tasks: Promise<unknown>[] = order.items.map((item) =>
        returnStock(item.productId, item.quantity, `cancel:${order.id}`)
      );

      if (order.paidAt) {
        tasks.push(
          requestRefund(order.id, order.cancelReason ?? "Order cancelled")
        );
      }

      results = await Promise.allSettled(tasks);
    } else {
      return true;
    }

    if (results.some((result) => result.status === "rejected")) {
      console.error("Compensation incomplete; will retry:", {
        orderId: order.id,
        status: order.status,
        failures: results
          .filter((result) => result.status === "rejected")
          .map((result) => errorMessage(result.reason)),
      });

      return false;
    }

    await prisma.order.updateMany({
      where: { id: order.id, sagaState: "COMPENSATING" },
      data: { sagaState: "DONE" },
    });

    return true;
  } catch (error) {
    console.error("Compensation failed; will retry:", order.id, error);
    return false;
  }
}

/**
 * Roll a still-PENDING order back. Returns the outcome to report.
 * If another actor already decided the order's fate, that decision wins.
 */
async function failAndCompensate(
  order: OrderWithItems,
  status: number,
  message: string
): Promise<SagaOutcome> {
  const marked = await prisma.order.updateMany({
    where: { id: order.id, status: "PENDING", sagaState: "RUNNING" },
    data: {
      status: "FAILED",
      sagaState: "COMPENSATING",
      failureStatus: status,
      failureReason: message,
    },
  });

  if (marked.count !== 1) {
    return outcomeFromOrder(await loadOrder(order.id));
  }

  const failed = await mustLoadOrder(order.id);
  await runCompensation(failed);

  return { outcome: "failed", status, message, order: failed };
}

/** Best-effort removal of reservation markers after commit. */
async function finalizeMarkers(order: OrderWithItems): Promise<void> {
  const cleanup = await Promise.allSettled(
    order.items.map((item) => finalize(item.productId, String(order.reservationId)))
  );

  if (cleanup.some((result) => result.status === "rejected")) {
    console.error(
      "Order committed, but reservation cleanup needs the reconciler:",
      order.id,
      order.reservationId
    );
  }
}

/**
 * Run (or resume) the create saga for a PENDING order.
 *
 * Resolves to one of:
 *   { outcome: "placed", order }                    (AWAITING_PAYMENT, or
 *                                                    later if already paid)
 *   { outcome: "failed", status, message, order }   (rolled back)
 *   { outcome: "retry", order? }                    (not decided yet;
 *                                                    the worker continues)
 */
export async function driveCreateSaga(order: OrderWithItems): Promise<SagaOutcome> {
  const requested: RequestedItem[] = Array.isArray(order.requestedItems)
    ? (order.requestedItems as unknown as RequestedItem[])
    : [];

  const ageMs = Date.now() - new Date(order.createdAt).getTime();
  const reserved: {
    productId: string;
    productName: string;
    quantity: number;
    unitCents: number;
  }[] = [];

  // STEP 2: reserve stock, item by item. Re-reserving after a crash is
  // harmless because reserve is idempotent per reservationId.
  for (const { productId, quantity } of requested) {
    let product: ReservedProduct;

    try {
      product = await reserve(productId, quantity, String(order.reservationId));
    } catch (error) {
      const statusCode = (error as { statusCode?: number } | null)?.statusCode;

      if (statusCode !== undefined && REJECTION_STATUSES.has(statusCode)) {
        return failAndCompensate(order, statusCode, errorMessage(error));
      }

      // Products unreachable or misbehaving: undecided, unless this has
      // dragged on too long.
      if (ageMs > maxAgeMs()) {
        return failAndCompensate(
          order,
          503,
          "Order timed out waiting for the Products service"
        );
      }

      console.error("Reserve step undecided; will retry:", order.id, error);
      return { outcome: "retry", order };
    }

    const unitCents = Math.round(Number(product.price) * 100);

    if (
      !Number.isFinite(Number(product.price)) ||
      !Number.isSafeInteger(unitCents) ||
      unitCents < 0
    ) {
      return failAndCompensate(
        order,
        422,
        `Invalid price for product ${productId}`
      );
    }

    reserved.push({
      productId: product.productId,
      productName: product.name,
      quantity,
      unitCents,
    });
  }

  // STEP 3: commit items + total and open the payment window, atomically.
  const totalCents = reserved.reduce(
    (sum, item) => sum + item.unitCents * item.quantity,
    0
  );

  if (!Number.isSafeInteger(totalCents)) {
    return failAndCompensate(order, 400, "Order total is too large");
  }

  if (totalCents < 1) {
    return failAndCompensate(order, 422, "Order total must be greater than zero");
  }

  try {
    const committed = await prisma.$transaction(async (tx) => {
      const placed = await tx.order.updateMany({
        where: { id: order.id, status: "PENDING", sagaState: "RUNNING" },
        data: {
          status: "AWAITING_PAYMENT",
          sagaState: "DONE",
          totalAmount: (totalCents / 100).toFixed(2),
          paymentDueAt: new Date(Date.now() + paymentTtlMs()),
        },
      });

      if (placed.count !== 1) {
        return false;
      }

      await tx.orderItem.createMany({
        data: reserved.map((item) => ({
          orderId: order.id,
          productId: item.productId,
          productName: item.productName,
          quantity: item.quantity,
          unitPrice: (item.unitCents / 100).toFixed(2),
        })),
      });

      return true;
    });

    if (!committed) {
      // Someone else (the worker, or a duplicate request) decided first.
      return outcomeFromOrder(await loadOrder(order.id));
    }
  } catch (error) {
    // The commit's outcome is unknown. Never guess: read it back. If the
    // read also fails, stay undecided and let the worker settle it.
    console.error("Commit outcome unknown; checking:", order.id, error);

    try {
      const current = await loadOrder(order.id);

      if (!current || current.status === "PENDING") {
        return { outcome: "retry", order: current ?? order };
      }

      if (current.status === "FAILED") {
        return outcomeFromOrder(current);
      }
    } catch {
      return { outcome: "retry", order };
    }
  }

  const placed = await mustLoadOrder(order.id);

  // STEP 4: tidy Products' markers; the reconciler covers any failure.
  await finalizeMarkers(placed);

  return { outcome: "placed", order: placed };
}

/**
 * The Payments service reports a verified payment for an order.
 * Resolves to { accepted: true } or { accepted: false, reason }; a
 * rejection means Payments refunds the money.
 *
 * Idempotent: the same reference reported again is accepted again.
 */
export async function applyPaymentSuccess(
  orderId: string,
  {
    reference,
    amount,
    currency,
  }: { reference: string; amount: number; currency: string }
): Promise<PaymentAnswer> {
  const order = await loadOrder(orderId);

  if (!order) {
    return { accepted: false, reason: "ORDER_NOT_FOUND" };
  }

  if (order.paidAt && order.paymentReference === reference) {
    return { accepted: true };
  }

  if (amount !== toMinorUnits(order.totalAmount) || currency !== order.currency) {
    return { accepted: false, reason: "AMOUNT_MISMATCH" };
  }

  const confirmed = await prisma.order.updateMany({
    where: { id: orderId, status: "AWAITING_PAYMENT" },
    data: {
      status: "CONFIRMED",
      paidAt: new Date(),
      paymentReference: reference,
    },
  });

  if (confirmed.count === 1) {
    return { accepted: true };
  }

  // Lost a race (cancelled or expired, or another attempt paid first).
  const current = await loadOrder(orderId);

  if (current?.paidAt && current.paymentReference === reference) {
    return { accepted: true };
  }

  const reasons: Record<string, string> = {
    CANCELLED: "ORDER_CANCELLED",
    FAILED: "ORDER_FAILED",
    CONFIRMED: "ALREADY_PAID",
    FULFILLED: "ALREADY_PAID",
  };

  return {
    accepted: false,
    reason: (current && reasons[current.status]) ?? "ORDER_NOT_AWAITING_PAYMENT",
  };
}

/**
 * Cancel an order that is AWAITING_PAYMENT or CONFIRMED and hand back its
 * stock (and refund it, if it was paid).
 * `changed` is false when the order wasn't in a cancellable state (the
 * caller decides what that means from the returned order).
 */
export async function cancelOrder(
  orderId: string,
  { reason = "Cancelled by customer" }: { reason?: string } = {}
): Promise<{ changed: boolean; order: OrderWithItems }> {
  const marked = await prisma.order.updateMany({
    where: { id: orderId, status: { in: ["AWAITING_PAYMENT", "CONFIRMED"] } },
    data: {
      status: "CANCELLED",
      sagaState: "COMPENSATING",
      cancelledAt: new Date(),
      cancelReason: reason,
    },
  });

  if (marked.count === 1) {
    await runCompensation(await mustLoadOrder(orderId));
  }

  return { changed: marked.count === 1, order: await mustLoadOrder(orderId) };
}

/**
 * Cancel orders whose payment window has closed. Anything paid in the
 * meantime is no longer AWAITING_PAYMENT, so it is never touched; a
 * payment that lands after cancellation is rejected and refunded.
 * Returns how many orders were cancelled.
 */
export async function expireUnpaidOrders({
  batch = 50,
}: { batch?: number } = {}): Promise<number> {
  const due = await prisma.order.findMany({
    where: { status: "AWAITING_PAYMENT", paymentDueAt: { lt: new Date() } },
    orderBy: { paymentDueAt: "asc" },
    take: batch,
  });

  let expired = 0;

  for (const order of due) {
    const { changed } = await cancelOrder(order.id, {
      reason: "Payment not received in time",
    });

    if (changed) {
      expired += 1;
    }
  }

  return expired;
}

/** CONFIRMED (paid) -> FULFILLED. */
export async function fulfillConfirmedOrder(
  orderId: string
): Promise<{ changed: boolean; order: OrderWithItems }> {
  const marked = await prisma.order.updateMany({
    where: { id: orderId, status: "CONFIRMED", sagaState: "DONE" },
    data: { status: "FULFILLED" },
  });

  return { changed: marked.count === 1, order: await mustLoadOrder(orderId) };
}
