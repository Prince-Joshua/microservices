/**
 * Sample catalogue for local development and testing.
 * Prices are in major units (naira), whole cents only.
 *
 * Two entries exist purely to exercise the order saga's rejection paths:
 * an out-of-stock product (orders for it are rejected with 409) and an
 * inactive one (rejected with 404).
 */
export interface SeedProduct {
  name: string;
  price: number;
  stockQuantity: number;
  isActive?: boolean;
}

export const SEED_PRODUCTS: SeedProduct[] = [
  { name: "Wireless Mouse", price: 8500, stockQuantity: 50 },
  { name: "Mechanical Keyboard", price: 45000, stockQuantity: 25 },
  { name: "USB-C Cable (1m)", price: 2500.5, stockQuantity: 200 },
  { name: "27-inch Monitor", price: 185000, stockQuantity: 8 },
  { name: "Laptop Stand", price: 12999.99, stockQuantity: 40 },
  { name: "Noise-Cancelling Headphones", price: 95000, stockQuantity: 15 },
  {
    name: "Limited Edition Desk Mat (sold out)",
    price: 15000,
    stockQuantity: 0,
  },
  {
    name: "Discontinued Webcam (inactive)",
    price: 22000,
    stockQuantity: 10,
    isActive: false,
  },
];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Throws unless it is clearly safe to write sample data:
 *   - never when NODE_ENV=production
 *   - only against a local database, unless SEED_ALLOW_REMOTE=true
 */
export function assertSafeToSeed(
  env: Record<string, string | undefined> = process.env
): void {
  if (env.NODE_ENV === "production") {
    throw new Error("Refusing to seed: NODE_ENV is production.");
  }

  if (!env.MONGO_URL) {
    throw new Error("Missing MONGO_URL.");
  }

  let host: string | null = null;

  try {
    host = new URL(env.MONGO_URL).hostname;
  } catch {
    // multi-host or unparseable connection strings count as remote
  }

  if (!(host !== null && LOCAL_HOSTS.has(host)) && env.SEED_ALLOW_REMOTE !== "true") {
    throw new Error(
      `Refusing to seed a non-local database (${host ?? "unrecognised host"}). ` +
        "Set SEED_ALLOW_REMOTE=true only if this is a throwaway database."
    );
  }
}

/**
 * Create or refresh the sample catalogue. Safe to run repeatedly:
 * products are matched by name, so nothing is duplicated.
 *
 * Re-running refreshes price and active status but leaves stock alone, so
 * orders placed while testing aren't undone. Pass { resetStock: true } to
 * put stock back to the sample values.
 */
export interface ProductUpserter {
  findOneAndUpdate(
    filter: { name: string },
    update: Record<string, unknown>,
    options: { upsert: true; new: true; setDefaultsOnInsert: true }
  ): Promise<{
    _id: unknown;
    price: number;
    stockQuantity: number;
    isActive: boolean;
  }>;
}

export interface SeededProduct {
  id: string;
  name: string;
  price: number;
  stock: number;
  active: boolean;
}

export async function seedProducts({
  Product,
  resetStock = false,
}: {
  Product: ProductUpserter;
  resetStock?: boolean;
}): Promise<SeededProduct[]> {
  const results: SeededProduct[] = [];

  for (const product of SEED_PRODUCTS) {
    const isActive = product.isActive ?? true;

    const update = {
      $set: {
        price: product.price,
        isActive,
        ...(resetStock ? { stockQuantity: product.stockQuantity } : {}),
      },
      ...(resetStock
        ? {}
        : { $setOnInsert: { stockQuantity: product.stockQuantity } }),
    };

    const doc = await Product.findOneAndUpdate({ name: product.name }, update, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    });

    results.push({
      id: String(doc._id),
      name: product.name,
      price: doc.price,
      stock: doc.stockQuantity,
      active: doc.isActive,
    });
  }

  return results;
}
