import { prisma } from "../config/prisma.js";
import {
  driveCreateSaga,
  runCompensation,
  expireUnpaidOrders,
} from "../services/order-saga.js";

const DEFAULT_INTERVAL_MS = 15 * 1000;
const DEFAULT_STALE_MS = 30 * 1000;
const BATCH_SIZE = 50;

/**
 * One recovery pass over sagas that a crash, a timeout or an outage left
 * half-done:
 *
 *   - PENDING / RUNNING orders nobody has touched for `staleMs` are
 *     re-driven: reserve (idempotent) -> commit, or roll back if the
 *     saga has outlived SAGA_MAX_AGE_MS.
 *   - COMPENSATING orders (FAILED or CANCELLED) get their stock handed
 *     back (and any payment refunded) again until Products and Payments
 *     confirm.
 *   - AWAITING_PAYMENT orders past their payment deadline are cancelled.
 *
 * Every step is idempotent and every transition is a conditional update,
 * so this can run on several instances, and alongside live requests.
 */
export interface RecoveryStats {
  driven: number;
  compensated: number;
  expired: number;
  errors: number;
}

export async function recoverSagas({
  staleMs = DEFAULT_STALE_MS,
}: { staleMs?: number } = {}): Promise<RecoveryStats> {
  const staleBefore = new Date(Date.now() - staleMs);
  const stats: RecoveryStats = { driven: 0, compensated: 0, expired: 0, errors: 0 };

  const stuckCreates = await prisma.order.findMany({
    where: {
      status: "PENDING",
      sagaState: "RUNNING",
      updatedAt: { lt: staleBefore },
    },
    include: { items: true },
    orderBy: { updatedAt: "asc" },
    take: BATCH_SIZE,
  });

  for (const order of stuckCreates) {
    try {
      const result = await driveCreateSaga(order);

      if (result.outcome !== "retry") {
        stats.driven += 1;
      }
    } catch (error) {
      stats.errors += 1;
      console.error("Saga recovery failed for order:", order.id, error);
    }
  }

  const pendingCompensations = await prisma.order.findMany({
    where: {
      sagaState: "COMPENSATING",
      updatedAt: { lt: staleBefore },
    },
    include: { items: true },
    orderBy: { updatedAt: "asc" },
    take: BATCH_SIZE,
  });

  for (const order of pendingCompensations) {
    try {
      if (await runCompensation(order)) {
        stats.compensated += 1;
      }
    } catch (error) {
      stats.errors += 1;
      console.error("Compensation retry failed for order:", order.id, error);
    }
  }

  try {
    stats.expired = await expireUnpaidOrders({ batch: BATCH_SIZE });
  } catch (error) {
    stats.errors += 1;
    console.error("Expiring unpaid orders failed:", error);
  }

  return stats;
}

/**
 * Runs recovery on an interval, never overlapping itself.
 * Returns a function that stops it.
 */
export function startSagaRecovery({
  intervalMs = DEFAULT_INTERVAL_MS,
  staleMs = DEFAULT_STALE_MS,
}: { intervalMs?: number; staleMs?: number } = {}): () => void {
  let running = false;

  const tick = async () => {
    if (running) {
      return;
    }

    running = true;

    try {
      const stats = await recoverSagas({ staleMs });

      if (stats.driven || stats.compensated || stats.expired || stats.errors) {
        console.log("Saga recovery:", stats);
      }
    } catch (error) {
      console.error("Saga recovery run failed:", error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref(); // don't keep the process alive just for this

  return () => clearInterval(timer);
}
