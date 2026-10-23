import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SEED_PRODUCTS,
  assertSafeToSeed,
  seedProducts,
  type ProductUpserter,
} from "../scripts/seed-lib.js";

interface FakeProductDoc {
  _id: string;
  name: string;
  price: number;
  stockQuantity: number;
  isActive: boolean;
  reservations: unknown[];
  stockReturns: unknown[];
}

// Just enough of a Mongoose model for an upsert-by-name with
// $set / $setOnInsert, and the schema defaults for a new document.
function fakeProductModel(): ProductUpserter & { docs: FakeProductDoc[] } {
  const docs: FakeProductDoc[] = [];

  return {
    docs,
    async findOneAndUpdate(filter, update, options) {
      assert.equal(options.upsert, true);
      assert.deepEqual(Object.keys(filter), ["name"], "matched by name only");

      let doc = docs.find((candidate) => candidate.name === filter.name);

      if (!doc) {
        doc = {
          _id: `id-${docs.length + 1}`,
          name: filter.name,
          price: 0,
          stockQuantity: 0,
          isActive: true,
          reservations: [],
          stockReturns: [],
          ...(update.$setOnInsert as object),
        };
        docs.push(doc);
      }

      Object.assign(doc, update.$set);
      return doc;
    },
  };
}

test("guard: refuses production, remote databases and a missing URL", () => {
  const local = "mongodb://localhost:27018/products";

  assert.doesNotThrow(() => assertSafeToSeed({ MONGO_URL: local }));
  assert.throws(() => assertSafeToSeed({ MONGO_URL: local, NODE_ENV: "production" }), /production/);
  assert.throws(() => assertSafeToSeed({}), /MONGO_URL/);
  assert.throws(
    () => assertSafeToSeed({ MONGO_URL: "mongodb+srv://u:p@cluster0.abcde.mongodb.net/products" }),
    /non-local/
  );
  assert.doesNotThrow(() =>
    assertSafeToSeed({ MONGO_URL: "mongodb://db.staging.example.com/products", SEED_ALLOW_REMOTE: "true" })
  );
  assert.throws(
    () =>
      assertSafeToSeed({
        MONGO_URL: "mongodb://db.staging.example.com/products",
        SEED_ALLOW_REMOTE: "true",
        NODE_ENV: "production",
      }),
    /production/
  );
});

test("data: names unique, prices in whole cents, stock non-negative integers, includes the edge cases", () => {
  assert.equal(new Set(SEED_PRODUCTS.map((p) => p.name)).size, SEED_PRODUCTS.length);

  for (const product of SEED_PRODUCTS) {
    assert.ok(product.name.length >= 1 && product.name.length <= 200);
    assert.ok(product.price > 0, `${product.name} must be chargeable`);
    assert.ok(
      Math.abs(product.price * 100 - Math.round(product.price * 100)) < 1e-6,
      `${product.name}: price must be whole cents`
    );
    assert.ok(Number.isSafeInteger(product.stockQuantity) && product.stockQuantity >= 0);
  }

  assert.ok(SEED_PRODUCTS.some((p) => p.stockQuantity === 0), "an out-of-stock product");
  assert.ok(SEED_PRODUCTS.some((p) => p.isActive === false), "an inactive product");
  assert.ok(SEED_PRODUCTS.some((p) => p.isActive !== false && p.stockQuantity > 0), "sellable products");
});

function docFor(Product: { docs: FakeProductDoc[] }, name: string): FakeProductDoc {
  const doc = Product.docs.find((candidate) => candidate.name === name);
  assert.ok(doc, `expected a seeded product named ${name}`);
  return doc;
}

test("seeding creates the whole catalogue with the right stock and active flags", async () => {
  const Product = fakeProductModel();

  const result = await seedProducts({ Product });

  assert.equal(result.length, SEED_PRODUCTS.length);
  assert.equal(Product.docs.length, SEED_PRODUCTS.length);

  for (const seeded of SEED_PRODUCTS) {
    const doc = docFor(Product, seeded.name);

    assert.equal(doc.price, seeded.price);
    assert.equal(doc.stockQuantity, seeded.stockQuantity);
    assert.equal(doc.isActive, seeded.isActive ?? true);
  }
});

test("re-running keeps stock (orders placed while testing aren't undone) but refreshes price and status", async () => {
  const Product = fakeProductModel();
  await seedProducts({ Product });

  const mouse = docFor(Product, "Wireless Mouse");
  const ids = Product.docs.map((doc) => doc._id);

  // Some orders were placed, and someone fiddled with the product.
  mouse.stockQuantity = 3;
  mouse.price = 1;
  mouse.isActive = false;

  await seedProducts({ Product });

  assert.equal(Product.docs.length, SEED_PRODUCTS.length, "no duplicates");
  assert.deepEqual(Product.docs.map((doc) => doc._id), ids);
  assert.equal(mouse.stockQuantity, 3, "stock untouched");
  assert.equal(mouse.price, 8500, "price restored");
  assert.equal(mouse.isActive, true, "status restored");
});

test("--reset-stock puts stock back to the sample values", async () => {
  const Product = fakeProductModel();
  await seedProducts({ Product });

  const mouse = docFor(Product, "Wireless Mouse");
  mouse.stockQuantity = 3;

  await seedProducts({ Product, resetStock: true });

  assert.equal(mouse.stockQuantity, 50);
  assert.equal(Product.docs.length, SEED_PRODUCTS.length);
});
