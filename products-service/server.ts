import "dotenv/config";
import express from "express";
import mongoose from "mongoose";

import { connectDatabase } from "./config/database.js";
import { internalAuth } from "./middleware/internal-auth.js";
import productsRoutes from "./routes/products.routes.js";
import internalRoutes from "./routes/internal.routes.js";
import { startReservationReconciler } from "./jobs/reservation-reconciler.js";

const app = express();

app.use(express.json({ limit: "100kb" }));

app.get("/health", (req, res) => res.json({ status: "ok" }));

// Public catalogue; writes need an admin JWT.
app.use("/products", productsRoutes);

// Only other services call this; it is not meant for the public internet.
app.use("/internal", internalAuth, internalRoutes);

const PORT = process.env.PORT || 4002;

async function startServer() {
  try {
    for (const name of [
      "INTERNAL_API_TOKEN",
      "ORDERS_SERVICE_URL",
      "JWT_SECRET",
    ]) {
      if (!process.env[name]) {
        throw new Error(`Missing ${name}`);
      }
    }

    await connectDatabase();

    const server = app.listen(PORT, () => {
      console.log(`Products service running on port ${PORT}`);
    });

    // Repairs reservations orphaned by crashes or lost responses.
    // Safe to run on every instance: release/finalize are idempotent.
    const stopReconciler = startReservationReconciler({
      intervalMs:
        Number(process.env.RECONCILE_INTERVAL_MS) || 60 * 1000,
      olderThanMs:
        Number(process.env.RECONCILE_OLDER_THAN_MS) || 10 * 60 * 1000,
    });

    const shutdown = () => {
      stopReconciler();
      server.close(async () => {
        await mongoose.disconnect();
        process.exit(0);
      });
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (error) {
    console.error("Startup failed:", error);
    process.exit(1);
  }
}

startServer();
