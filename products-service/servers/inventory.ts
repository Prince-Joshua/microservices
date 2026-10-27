import "dotenv/config";

import { runPart } from "./bootstrap.js";
import { internalAuth } from "../middleware/internal-auth.js";
import internalRoutes from "../routes/internal.routes.js";

// Part 2 of 3: stock reservations for the Orders saga (the checkout hot path).
// Only other services call it. Secrets it needs: INTERNAL_API_TOKEN. It does NOT get JWT_SECRET.
void runPart({
  name: "inventory",
  defaultPort: 4012,
  requiredEnv: ["INTERNAL_API_TOKEN"],
  mount: (app) => {
    app.use("/internal", internalAuth, internalRoutes);
  },
});
