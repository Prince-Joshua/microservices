import { test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";

import { installMocks } from "./helpers/fakes.js";

process.env.PAYSTACK_SECRET_KEY = "sk_test_webhook_secret";
process.env.INTERNAL_API_TOKEN = "internal-secret";

const { prisma, paystack, orders } = installMocks(mock);

const { default: webhookRoutes } = await import("../routes/webhook.routes.js");
const { default: internalRoutes } = await import("../routes/internal.routes.js");
const { internalAuth } = await import("../middleware/internal-auth.js");
const { verifySignature } = await import("../services/signature.js");
const { initiatePayment } = await import("../services/payments.js");

const ORDER = "55555555-5555-4555-8555-555555555555";

let server: Server;
let base: string;

before(async () => {
  const app = express();
  // Same order as server.js: the raw-body webhook route BEFORE express.json().
  app.use("/webhooks", webhookRoutes);
  app.use(express.json());
  app.use("/internal", internalAuth, internalRoutes);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });

  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

beforeEach(() => {
  prisma.rows = [];
  paystack.reset();
  orders.down = false;
  orders.answer = { accepted: true };
  orders.calls = [];
});

const sign = (raw: string | Buffer, secret: string = String(process.env.PAYSTACK_SECRET_KEY)) =>
  createHmac("sha512", secret).update(raw).digest("hex");

async function webhook(
  event: unknown,
  { signature, raw }: { signature?: string | null; raw?: string } = {}
) {
  const body = raw ?? JSON.stringify(event);

  const response = await fetch(`${base}/webhooks/paystack`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature === null ? {} : { "x-paystack-signature": signature ?? sign(body) }),
    },
    body,
  });

  return response.status;
}

async function internal(path: string, body: unknown, token = "internal-secret") {
  const response = await fetch(`${base}/internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": token },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  };
}

const startPayment = () =>
  initiatePayment({
    orderId: ORDER,
    userId: "u1",
    email: "ada@example.com",
    amount: 2400,
    currency: "NGN",
  });

test("signature: valid, wrong key, tampered body, missing and malformed headers", () => {
  const raw = Buffer.from('{"event":"charge.success"}');
  const good = sign(raw);

  assert.equal(verifySignature(raw, good, process.env.PAYSTACK_SECRET_KEY), true);
  assert.equal(verifySignature(raw, sign(raw, "other-key"), process.env.PAYSTACK_SECRET_KEY), false);
  assert.equal(verifySignature(Buffer.from('{"event":"charge.succes"}'), good, process.env.PAYSTACK_SECRET_KEY), false);
  assert.equal(verifySignature(raw, undefined, process.env.PAYSTACK_SECRET_KEY), false);
  assert.equal(verifySignature(raw, "not-hex!", process.env.PAYSTACK_SECRET_KEY), false);
  assert.equal(verifySignature(raw, good.slice(0, 20), process.env.PAYSTACK_SECRET_KEY), false);
  assert.equal(verifySignature(raw, good, ""), false, "no secret configured means nothing verifies");
  assert.equal(verifySignature("a string", good, process.env.PAYSTACK_SECRET_KEY), false);
});

test("webhook: unsigned, wrongly signed and tampered requests are rejected without being processed", async () => {
  const { payment } = await startPayment();
  paystack.pay(payment.reference);

  const event = { event: "charge.success", data: { reference: payment.reference } };
  const body = JSON.stringify(event);

  assert.equal(await webhook(event, { signature: null }), 401);
  assert.equal(await webhook(event, { signature: sign(body, "attacker-key") }), 401);
  assert.equal(await webhook(event, { raw: body + " ", signature: sign(body) }), 401, "body changed after signing");

  assert.equal(prisma.get(payment.reference).status, "PENDING", "nothing was processed");
  assert.equal(orders.calls.length, 0);
});

test("webhook: a signed charge.success settles the payment and tells Orders", async () => {
  const { payment } = await startPayment();
  paystack.pay(payment.reference);

  const status = await webhook({ event: "charge.success", data: { reference: payment.reference } });

  assert.equal(status, 200);
  assert.equal(prisma.get(payment.reference).status, "SUCCESS");
  assert.equal(prisma.get(payment.reference).orderAccepted, true);
  assert.equal(orders.calls.length, 1);

  // Paystack redelivers: still 200, still one notification.
  assert.equal(await webhook({ event: "charge.success", data: { reference: payment.reference } }), 200);
  assert.equal(orders.calls.length, 1);
});

test("webhook: the payload is only a hint; if Paystack says it wasn't paid, nothing is settled", async () => {
  const { payment } = await startPayment();
  // The (validly signed, but wrong or stale) event claims success; Paystack disagrees.

  const status = await webhook({
    event: "charge.success",
    data: { reference: payment.reference, status: "success", amount: 2400 },
  });

  assert.equal(status, 200);
  assert.equal(prisma.get(payment.reference).status, "PENDING");
  assert.equal(orders.calls.length, 0);
});

test("webhook: unknown references and other events are acknowledged and ignored", async () => {
  assert.equal(await webhook({ event: "charge.success", data: { reference: "nope" } }), 200);
  assert.equal(await webhook({ event: "transfer.success", data: {} }), 200);
  assert.equal(await webhook({ event: "charge.success" }), 200);
});

test("webhook: a processing failure answers 500 so Paystack retries", async () => {
  const { payment } = await startPayment();
  paystack.pay(payment.reference);
  paystack.failVerify = true;

  const original = console.error;
  console.error = () => {};

  try {
    assert.equal(
      await webhook({ event: "charge.success", data: { reference: payment.reference } }),
      500
    );
  } finally {
    console.error = original;
  }

  paystack.failVerify = false;
  assert.equal(
    await webhook({ event: "charge.success", data: { reference: payment.reference } }),
    200,
    "the retry succeeds"
  );
  assert.equal(prisma.get(payment.reference).status, "SUCCESS");
});

test("webhook: malformed JSON with a valid signature is a 400", async () => {
  const raw = "{not json";
  assert.equal(await webhook(undefined, { raw, signature: sign(raw) }), 400);
});

test("webhook: refund.processed completes an owed refund; refund.failed flags it for manual handling", async () => {
  const { payment } = await startPayment();
  paystack.pay(payment.reference);
  orders.answer = { accepted: false, reason: "ORDER_CANCELLED" };
  paystack.failRefund = true;

  const original = console.error;
  console.error = () => {};

  try {
    await webhook({ event: "charge.success", data: { reference: payment.reference } });
    assert.equal(prisma.get(payment.reference).refundState, "OWED");

    await webhook({ event: "refund.processed", data: { transaction_reference: payment.reference } });
    assert.equal(prisma.get(payment.reference).refundState, "DONE");

    await webhook({ event: "refund.failed", data: { transaction_reference: payment.reference } });
    assert.equal(prisma.get(payment.reference).refundState, "FAILED");
  } finally {
    console.error = original;
  }
});

test("internal API: requires the shared secret and validates input", async () => {
  const good = {
    orderId: ORDER,
    userId: "u1",
    email: "ada@example.com",
    amount: 2400,
    currency: "NGN",
  };

  assert.equal((await internal("/payments", good, "wrong")).status, 401);
  assert.equal((await internal("/payments", { ...good, email: "nope" })).status, 400);
  assert.equal((await internal("/payments", { ...good, amount: 10.5 })).status, 400);
  assert.equal((await internal("/payments", { ...good, amount: 0 })).status, 400);
  assert.equal((await internal("/payments", { ...good, currency: "ngn" })).status, 400);
  assert.equal((await internal("/payments/refund", {})).status, 400);
  assert.equal((await internal("/payments/verify", {})).status, 400);

  const created = await internal("/payments", good);
  assert.equal(created.status, 200);
  assert.equal(created.body.status, "PENDING");
  assert.match(created.body.payment.authorizationUrl, /checkout\.paystack\.test/);
  assert.equal("email" in created.body.payment, false, "no customer data leaks back");
});

test("internal API: a Paystack outage is a 503, not a verdict", async () => {
  const original = console.error;
  console.error = () => {};

  try {
    paystack.failInit = true;

    const started = await internal("/payments", {
      orderId: ORDER,
      userId: "u1",
      email: "ada@example.com",
      amount: 2400,
      currency: "NGN",
    });

    assert.equal(started.status, 503);

    paystack.failInit = false;
    const { payment } = await startPayment();
    paystack.pay(payment.reference);
    paystack.failVerify = true;

    assert.equal((await internal("/payments/verify", { orderId: ORDER })).status, 503);
  } finally {
    console.error = original;
  }
});
