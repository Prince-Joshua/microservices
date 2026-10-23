import { prisma } from "../config/prisma.js";
import {
  checkPayment,
  notifyOrder,
  processRefund,
} from "../services/payments.js";

const DEFAULT_INTERVAL_MS = 30 * 1000;
const DEFAULT_MIN_AGE_MS = 60 * 1000;
const DEFAULT_ABANDON_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 50;

/**
 * One pass of everything a missed webhook, a crash or an outage can leave
 * behind:
 *
 *   - PENDING payments not looked at for `minAgeMs`: ask Paystack. Success
 *     is settled; payments still unpaid after `abandonMs` become FAILED.
 *   - SUCCESS payments Orders hasn't acknowledged: tell Orders again.
 *   - Refunds still owed: try again.
 */
export interface WorkerOptions {
  intervalMs?: number;
  minAgeMs?: number;
  abandonMs?: number;
}

export interface WorkerStats {
  checked: number;
  notified: number;
  refunded: number;
  errors: number;
}

export async function runPaymentWorker({
  minAgeMs = DEFAULT_MIN_AGE_MS,
  abandonMs = DEFAULT_ABANDON_MS,
}: WorkerOptions = {}): Promise<WorkerStats> {
  const stats: WorkerStats = { checked: 0, notified: 0, refunded: 0, errors: 0 };
  const now = Date.now();

  const pending = await prisma.payment.findMany({
    where: {
      status: "PENDING",
      updatedAt: { lt: new Date(now - minAgeMs) },
    },
    take: BATCH_SIZE,
  });

  for (const payment of pending) {
    try {
      const checked = await checkPayment(payment);
      stats.checked += 1;

      if (checked.status === "PENDING") {
        if (new Date(checked.createdAt).getTime() < now - abandonMs) {
          await prisma.payment.updateMany({
            where: { id: payment.id, status: "PENDING" },
            data: { status: "FAILED" },
          });
        } else {
          // Look again later rather than on every pass.
          await prisma.payment.updateMany({
            where: { id: payment.id, status: "PENDING" },
            data: { updatedAt: new Date() },
          });
        }
      }
    } catch (error) {
      stats.errors += 1;
      console.error("Payment check failed:", payment.reference, error);
    }
  }

  const unacknowledged = await prisma.payment.findMany({
    where: { status: "SUCCESS", notifiedAt: null },
    take: BATCH_SIZE,
  });

  for (const payment of unacknowledged) {
    try {
      const updated = await notifyOrder(payment);

      if (updated.notifiedAt) {
        stats.notified += 1;
      }
    } catch (error) {
      stats.errors += 1;
      console.error("Order notification failed:", payment.reference, error);
    }
  }

  const owed = await prisma.payment.findMany({
    where: { refundState: "OWED" },
    take: BATCH_SIZE,
  });

  for (const payment of owed) {
    try {
      const updated = await processRefund(payment);

      if (updated.refundState === "DONE") {
        stats.refunded += 1;
      }
    } catch (error) {
      stats.errors += 1;
      console.error("Refund retry failed:", payment.reference, error);
    }
  }

  return stats;
}

/**
 * Runs the worker on an interval, never overlapping itself.
 * Returns a function that stops it.
 */
export function startPaymentWorker({
  intervalMs = DEFAULT_INTERVAL_MS,
  minAgeMs = DEFAULT_MIN_AGE_MS,
  abandonMs = DEFAULT_ABANDON_MS,
}: WorkerOptions = {}): () => void {
  let running = false;

  const tick = async () => {
    if (running) {
      return;
    }

    running = true;

    try {
      const stats = await runPaymentWorker({ minAgeMs, abandonMs });

      if (stats.checked || stats.notified || stats.refunded || stats.errors) {
        console.log("Payment worker:", stats);
      }
    } catch (error) {
      console.error("Payment worker run failed:", error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref(); // don't keep the process alive just for this

  return () => clearInterval(timer);
}
