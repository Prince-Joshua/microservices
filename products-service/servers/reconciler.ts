import "dotenv/config";

import { runPart } from "./bootstrap.js";
import { startReservationReconciler } from "../jobs/reservation-reconciler.js";

// Part 3 of 3: the background repair job. It serves no business routes (only /health);
// it asks the Orders service about old reservations and fixes stock to match.
// One copy is plenty, but several are safe (release/finalize are idempotent).
void runPart({
  name: "reconciler",
  defaultPort: 4013,
  requiredEnv: ["INTERNAL_API_TOKEN", "ORDERS_SERVICE_URL"],
  background: () =>
    startReservationReconciler({
      intervalMs: Number(process.env.RECONCILE_INTERVAL_MS) || 60 * 1000,
      olderThanMs: Number(process.env.RECONCILE_OLDER_THAN_MS) || 10 * 60 * 1000,
    }),
});
