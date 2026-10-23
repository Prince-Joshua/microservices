import "dotenv/config";
import mongoose from "mongoose";

import { Product } from "../models/product.model.js";
import {
  assertSafeToSeed,
  seedProducts,
  type ProductUpserter,
} from "./seed-lib.js";

try {
  assertSafeToSeed();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const resetStock = process.argv.includes("--reset-stock");

try {
  await mongoose.connect(String(process.env.MONGO_URL), {
    serverSelectionTimeoutMS: 5000,
  });

  const products = await seedProducts({
    // The model satisfies ProductUpserter at runtime; Mongoose's overloads are too broad for TS.
    Product: Product as unknown as ProductUpserter,
    resetStock,
  });

  console.log(
    `Seeded ${products.length} products (safe to re-run; ` +
      `${resetStock ? "stock reset to sample values" : "existing stock kept; use --reset-stock to reset it"}):\n`
  );
  console.table(products);
  console.log(
    "\nUse the ids above as productId when placing orders. The sold-out product " +
      "returns 409 and the inactive one 404."
  );
} catch (error) {
  console.error("Seeding failed:", (error as Error).message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
