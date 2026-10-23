import "dotenv/config";
import express from "express";

import { prisma } from "./config/prisma.js";
import { internalAuth } from "./middleware/internal-auth.js";
import webhookRoutes from "./routes/webhook.routes.js";
import internalRoutes from "./routes/internal.routes.js";
import { startPaymentWorker } from "./jobs/payment-worker.js";

const app = express();

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Public (Paystack calls it). Must come BEFORE express.json(): signature
// verification needs the raw, unparsed body.
app.use("/webhooks", webhookRoutes);

app.use(express.json({ limit: "100kb" }));

// Only other services call this; it is not meant for the public internet.
app.use("/internal", internalAuth, internalRoutes);

const PORT = process.env.PORT || 4003;

async function startServer(): Promise<void> {
  try {
    for (const name of [
      "POSTGRES_URL",
      "INTERNAL_API_TOKEN",
      "ORDERS_SERVICE_URL",
      "PAYSTACK_SECRET_KEY",
    ]) {
      if (!process.env[name]) {
        throw new Error(`Missing ${name}`);
      }
    }

    await prisma.$connect();
    console.log("PostgreSQL connected through Prisma");

    const server = app.listen(PORT, () => {
      console.log(`Payments service running on port ${PORT}`);
    });

    // Catches missed webhooks, retries Orders notifications and refunds.
    // Safe to run on every instance: every step is idempotent.
    const stopWorker = startPaymentWorker({
      intervalMs: Number(process.env.WORKER_INTERVAL_MS) || 30 * 1000,
      minAgeMs: Number(process.env.WORKER_MIN_AGE_MS) || 60 * 1000,
      abandonMs: Number(process.env.PAYMENT_ABANDON_MS) || 24 * 60 * 60 * 1000,
    });

    const shutdown = () => {
      stopWorker();
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
