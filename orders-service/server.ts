import "dotenv/config";
import express from "express";

import { prisma } from "./config/prisma.js";
import { authenticate } from "./middleware/auth.js";
import { internalAuth } from "./middleware/internal-auth.js";
import orderRoutes from "./routes/order.routes.js";
import internalRoutes from "./routes/internal.routes.js";
import { startSagaRecovery } from "./jobs/saga-recovery.js";

const app = express();

app.use(express.json({ limit: "100kb" }));

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Called by other services (the Products reconciler); not for customers.
app.use("/internal", internalAuth, internalRoutes);

// Customer-facing. authenticate sets req.user = { id, role }.
app.use("/orders", authenticate, orderRoutes);

const PORT = process.env.PORT || 4000;

async function startServer(): Promise<void> {
  try {
    for (const name of [
      "POSTGRES_URL",
      "JWT_SECRET",
      "INTERNAL_API_TOKEN",
      "USERS_SERVICE_URL",
      "PRODUCTS_SERVICE_URL",
      "PAYMENTS_SERVICE_URL",
    ]) {
      if (!process.env[name]) {
        throw new Error(`Missing ${name}`);
      }
    }

    await prisma.$connect();
    console.log("PostgreSQL connected through Prisma");

    const server = app.listen(PORT, () => {
      console.log(`Orders service running on port ${PORT}`);
    });

    // Finishes or rolls back sagas that a crash or outage left half-done.
    // Safe to run on every instance: every step is idempotent and every
    // state change is a conditional update.
    const stopRecovery = startSagaRecovery({
      intervalMs: Number(process.env.SAGA_RECOVERY_INTERVAL_MS) || 15 * 1000,
      staleMs: Number(process.env.SAGA_STALE_MS) || 30 * 1000,
    });

    const shutdown = () => {
      stopRecovery();
      server.close(async () => {
        await prisma.$disconnect();
        process.exit(0);
      });
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (error) {
    console.error("Startup failed:", error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

startServer();
