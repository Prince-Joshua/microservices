import { Product } from "../models/product.model.js";
import { getReservationStatus } from "../clients/orders.client.js";
import {
  releaseStock,
  finalizeStockReservation,
} from "../services/stock-reservations.js";

const DEFAULT_OLDER_THAN_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_INTERVAL_MS = 60 * 1000; // 1 minute
const RETURN_LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * One reconciliation pass.
 *
 * For every reservation older than `olderThanMs`, the Orders service is
 * the source of truth:
 *   PENDING                       -> the order saga is still running
 *                                    (or its recovery worker is); skip
 *   AWAITING_PAYMENT/CONFIRMED/
 *   FULFILLED/CANCELLED           -> the order exists, so drop the marker
 *                                    and keep the decrement (stock for an
 *                                    unpaid or cancelled order comes back
 *                                    through /internal/stock/return)
 *   FAILED / NOT_FOUND            -> no sale will ever exist, so give
 *                                    the stock back
 *   Orders can't be reached       -> do nothing and retry next pass
 *
 * `olderThanMs` must comfortably exceed the longest time a request can
 * legitimately sit between reserving stock and committing the order.
 */
export async function reconcileReservations({
  olderThanMs = DEFAULT_OLDER_THAN_MS,
} = {}) {
  const cutoff = new Date(Date.now() - olderThanMs);
  const stats = { finalized: 0, released: 0, skipped: 0, errors: 0 };

  // Reservations written before createdAt existed count as stale.
  const stale = {
    $or: [
      { createdAt: { $lt: cutoff } },
      { createdAt: { $exists: false } },
    ],
  };

  const cursor = Product.find({
    reservations: { $elemMatch: stale },
  })
    .select("_id reservations")
    .lean()
    .cursor();

  for await (const product of cursor) {
    for (const reservation of product.reservations) {
      const isStale =
        !reservation.createdAt || reservation.createdAt < cutoff;

      if (!isStale) {
        continue;
      }

      const { reservationId, quantity } = reservation;

      try {
        const status = await getReservationStatus(reservationId);

        if (status === "PENDING") {
          stats.skipped += 1;
        } else if (
          status === "AWAITING_PAYMENT" ||
          status === "CONFIRMED" ||
          status === "FULFILLED" ||
          status === "CANCELLED"
        ) {
          await finalizeStockReservation(String(product._id), reservationId);
          stats.finalized += 1;
        } else if (
          await releaseStock(String(product._id), quantity, reservationId)
        ) {
          // FAILED or NOT_FOUND
          stats.released += 1;
        }
      } catch (error) {
        // Leave it for the next pass; never skip silently.
        stats.errors += 1;
        console.error(
          "Reservation reconciliation failed:",
          { productId: String(product._id), reservationId },
          error
        );
      }
    }
  }

  // Housekeeping: old return-ledger entries are no longer needed once
  // any cancellation retry window has long passed.
  const ledgerCutoff = new Date(Date.now() - RETURN_LEDGER_RETENTION_MS);

  await Product.updateMany(
    { stockReturns: { $elemMatch: { createdAt: { $lt: ledgerCutoff } } } },
    { $pull: { stockReturns: { createdAt: { $lt: ledgerCutoff } } } }
  );

  return stats;
}

/**
 * Runs the reconciler on an interval, never overlapping itself.
 * Returns a function that stops it.
 */
export function startReservationReconciler({
  intervalMs = DEFAULT_INTERVAL_MS,
  olderThanMs = DEFAULT_OLDER_THAN_MS,
} = {}) {
  let running = false;

  const tick = async () => {
    if (running) {
      return;
    }

    running = true;

    try {
      const stats = await reconcileReservations({ olderThanMs });

      if (stats.finalized || stats.released || stats.errors) {
        console.log("Reservation reconciler:", stats);
      }
    } catch (error) {
      console.error("Reservation reconciler run failed:", error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref(); // don't keep the process alive just for this

  return () => clearInterval(timer);
}
