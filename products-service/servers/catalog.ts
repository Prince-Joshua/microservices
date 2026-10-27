import "dotenv/config";

import { runPart } from "./bootstrap.js";
import productsRoutes from "../routes/products.routes.js";

// Part 1 of 3: what shoppers and admins see. Public reads, admin writes.
// Secrets it needs: JWT_SECRET (verifies login tokens). It does NOT get INTERNAL_API_TOKEN.
void runPart({
  name: "catalog",
  defaultPort: 4011,
  requiredEnv: ["JWT_SECRET"],
  mount: (app) => {
    app.use("/products", productsRoutes);
  },
});
