import express, { type Express } from "express";
import mongoose from "mongoose";

import { connectDatabase } from "../config/database.js";
import {
  installOutboundTracing,
  installStructuredLogging,
  requestContext,
} from "../middleware/observability.js";

/**
 * Shared start-up for the three deployable parts of the products service
 * (catalog, inventory, reconciler). All three use the SAME MongoDB database and
 * the same Product model; they differ only in which routes/jobs they run and
 * which secrets they need. `server.ts` is still the all-in-one version.
 */
export interface PartOptions {
  /** Shows up in logs as "products-<name>". */
  name: string;
  defaultPort: number;
  /** Environment variables this part cannot run without. */
  requiredEnv: string[];
  /** Attach this part's routes. */
  mount?: (app: Express) => void;
  /** Start background work; return a function that stops it. */
  background?: () => () => void;
}

export async function runPart(options: PartOptions): Promise<void> {
  installStructuredLogging(`products-${options.name}`);
  installOutboundTracing([
    process.env.USERS_SERVICE_URL,
    process.env.PRODUCTS_SERVICE_URL,
    process.env.ORDERS_SERVICE_URL,
    process.env.PAYMENTS_SERVICE_URL,
  ]);

  const app = express();

  app.use(requestContext());
  app.use(express.json({ limit: "100kb" }));
  app.get("/health", (_req, res) => res.json({ status: "ok", part: options.name }));

  options.mount?.(app);

  const port = process.env.PORT || options.defaultPort;

  try {
    for (const name of ["MONGO_URL", ...options.requiredEnv]) {
      if (!process.env[name]) {
        throw new Error(`Missing ${name}`);
      }
    }

    await connectDatabase();

    const server = app.listen(port, () => {
      console.log(`Products ${options.name} running on port ${port}`);
    });

    const stopBackground = options.background?.();

    const shutdown = (): void => {
      stopBackground?.();
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
