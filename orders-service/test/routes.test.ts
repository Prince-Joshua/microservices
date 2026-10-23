import { test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import jwt from "jsonwebtoken";

import { installMocks } from "./helpers/fakes.js";

process.env.JWT_SECRET = "test-secret";
process.env.INTERNAL_API_TOKEN = "internal-secret";

const { prisma, products, users, payments } = installMocks(mock);

const { authenticate } = await import("../middleware/auth.js");
const { internalAuth } = await import("../middleware/internal-auth.js");
const { default: orderRoutes } = await import("../routes/order.routes.js");
const { default: internalRoutes } = await import("../routes/internal.routes.js");

const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbb";

let server: Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/internal", internalAuth, internalRoutes);
  app.use("/orders", authenticate, orderRoutes);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });

  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

beforeEach(() => {
  prisma.rows = [];
  prisma.items = [];
  prisma.commitThenThrow = false;
  prisma.failLoads = false;

  products.catalog.clear();
  products.down = false;
  products.unreachableFor.clear();
  products.failRelease = false;
  products.failReturn = false;

  users.map.clear();
  users.down = false;

  payments.down = false;
  payments.failRefund = false;
  payments.initialized = [];
  payments.refunds = [];
  payments.verified = [];
  payments.onVerify = null;

  products.add(A, { name: "Widget", price: 10.5, stock: 10 });
  products.add(B, { name: "Gadget", price: 3, stock: 5 });
  users.add("alice");
  users.add("bob");
  users.add("root");
});

const token = (sub: string, role = "customer") =>
  jwt.sign({ role }, String(process.env.JWT_SECRET), { subject: sub, algorithm: "HS256" });

interface CallOptions {
  as?: string | null;
  role?: string;
  key?: string;
  body?: unknown;
  internal?: string;
}

interface Reply {
  status: number;
  headers: Headers;
  body: any;
}

async function call(
  method: string,
  path: string,
  { as = "alice", role, key, body, internal }: CallOptions = {}
): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json" };

  if (as) {
    headers.authorization = `Bearer ${token(as, role)}`;
  }

  if (key) {
    headers["idempotency-key"] = key;
  }

  if (internal) {
    headers["x-internal-token"] = internal;
  }

  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let json: any = null;

  try {
    json = await response.json();
  } catch {
    // empty body
  }

  return { status: response.status, headers: response.headers, body: json };
}

const place = (items: unknown, opts: CallOptions = {}) =>
  call("POST", "/orders", { key: "idem-key-0001", body: { items }, ...opts });

// What the Payments service does when Paystack confirms the money.
const paymentSucceeded = (order: { id: string; totalAmount: string; currency: string }, overrides: Record<string, unknown> = {}) =>
  call("POST", `/internal/orders/${order.id}/payment-succeeded`, {
    as: null,
    internal: "internal-secret",
    body: {
      reference: `ref-${order.id}`,
      amount: Math.round(Number(order.totalAmount) * 100),
      currency: order.currency,
      ...overrides,
    },
  });

async function placeAndPay(items = [{ productId: A, quantity: 3 }], opts = {}) {
  const placed = await place(items, opts);
  assert.equal(placed.status, 201);

  const accepted = await paymentSucceeded(placed.body.order);
  assert.deepEqual(accepted.body, { accepted: true });

  return placed.body.order;
}

test("requires authentication", async () => {
  const response = await call("POST", "/orders", { as: null, body: { items: [] } });
  assert.equal(response.status, 401);
});

test("requires an Idempotency-Key", async () => {
  const response = await call("POST", "/orders", {
    key: undefined,
    body: { items: [{ productId: A, quantity: 1 }] },
  });

  assert.equal(response.status, 400);
  assert.match(response.body.message, /Idempotency-Key/);
});

test("creates an order awaiting payment, with a checkout link; no saga internals leak", async () => {
  const response = await place([
    { productId: A, quantity: 2 },
    { productId: B, quantity: 1 },
  ]);

  assert.equal(response.status, 201);

  const { order, payment } = response.body;
  assert.equal(order.status, "AWAITING_PAYMENT");
  assert.equal(order.totalAmount, "24.00");
  assert.equal(order.currency, "NGN");
  assert.ok(order.paymentDueAt);
  assert.equal(order.items.length, 2);
  assert.equal(typeof order.items[0].id, "string", "BigInt ids are serialized");

  for (const hidden of ["sagaState", "requestedItems", "reservationId", "failureStatus"]) {
    assert.equal(hidden in order, false, `${hidden} must not leak`);
  }

  assert.match(payment.authorizationUrl, /^https:\/\/checkout\.example\//);

  // The charge is the order total in minor units, for the right customer.
  assert.deepEqual(payments.initialized, [
    {
      orderId: order.id,
      userId: "alice",
      email: "alice@example.com",
      amount: 2400,
      currency: "NGN",
    },
  ]);

  assert.equal(products.stock(A), 8, "stock is held while awaiting payment");
});

test("if Payments is down the order still exists and the link can be fetched later", async () => {
  payments.down = true;

  const response = await place([{ productId: A, quantity: 2 }]);

  assert.equal(response.status, 201);
  assert.equal(response.body.order.status, "AWAITING_PAYMENT");
  assert.equal(response.body.payment, null);
  assert.match(response.body.paymentNote, /\/pay/);

  const id = response.body.order.id;

  assert.equal((await call("POST", `/orders/${id}/pay`)).status, 503);

  payments.down = false;
  const retry = await call("POST", `/orders/${id}/pay`);

  assert.equal(retry.status, 200);
  assert.match(retry.body.payment.authorizationUrl, /checkout\.example/);
  assert.equal(prisma.rows.length, 1, "no second order");
});

test("POST /orders/:id/pay: owner only, and only while awaiting payment", async () => {
  const placed = await place([{ productId: A, quantity: 1 }]);
  const id = placed.body.order.id;

  assert.equal((await call("POST", `/orders/${id}/pay`, { as: "bob" })).status, 404);
  assert.equal((await call("POST", `/orders/${id}/pay`)).status, 200);

  await paymentSucceeded(placed.body.order);

  const paid = await call("POST", `/orders/${id}/pay`);
  assert.equal(paid.status, 200);
  assert.match(paid.body.message, /already paid/);

  await call("POST", `/orders/${id}/cancel`);
  assert.equal((await call("POST", `/orders/${id}/pay`)).status, 409);
});

test("merges duplicate product lines", async () => {
  const response = await place([
    { productId: A, quantity: 1 },
    { productId: A, quantity: 2 },
  ]);

  assert.equal(response.status, 201);
  assert.equal(response.body.order.items.length, 1);
  assert.equal(response.body.order.items[0].quantity, 3);
});

test("replaying the same key returns the same order (and its checkout link); stock taken once", async () => {
  const items = [{ productId: A, quantity: 2 }];

  const first = await place(items);
  const second = await place(items);

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.order.id, first.body.order.id);
  assert.equal(second.body.payment.reference, first.body.payment.reference);
  assert.equal(prisma.rows.length, 1);
  assert.equal(products.stock(A), 8);
});

test("concurrent requests with one key create one order", async () => {
  const items = [{ productId: A, quantity: 2 }];

  const results = await Promise.all([place(items), place(items), place(items)]);

  assert.ok(results.every((result) => [200, 201].includes(result.status)));
  assert.equal(new Set(results.map((result) => result.body.order.id)).size, 1);
  assert.equal(prisma.rows.length, 1);
  assert.equal(products.stock(A), 8);
});

test("the same key with different items is rejected (422)", async () => {
  await place([{ productId: A, quantity: 1 }]);
  const response = await place([{ productId: A, quantity: 2 }]);

  assert.equal(response.status, 422);
  assert.equal(products.stock(A), 9);
});

test("a rolled-back order replays its failure for the same key", async () => {
  const items = [{ productId: A, quantity: 999 }];

  const first = await place(items);
  const second = await place(items);

  assert.equal(first.status, 409);
  assert.equal(second.status, 409);
  assert.equal(second.body.message, first.body.message);
  assert.equal(products.stock(A), 10);
  assert.equal(prisma.rows.length, 1);
  assert.equal(payments.initialized.length, 0, "no payment for an order that failed");
});

test("unknown or inactive customer is rejected before anything is written", async () => {
  const response = await place([{ productId: A, quantity: 1 }], { as: "ghost" });

  assert.equal(response.status, 404);
  assert.equal(prisma.rows.length, 0);
  assert.equal(products.stock(A), 10);
});

test("Products outage returns 202; replaying the key later completes the order", async () => {
  products.down = true;
  const items = [{ productId: A, quantity: 2 }];

  const first = await place(items);

  assert.equal(first.status, 202);
  assert.equal(first.headers.get("retry-after"), "5");
  assert.equal(first.body.order.status, "PENDING");
  assert.equal(payments.initialized.length, 0, "no checkout before the order exists");

  products.down = false;
  const second = await place(items);

  assert.equal(second.status, 200);
  assert.equal(second.body.order.status, "AWAITING_PAYMENT");
  assert.equal(second.body.order.id, first.body.order.id);
  assert.ok(second.body.payment.authorizationUrl);
  assert.equal(products.stock(A), 8);
});

test("payment callback: confirms the order, replays safely, and checks the amount", async () => {
  const placed = await place([{ productId: A, quantity: 2 }]); // 21.00
  const order = placed.body.order;

  const wrong = await paymentSucceeded(order, { amount: 100 });
  assert.deepEqual(wrong.body, { accepted: false, reason: "AMOUNT_MISMATCH" });
  assert.equal((await call("GET", `/orders/${order.id}`)).body.order.status, "AWAITING_PAYMENT");

  const right = await paymentSucceeded(order);
  assert.deepEqual(right.body, { accepted: true });

  const replay = await paymentSucceeded(order);
  assert.deepEqual(replay.body, { accepted: true });

  const confirmed = (await call("GET", `/orders/${order.id}`)).body.order;
  assert.equal(confirmed.status, "CONFIRMED");
  assert.ok(confirmed.paidAt);
  assert.equal(confirmed.paymentReference, `ref-${order.id}`);
});

test("payment callback is internal only and validates its input", async () => {
  const placed = await place([{ productId: A, quantity: 1 }]);
  const path = `/internal/orders/${placed.body.order.id}/payment-succeeded`;
  const body = { reference: "r", amount: 1050, currency: "NGN" };

  assert.equal((await call("POST", path, { as: null, body })).status, 401);
  assert.equal((await call("POST", path, { as: null, internal: "wrong", body })).status, 401);
  // A customer's JWT is not an internal credential.
  assert.equal((await call("POST", path, { as: "alice", body })).status, 401);

  const internal = "internal-secret";
  assert.equal((await call("POST", path, { as: null, internal, body: {} })).status, 400);
  assert.equal(
    (await call("POST", path, { as: null, internal, body: { ...body, amount: 10.5 } })).status,
    400
  );
  assert.equal(
    (await call("POST", "/internal/orders/not-a-uuid/payment-succeeded", { as: null, internal, body })).status,
    400
  );
});

test("verify-payment: asks Payments to check now, then returns the updated order", async () => {
  const placed = await place([{ productId: A, quantity: 1 }]);
  const order = placed.body.order;

  payments.onVerify = async () => {
    // Payments finds the money at Paystack and calls Orders back.
    await paymentSucceeded(order);
    return { status: "SUCCESS" };
  };

  const response = await call("POST", `/orders/${order.id}/verify-payment`);

  assert.equal(response.status, 200);
  assert.equal(response.body.order.status, "CONFIRMED");
  assert.deepEqual(payments.verified, [order.id]);

  assert.equal((await call("POST", `/orders/${order.id}/verify-payment`, { as: "bob" })).status, 404);
});

test("verify-payment: unpaid stays AWAITING_PAYMENT; a Payments outage is a 503, not a verdict", async () => {
  const placed = await place([{ productId: A, quantity: 1 }]);
  const id = placed.body.order.id;

  const unpaid = await call("POST", `/orders/${id}/verify-payment`);
  assert.equal(unpaid.status, 200);
  assert.equal(unpaid.body.order.status, "AWAITING_PAYMENT");

  payments.down = true;
  assert.equal((await call("POST", `/orders/${id}/verify-payment`)).status, 503);
});

test("a customer sees only their own orders; admins see everyone's", async () => {
  const alices = await place([{ productId: A, quantity: 1 }]);
  await call("POST", "/orders", {
    as: "bob",
    key: "bobs-key-0001",
    body: { items: [{ productId: B, quantity: 1 }] },
  });

  const id = alices.body.order.id;

  assert.equal((await call("GET", `/orders/${id}`)).status, 200);
  assert.equal((await call("GET", `/orders/${id}`, { as: "bob" })).status, 404);
  assert.equal(
    (await call("GET", `/orders/${id}`, { as: "root", role: "admin" })).status,
    200
  );

  const mine = await call("GET", "/orders");
  assert.equal(mine.body.total, 1);
  assert.equal(mine.body.data[0].userId, "alice");

  const everyone = await call("GET", "/orders", { as: "root", role: "admin" });
  assert.equal(everyone.body.total, 2);

  const awaiting = await call("GET", "/orders?status=AWAITING_PAYMENT");
  assert.equal(awaiting.body.total, 1);

  assert.equal((await call("GET", "/orders?status=NOPE")).status, 400);
  assert.equal((await call("GET", "/orders/not-a-uuid")).status, 404);
});

test("cancelling an unpaid order returns stock with no refund", async () => {
  const placed = await place([{ productId: A, quantity: 3 }]);
  const id = placed.body.order.id;

  assert.equal((await call("POST", `/orders/${id}/cancel`, { as: "bob" })).status, 404);

  const cancelled = await call("POST", `/orders/${id}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.order.status, "CANCELLED");
  assert.equal(products.stock(A), 10);
  assert.deepEqual(payments.refunds, []);

  // The customer pays anyway from the old checkout page: money is turned away.
  const late = await paymentSucceeded(placed.body.order);
  assert.deepEqual(late.body, { accepted: false, reason: "ORDER_CANCELLED" });
});

test("cancelling a paid order returns stock and refunds, once, even if repeated", async () => {
  const order = await placeAndPay([{ productId: A, quantity: 3 }]);

  const cancelled = await call("POST", `/orders/${order.id}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.order.status, "CANCELLED");
  assert.equal(products.stock(A), 10);
  assert.equal(payments.refunds.length, 1);
  assert.equal(payments.refunds[0].orderId, order.id);

  const again = await call("POST", `/orders/${order.id}/cancel`);
  assert.equal(again.status, 200);
  assert.equal(products.stock(A), 10, "stock returned once");
  assert.equal(payments.refunds.length, 1, "refunded once");
});

test("fulfill is admin-only, needs payment, and locks the order against cancellation", async () => {
  const placed = await place([{ productId: A, quantity: 1 }]);
  const id = placed.body.order.id;
  const admin = { as: "root", role: "admin" };

  assert.equal((await call("POST", `/orders/${id}/fulfill`)).status, 403);
  assert.equal((await call("POST", `/orders/${id}/fulfill`, admin)).status, 409, "unpaid");

  await paymentSucceeded(placed.body.order);

  const fulfilled = await call("POST", `/orders/${id}/fulfill`, admin);
  assert.equal(fulfilled.status, 200);
  assert.equal(fulfilled.body.order.status, "FULFILLED");

  const cancel = await call("POST", `/orders/${id}/cancel`);
  assert.equal(cancel.status, 409);
  assert.equal(products.stock(A), 9);
});

test("a failed order can't be cancelled or paid", async () => {
  const failed = await place([{ productId: A, quantity: 999 }]);
  const id = failed.body.orderId;

  assert.ok(id, "failure responses carry the order id");

  assert.equal((await call("POST", `/orders/${id}/cancel`)).status, 409);
  assert.equal((await call("POST", `/orders/${id}/pay`)).status, 409);
});
