import type { Payment } from "@prisma/client";

import { prisma } from "../config/prisma.js";
import * as paystack from "../clients/paystack.js";
import {
  notifyPaymentSucceeded,
  type PaymentSucceededAnswer,
} from "../clients/orders.client.js";
import { PaymentError, PaystackError } from "../errors.js";

/**
 * Payment lifecycle.
 *
 *   initiatePayment   record the attempt (PENDING), THEN ask Paystack for a
 *                     checkout URL. Idempotent per order.
 *   checkPayment      ask Paystack what really happened (never trust a
 *                     webhook body or a redirect) and settle accordingly.
 *   notifyOrder       tell Orders about a SUCCESS payment. Orders accepts it
 *                     (order confirmed) or rejects it (order cancelled,
 *                     already paid, wrong amount); a rejection means refund.
 *   processRefund     send money back, safely repeatable.
 *
 * Every state change is a conditional update, and every external call is
 * safe to repeat, so webhooks, the worker and customer-triggered
 * verification can all run at once on the same payment.
 */

const MAX_REFUND_ATTEMPTS = 10;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function publicPayment(payment: Payment) {
  return {
    reference: payment.reference,
    status: payment.status,
    authorizationUrl: payment.authorizationUrl,
    accessCode: payment.accessCode,
    amount: Number(payment.amount),
    currency: payment.currency,
  };
}

/** Re-read a row we know exists (rows are never deleted). */
async function reload(id: string): Promise<Payment> {
  const payment = await prisma.payment.findUnique({ where: { id } });

  if (!payment) {
    throw new Error(`Payment ${id} disappeared`);
  }

  return payment;
}

const byNewest = (a: Payment, b: Payment): number => b.attempt - a.attempt;

/**
 * Start (or resume) a payment for an order.
 * Returns { status: "PENDING" | "SUCCESS", payment }.
 */
export interface InitiateInput {
  orderId: string;
  userId: string;
  email: string;
  amount: number;
  currency: string;
}

export async function initiatePayment({
  orderId,
  userId,
  email,
  amount,
  currency,
}: InitiateInput): Promise<{
  status: "PENDING" | "SUCCESS";
  payment: ReturnType<typeof publicPayment>;
}> {
  const attempts = (await prisma.payment.findMany({ where: { orderId } })).sort(
    byNewest
  );

  const paid = attempts.find((payment) => payment.status === "SUCCESS");

  if (paid) {
    return { status: "SUCCESS", payment: publicPayment(paid) };
  }

  // Reuse the live checkout session: Paystack won't accept a reference
  // twice, and a customer who reloads shouldn't get a second charge page.
  const reusable = attempts.find(
    (payment) =>
      payment.status === "PENDING" &&
      payment.authorizationUrl &&
      Number(payment.amount) === amount &&
      payment.currency === currency
  );

  if (reusable) {
    return { status: "PENDING", payment: publicPayment(reusable) };
  }

  // Anything else still PENDING can't be resumed (no URL, or a different
  // amount). Retire it; if it is somehow paid later, the webhook still
  // settles it and Orders decides whether the money is wanted.
  for (const stale of attempts.filter((p) => p.status === "PENDING")) {
    await prisma.payment.updateMany({
      where: { id: stale.id, status: "PENDING" },
      data: { status: "FAILED" },
    });
  }

  const attempt = (attempts[0]?.attempt ?? 0) + 1;
  let payment: Payment;

  try {
    // Intent first: the row exists before Paystack hears about it.
    payment = await prisma.payment.create({
      data: {
        orderId,
        attempt,
        userId,
        email,
        amount,
        currency,
        reference: `${orderId}-a${attempt}`,
      },
    });
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "P2002") {
      throw new PaymentError("Payment is being prepared; retry shortly", 409);
    }

    throw error;
  }

  let session: paystack.CheckoutSession;

  try {
    session = await paystack.initializeTransaction({
      email,
      amount,
      currency,
      reference: payment.reference,
      callbackUrl: process.env.PAYMENT_CALLBACK_URL,
      metadata: { orderId, userId },
    });
  } catch (error) {
    // The row stays PENDING without a URL; the next call retires it.
    console.error("Paystack initialize failed:", payment.reference, error);

    throw new PaymentError(
      error instanceof PaystackError && !error.transient
        ? `Paystack rejected the payment: ${error.message}`
        : "Payment provider is unavailable",
      error instanceof PaystackError && !error.transient ? 422 : 503
    );
  }

  await prisma.payment.updateMany({
    where: { id: payment.id },
    data: {
      authorizationUrl: session.authorizationUrl,
      accessCode: session.accessCode,
    },
  });

  return { status: "PENDING", payment: publicPayment(await reload(payment.id)) };
}

/** Look a payment up by reference and settle it against Paystack. */
export async function verifyAndSettle(reference: string): Promise<Payment | null> {
  const payment = await prisma.payment.findUnique({ where: { reference } });

  return payment ? checkPayment(payment) : null;
}

/**
 * Ask Paystack what happened to a payment and act on the answer.
 * Throws when Paystack can't be asked; the caller retries later.
 */
export async function checkPayment(payment: Payment): Promise<Payment> {
  if (payment.status === "SUCCESS") {
    return notifyOrder(payment);
  }

  let verified: paystack.PaystackTransaction;

  try {
    verified = await paystack.verifyTransaction(payment.reference);
  } catch (error) {
    if (
      error instanceof PaystackError &&
      !error.transient &&
      !payment.authorizationUrl
    ) {
      // Paystack never heard of it: the initialize call never landed.
      await prisma.payment.updateMany({
        where: { id: payment.id, status: "PENDING" },
        data: { status: "FAILED" },
      });

      return reload(payment.id);
    }

    throw error;
  }

  if (verified.status === "success") {
    return settleSuccess(payment, verified);
  }

  if (verified.status === "failed" || verified.status === "reversed") {
    await prisma.payment.updateMany({
      where: { id: payment.id, status: "PENDING" },
      data: { status: "FAILED" },
    });
  }

  // abandoned / pending / ongoing / processing / queued: still open.
  return reload(payment.id);
}

/**
 * Money arrived. Record it (from any non-SUCCESS state: Paystack is the
 * source of truth, even for an attempt we had given up on), then tell Orders.
 */
async function settleSuccess(
  payment: Payment,
  verified: paystack.PaystackTransaction
): Promise<Payment> {
  const mismatch =
    Number(verified.amount) !== Number(payment.amount) ||
    verified.currency !== payment.currency;

  const received = {
    status: "SUCCESS" as const,
    paidAt: new Date(),
    paystackId: verified.id,
  };

  const flipped = await prisma.payment.updateMany({
    where: { id: payment.id, status: { not: "SUCCESS" } },
    data: mismatch
      ? {
          ...received,
          // Never offered to Orders: refund straight away.
          notifiedAt: new Date(),
          orderAccepted: false,
          rejectReason: "AMOUNT_MISMATCH",
          refundState: "OWED" as const,
          refundReason: "Amount received did not match the order",
        }
      : received,
  });

  if (mismatch && flipped.count === 1) {
    console.error("Payment amount mismatch; refunding:", {
      reference: payment.reference,
      expected: `${payment.amount} ${payment.currency}`,
      received: `${verified.amount} ${verified.currency}`,
    });
  }

  const current = await reload(payment.id);

  return mismatch ? processRefund(current) : notifyOrder(current);
}

/**
 * Tell Orders about a SUCCESS payment, once. If Orders can't be reached
 * nothing changes and the worker tries again.
 */
export async function notifyOrder(payment: Payment): Promise<Payment> {
  if (payment.notifiedAt) {
    return payment;
  }

  let answer: PaymentSucceededAnswer;

  try {
    answer = await notifyPaymentSucceeded({
      orderId: payment.orderId,
      reference: payment.reference,
      amount: Number(payment.amount),
      currency: payment.currency,
    });
  } catch (error) {
    console.error("Could not tell Orders about a payment; will retry:", {
      reference: payment.reference,
      error: errorMessage(error),
    });

    return payment;
  }

  if (answer.accepted) {
    await prisma.payment.updateMany({
      where: { id: payment.id, notifiedAt: null },
      data: { notifiedAt: new Date(), orderAccepted: true },
    });

    return reload(payment.id);
  }

  const reason = answer.reason ?? "REJECTED";

  await prisma.payment.updateMany({
    where: { id: payment.id, notifiedAt: null },
    data: {
      notifiedAt: new Date(),
      orderAccepted: false,
      rejectReason: reason,
      refundState: "OWED" as const,
      refundReason: `Order did not accept the payment (${reason})`,
    },
  });

  return processRefund(await reload(payment.id));
}

// How long one caller may hold a refund before another may take over (crash safety).
const REFUND_LEASE_MS = 60 * 1000;

/**
 * Send owed money back to the customer. Safe to repeat: before creating a
 * refund it checks whether Paystack already has one for this transaction,
 * so a lost response can't cause a double refund.
 */
export async function processRefund(payment: Payment): Promise<Payment> {
  if (payment.refundState !== "OWED") {
    return payment;
  }

  // Take a lease before touching Paystack. "Check Paystack, then refund" is not
  // atomic, so with several instances (or the worker racing a request) two
  // callers could both pass the check and refund twice. The update below
  // succeeds for exactly one of them: it only matches if nobody else changed
  // the attempt counter and no unexpired lease exists.
  const attempts = payment.refundAttempts + 1;
  const now = new Date();

  const claim = await prisma.payment.updateMany({
    where: {
      id: payment.id,
      refundState: "OWED",
      refundAttempts: payment.refundAttempts,
      OR: [{ refundClaimedUntil: null }, { refundClaimedUntil: { lt: now } }],
    },
    data: {
      refundAttempts: attempts,
      refundClaimedUntil: new Date(now.getTime() + REFUND_LEASE_MS),
    },
  });

  if (claim.count === 0) {
    // Someone else is refunding this payment right now; let them finish.
    return reload(payment.id);
  }

  try {
    const existing = payment.paystackId
      ? await paystack.listRefunds(String(payment.paystackId))
      : [];

    if (!existing.some((refund) => refund.status !== "failed")) {
      await paystack.createRefund({
        transaction: payment.reference,
        merchantNote: payment.refundReason ?? "Refund",
      });
    }

    await prisma.payment.updateMany({
      where: { id: payment.id, refundState: "OWED" },
      data: { refundState: "DONE", refundedAt: new Date(), refundClaimedUntil: null },
    });
  } catch (error) {
    console.error("Refund attempt failed:", {
      reference: payment.reference,
      attempt: attempts,
      error: errorMessage(error),
    });

    if (attempts >= MAX_REFUND_ATTEMPTS) {
      console.error(
        "CRITICAL: refund needs manual attention in the Paystack dashboard:",
        payment.reference
      );

      await prisma.payment.updateMany({
        where: { id: payment.id, refundState: "OWED" },
        data: { refundState: "FAILED", refundClaimedUntil: null },
      });
    } else {
      // Release the lease so the next worker pass may retry.
      await prisma.payment.updateMany({
        where: { id: payment.id, refundState: "OWED" },
        data: { refundClaimedUntil: null },
      });
    }
  }

  return reload(payment.id);
}

/**
 * Refund the accepted payment for an order (the order was cancelled after
 * being paid). Idempotent. Resolves to
 *   NOT_PAID  no accepted payment exists for this order
 *   DONE      refunded
 *   QUEUED    owed and being retried
 *   FAILED    gave up; needs manual handling
 */
export async function requestRefund(
  orderId: string,
  reason?: string
): Promise<{ state: "NOT_PAID" | "DONE" | "QUEUED" | "FAILED" }> {
  const [payment] = await prisma.payment.findMany({
    where: { orderId, status: "SUCCESS", orderAccepted: true },
  });

  if (!payment) {
    return { state: "NOT_PAID" };
  }

  if (payment.refundState === "NONE") {
    await prisma.payment.updateMany({
      where: { id: payment.id, refundState: "NONE" },
      data: { refundState: "OWED" as const, refundReason: reason ?? "Order cancelled" },
    });
  }

  const updated = await processRefund(await reload(payment.id));

  if (updated.refundState === "DONE") {
    return { state: "DONE" };
  }

  return { state: updated.refundState === "FAILED" ? "FAILED" : "QUEUED" };
}

/**
 * Customer-triggered check ("I just paid"): settle whatever Paystack says
 * about this order's open payments, without waiting for the webhook.
 * Resolves to { status: "NONE" | "PENDING" | "SUCCESS" | "FAILED" }.
 */
export async function verifyOrderPayment(
  orderId: string
): Promise<{ status: "NONE" | "PENDING" | "SUCCESS" | "FAILED" }> {
  const attempts = (await prisma.payment.findMany({ where: { orderId } })).sort(
    byNewest
  );
  const newest = attempts[0];

  if (!newest) {
    return { status: "NONE" };
  }

  const paid = attempts.find((payment) => payment.status === "SUCCESS");

  if (paid) {
    await notifyOrder(paid);
    return { status: "SUCCESS" };
  }

  for (const payment of attempts.filter((p) => p.status === "PENDING")) {
    const checked = await checkPayment(payment);

    if (checked.status === "SUCCESS") {
      return { status: "SUCCESS" };
    }
  }

  return { status: (await reload(newest.id)).status };
}

export interface PaystackEvent {
  event?: unknown;
  data?: {
    reference?: unknown;
    transaction_reference?: unknown;
    transaction?: { reference?: unknown };
  };
}

/** React to a verified Paystack webhook event. */
export async function handlePaystackEvent(event: PaystackEvent | null): Promise<void> {
  const data = event?.data ?? {};

  switch (event?.event) {
    case "charge.success":
      // The payload is only a hint about WHICH payment to check; the
      // outcome always comes from asking Paystack directly.
      if (typeof data.reference === "string") {
        await verifyAndSettle(data.reference);
      }

      return;

    case "refund.processed": {
      const reference = data.transaction_reference ?? data.transaction?.reference;

      if (typeof reference === "string") {
        await prisma.payment.updateMany({
          where: { reference, refundState: { in: ["OWED", "FAILED"] } },
          data: { refundState: "DONE" as const, refundedAt: new Date() },
        });
      }

      return;
    }

    case "refund.failed": {
      const reference = data.transaction_reference ?? data.transaction?.reference;

      console.error("CRITICAL: Paystack could not process a refund:", reference);

      if (typeof reference === "string") {
        await prisma.payment.updateMany({
          where: { reference, refundState: { in: ["OWED", "DONE"] } },
          data: { refundState: "FAILED" as const },
        });
      }

      return;
    }

    default:
      // Other events are acknowledged and ignored.
  }
}
