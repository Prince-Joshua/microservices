import "dotenv/config";
import express from "express";

import {
  installOutboundTracing,
  installStructuredLogging,
  requestContext,
} from "./middleware/observability.js";
import mongoose from "mongoose";

import { connectDatabase } from "./config/database.js";
import { internalAuth } from "./middleware/internal-auth.js";
import { User } from "./models/user.model.js";
import authRoutes from "./routes/auth.routes.js";
import usersRoutes from "./routes/users.routes.js";
import internalRoutes from "./routes/internal.routes.js";

// JSON logs, request ids on every log line and on calls to the other services.
installStructuredLogging("users");
installOutboundTracing([
  process.env.USERS_SERVICE_URL,
  process.env.PRODUCTS_SERVICE_URL,
  process.env.ORDERS_SERVICE_URL,
  process.env.PAYMENTS_SERVICE_URL,
]);

const app = express();

app.use(requestContext());

app.use(express.json({ limit: "100kb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Public
app.use("/auth", authRoutes);

// Authenticated (JWT); some routes are admin-only
app.use("/users", usersRoutes);

// Only other services call this; it is not meant for the public internet.
app.use("/internal", internalAuth, internalRoutes);

const PORT = process.env.PORT || 4001;

async function startServer(): Promise<void> {
  try {
    for (const name of ["INTERNAL_API_TOKEN", "JWT_SECRET"]) {
      if (!process.env[name]) {
        throw new Error(`Missing ${name}`);
      }
    }

    await connectDatabase();

    // Build the unique email index before taking traffic.
    await User.init();

    const server = app.listen(PORT, () => {
      console.log(`Users service running on port ${PORT}`);
    });

    const shutdown = (): void => {
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

void startServer();
