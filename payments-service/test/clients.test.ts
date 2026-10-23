import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http, { type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { PaystackError } from "../errors.js";

// The REAL Paystack and Orders clients, talking over HTTP to a local
// stand-in server that checks the wire format against the documented API.

process.env.PAYSTACK_SECRET_KEY = "sk_test_wire";
process.env.INTERNAL_API_TOKEN = "internal-secret";
process.env.HTTP_TIMEOUT_MS = "500";

const paystack = await import("../clients/paystack.js");
const { notifyPaymentSucceeded } = await import("../clients/orders.client.js");

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: any;
}

interface StubReply {
  status?: number;
  json?: unknown;
  hang?: boolean;
}

let server: http.Server;
let requests: RecordedRequest[];
let respond: (req: IncomingMessage, body: any) => StubReply;

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : undefined;

      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });

      const { status = 200, json, hang } = respond(req, body);

      if (hang) {
        return; // never answer: the client must time out
      }

      res.writeHead(status, { "content-type": "application/json" });
      res.end(json === undefined ? "" : JSON.stringify(json));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.PAYSTACK_BASE_URL = origin;
  process.env.ORDERS_SERVICE_URL = origin;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  requests = [];
  respond = () => ({ status: 200, json: { status: true, data: {} } });
});

test("initialize: documented request shape (string amount, stringified metadata, bearer key)", async () => {
  respond = () => ({
    status: 200,
    json: {
      status: true,
      message: "Authorization URL created",
      data: {
        authorization_url: "https://checkout.paystack.com/abc",
        access_code: "abc",
        reference: "ref-1",
      },
    },
  });

  const session = await paystack.initializeTransaction({
    email: "ada@example.com",
    amount: 2400,
    currency: "NGN",
    reference: "ref-1",
    callbackUrl: "https://shop.example/callback",
    metadata: { orderId: "o1" },
  });

  assert.deepEqual(session, {
    authorizationUrl: "https://checkout.paystack.com/abc",
    accessCode: "abc",
    reference: "ref-1",
  });

  const [request] = requests;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/transaction/initialize");
  assert.equal(request.headers.authorization, "Bearer sk_test_wire");
  assert.equal(request.headers["content-type"], "application/json");
  assert.deepEqual(request.body, {
    email: "ada@example.com",
    amount: "2400",
    currency: "NGN",
    reference: "ref-1",
    callback_url: "https://shop.example/callback",
    metadata: '{"orderId":"o1"}',
  });
});

test("initialize: omits callback_url when none is configured", async () => {
  respond = () => ({
    status: 200,
    json: { status: true, data: { authorization_url: "u", access_code: "a", reference: "r" } },
  });

  await paystack.initializeTransaction({
    email: "a@b.co",
    amount: 100,
    currency: "NGN",
    reference: "r",
  });

  assert.equal("callback_url" in requests[0].body, false);
});

test("verify: GET with an encoded reference; returns the transaction", async () => {
  respond = () => ({
    status: 200,
    json: {
      status: true,
      data: { id: 4099260516, status: "success", amount: 2400, currency: "NGN", reference: "a/b c" },
    },
  });

  const transaction = await paystack.verifyTransaction("a/b c");

  assert.equal(transaction.status, "success");
  assert.equal(transaction.amount, 2400);
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].url, "/transaction/verify/a%2Fb%20c");
});

test("refund: POST /refund with the transaction; list refunds filters by transaction id", async () => {
  respond = (req: IncomingMessage) =>
    req.method === "POST"
      ? { status: 200, json: { status: true, message: "Refund has been queued for processing.", data: { status: "pending" } } }
      : { status: 200, json: { status: true, data: [{ id: 1, status: "processed" }] } };

  await paystack.createRefund({ transaction: "ref-1", merchantNote: "Order cancelled" });
  const refunds = await paystack.listRefunds(4099260516);

  assert.deepEqual(requests[0].body, { transaction: "ref-1", merchant_note: "Order cancelled" });
  assert.equal(requests[1].url, "/refund?transaction=4099260516");
  assert.equal(refunds.length, 1);
});

test("errors: 4xx is a definite answer; 5xx, 429, timeouts and network errors are transient", async () => {
  respond = () => ({ status: 400, json: { status: false, message: "Transaction reference not found" } });
  await assert.rejects(paystack.verifyTransaction("x"), (error: unknown) => {
    assert.ok(error instanceof PaystackError);
    assert.equal(error.transient, false);
    assert.equal(error.httpStatus, 400);
    assert.match(error.message, /not found/);
    return true;
  });

  respond = () => ({ status: 200, json: { status: false, message: "Duplicate Transaction Reference" } });
  await assert.rejects(paystack.verifyTransaction("x"), (error: PaystackError) => error.transient === false);

  for (const status of [500, 502, 503, 429]) {
    respond = () => ({ status, json: { message: "nope" } });
    await assert.rejects(paystack.verifyTransaction("x"), (error: PaystackError) => error.transient === true, `HTTP ${status}`);
  }

  respond = () => ({ hang: true });
  await assert.rejects(paystack.verifyTransaction("x"), (error: PaystackError) => error.transient === true, "timeout");

  const origin = process.env.PAYSTACK_BASE_URL;
  process.env.PAYSTACK_BASE_URL = "http://127.0.0.1:1"; // nothing listening

  try {
    await assert.rejects(paystack.verifyTransaction("x"), (error: PaystackError) => error.transient === true, "refused");
  } finally {
    process.env.PAYSTACK_BASE_URL = origin;
  }
});

test("a malformed success response is an error, not a payment", async () => {
  respond = () => ({ status: 200, json: { status: true, data: { authorization_url: 42 } } });

  await assert.rejects(
    paystack.initializeTransaction({ email: "a@b.co", amount: 1, currency: "NGN", reference: "r" }),
    PaystackError
  );

  respond = () => ({ status: 200, json: { status: true, data: {} } });
  await assert.rejects(paystack.verifyTransaction("r"), PaystackError);
});

test("orders client: sends the internal token, returns accepted/rejected, throws on anything else", async () => {
  const args = { orderId: "o1", reference: "ref-1", amount: 2400, currency: "NGN" };

  respond = () => ({ status: 200, json: { accepted: true } });
  assert.deepEqual(await notifyPaymentSucceeded(args), { accepted: true, reason: undefined });

  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, "/internal/orders/o1/payment-succeeded");
  assert.equal(requests[0].headers["x-internal-token"], "internal-secret");
  assert.deepEqual(requests[0].body, { reference: "ref-1", amount: 2400, currency: "NGN" });

  respond = () => ({ status: 200, json: { accepted: false, reason: "ORDER_CANCELLED" } });
  assert.deepEqual(await notifyPaymentSucceeded(args), { accepted: false, reason: "ORDER_CANCELLED" });

  // None of these is an answer, so none may look like a rejection (= refund).
  for (const reply of [
    { status: 500, json: {} },
    { status: 401, json: { message: "Unauthorized" } },
    { status: 404, json: {} },
    { status: 200, json: { accepted: "no" } },
    { status: 200, json: {} },
    { hang: true },
  ]) {
    respond = () => reply;
    await assert.rejects(notifyPaymentSucceeded(args), Error, JSON.stringify(reply));
  }
});
