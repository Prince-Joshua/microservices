import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret";
process.env.INTERNAL_API_TOKEN = "internal-secret";

// Every database call throws. These tests cover only the checks that must
// reject a request BEFORE it can reach the database: authentication,
// authorization and input validation.
const Product = new Proxy(
  {},
  {
    get: (_target, method) => () => {
      throw new Error(`database touched via Product.${String(method)}`);
    },
  }
);

mock.module(new URL("../models/product.model.js", import.meta.url).href, {
  namedExports: { Product },
});

const { default: productsRoutes } = await import("../routes/products.routes.js");
const { default: internalRoutes } = await import("../routes/internal.routes.js");
const { internalAuth } = await import("../middleware/internal-auth.js");

let server: Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/products", productsRoutes);
  app.use("/internal", internalAuth, internalRoutes);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });

  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

const token = (role: string) =>
  jwt.sign({ role }, "test-secret", { subject: "u1", algorithm: "HS256" });

interface CallOptions {
  as?: string;
  body?: unknown;
  internal?: string;
}

async function call(
  method: string,
  path: string,
  { as, body, internal }: CallOptions = {}
) {
  const headers: Record<string, string> = { "content-type": "application/json" };

  if (as) {
    headers.authorization = `Bearer ${token(as)}`;
  }

  if (internal) {
    headers["x-internal-token"] = internal;
  }

  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  return response.status;
}

const GOOD_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";

test("admin-only writes: 401 without a token, 403 for customers", async () => {
  const writes = [
    ["POST", "/products", { name: "x", price: 1 }],
    ["PATCH", `/products/${GOOD_ID}`, { name: "x" }],
    ["POST", `/products/${GOOD_ID}/stock`, { delta: 1 }],
    ["DELETE", `/products/${GOOD_ID}`],
  ];

  for (const [method, path, body] of writes as [string, string, unknown?][]) {
    assert.equal(await call(method, path, { body }), 401, `${method} ${path} anonymous`);
    assert.equal(await call(method, path, { body, as: "customer" }), 403, `${method} ${path} customer`);
  }
});

test("a token signed with another secret or algorithm is rejected", async () => {
  const forged = jwt.sign({ role: "admin" }, "some-other-secret", { subject: "u1" });
  const response = await fetch(`${base}/products`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${forged}` },
    body: JSON.stringify({ name: "x", price: 1 }),
  });

  assert.equal(response.status, 401);
});

test("create validates name, whole-cent price and stock", async () => {
  const bad = [
    {},
    { name: "", price: 1 },
    { name: "x", price: -1 },
    { name: "x", price: 1.999 },
    { name: "x", price: "1" },
    { name: "x", price: 1, stockQuantity: -1 },
    { name: "x", price: 1, stockQuantity: 1.5 },
  ];

  for (const body of bad) {
    assert.equal(await call("POST", "/products", { as: "admin", body }), 400, JSON.stringify(body));
  }
});

test("imageUrl must be an http(s) link, or empty", async () => {
  const badLinks = [
    "javascript:alert(1)",
    "ftp://example.com/a.jpg",
    "data:image/png;base64,AAAA",
    "not a url",
    "https://example.com/" + "a".repeat(2001),
    123,
    null,
  ];

  for (const imageUrl of badLinks) {
    const label = String(imageUrl).slice(0, 40);
    assert.equal(
      await call("POST", "/products", { as: "admin", body: { name: "x", price: 1, imageUrl } }),
      400,
      `create ${label}`
    );
    assert.equal(
      await call("PATCH", `/products/${GOOD_ID}`, { as: "admin", body: { imageUrl } }),
      400,
      `update ${label}`
    );
  }

  // A good link (or an empty one, which clears the image) passes validation and
  // reaches the database, which these tests make throw: a 500, not a 400.
  for (const imageUrl of ["https://example.com/a.jpg", "http://cdn.example.com/b.png?w=300", ""]) {
    assert.equal(
      await call("POST", "/products", { as: "admin", body: { name: "x", price: 1, imageUrl } }),
      500,
      `create ${imageUrl}`
    );
    assert.equal(
      await call("PATCH", `/products/${GOOD_ID}`, { as: "admin", body: { imageUrl } }),
      500,
      `update ${imageUrl}`
    );
  }
});

test("update and stock adjustment validate input and ids", async () => {
  assert.equal(await call("PATCH", `/products/${GOOD_ID}`, { as: "admin", body: {} }), 400);
  assert.equal(await call("PATCH", `/products/${GOOD_ID}`, { as: "admin", body: { isActive: "yes" } }), 400);
  assert.equal(await call("PATCH", "/products/nope", { as: "admin", body: { name: "x" } }), 404);
  assert.equal(await call("POST", `/products/${GOOD_ID}/stock`, { as: "admin", body: { delta: 0 } }), 400);
  assert.equal(await call("POST", `/products/${GOOD_ID}/stock`, { as: "admin", body: { delta: 1.5 } }), 400);
  assert.equal(await call("GET", "/products/nope"), 404);
  assert.equal(await call("DELETE", "/products/nope", { as: "admin" }), 404);
});

test("/internal requires the shared secret", async () => {
  const body = { productId: GOOD_ID, quantity: 1, reservationId: "r1" };

  assert.equal(await call("POST", "/internal/reservations", { body }), 401);
  assert.equal(await call("POST", "/internal/reservations", { body, internal: "wrong" }), 401);
  // A customer JWT is not an internal credential.
  assert.equal(await call("POST", "/internal/reservations", { body, as: "admin" }), 401);
});

test("/internal validates bodies before touching the database", async () => {
  const internal = "internal-secret";
  const cases: [string, object][] = [
    ["/internal/reservations", { productId: "nope", quantity: 1, reservationId: "r" }],
    ["/internal/reservations", { productId: GOOD_ID, quantity: 0, reservationId: "r" }],
    ["/internal/reservations", { productId: GOOD_ID, quantity: 1, reservationId: "" }],
    ["/internal/reservations/release", { productId: GOOD_ID, quantity: 1.5, reservationId: "r" }],
    ["/internal/reservations/finalize", { productId: GOOD_ID }],
    ["/internal/stock/return", { productId: GOOD_ID, quantity: 1 }],
    ["/internal/stock/return", { productId: GOOD_ID, quantity: -1, returnId: "c" }],
  ];

  for (const [path, body] of cases) {
    assert.equal(await call("POST", path, { body, internal }), 400, `${path} ${JSON.stringify(body)}`);
  }
});
