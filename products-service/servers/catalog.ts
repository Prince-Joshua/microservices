import "dotenv/config";

import { runPart } from "./bootstrap.js";
import productsRoutes from "../routes/products.routes.js";

// Part 1 of 3: what shoppers and admins see. Public reads, admin writes.
// Secrets it needs: JWT_SECRET (verifies login tokens) and INTERNAL_API_TOKEN, because admin
// writes are checked against the Users service (USERS_SERVICE_URL), not just the token.
void runPart({
  name: "catalog",
  defaultPort: 4011,
  requiredEnv: ["JWT_SECRET", "INTERNAL_API_TOKEN", "USERS_SERVICE_URL"],
  mount: (app) => {
    app.use("/products", productsRoutes);
  },
});
