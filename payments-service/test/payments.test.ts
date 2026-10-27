import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { installMocks } from "./helpers/fakes.js";

const { prisma, paystack, orders } = installMocks(mock);

const {
  initiatePayment,
  verifyAndSettle,
  verifyOrderPayment,
  requestRefund,
  processRefund,
} = await import("../services/payments.js");
const { runPaymentWorker } = await import("../jobs/payment-worker.js");
const { PaymentError } = await import("../errors.js");

/** Narrows away null/undefined, failing the test if the value is missing. */
function must<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined, "expected a value");
  return value;
}

const ORDER = "11111111-1111-4111-8111-111111111111";
const order = (overrides = {}) => ({
  orderId: ORDER,
  userId: "user-1",
  email: "ada@example.com",
  amount: 2400,
  currency: "NGN",
  ...overrides,
});

// Runs the worker as if everything were old enough to be looked at.
const sweep = () => runPaymentWorker({ minAgeMs: -1000, abandonMs: 24 * 60 * 60 * 1000 });

// Silence expected error logs in these tests.
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const original = console.error;
  console.error = () => {};

  try {
    return await fn();
  } finally {
    console.error = original;
  }
};

beforeEach(() => {
  prisma.rows = [];
  paystack.reset();
  orders.down = false;
  orders.answer = { accepted: true };
  orders.calls = [];
});

test("initiate: records the attempt before Paystack, sends minor units, returns the checkout URL", async () => {
  const result = await initiatePayment(order());

  assert.equal(result.status, "PENDING");
  assert.equal(result.payment.reference, `${ORDER}-a1`);
  assert.equal(result.payment.authorizationUrl, `https://checkout.paystack.test/${ORDER}-a1`);
  assert.equal(result.payment.amount, 2400);

  assert.equal(paystack.initCalls.length, 1);
  assert.equal(paystack.initCalls[0].amount, 2400);
  assert.equal(paystack.initCalls[0].email, "ada@example.com");
  assert.deepEqual(paystack.initCalls[0].metadata, { orderId: ORDER, userId: "user-1" });

  const row = prisma.get(`${ORDER}-a1`);
  assert.equal(row.status, "PENDING");
  assert.equal(row.authorizationUrl, result.payment.authorizationUrl);
});

test("initiate: idempotent, so repeating returns the same live checkout without a second Paystack call", async () => {
  const first = await initiatePayment(order());
  const second = await initiatePayment(order());

  assert.equal(second.payment.reference, first.payment.reference);
  assert.equal(paystack.initCalls.length, 1);
  assert.equal(prisma.rows.length, 1);
});

test("initiate: a Paystack outage leaves a retired attempt; the retry uses a fresh reference", async () => {
  paystack.failInit = true;

  await quiet(() =>
    assert.rejects(initiatePayment(order()), (error) => {
      assert.ok(error instanceof PaymentError);
      assert.equal(error.statusCode, 503);
      return true;
    })
  );

  assert.equal(prisma.get(`${ORDER}-a1`).authorizationUrl, null);

  paystack.failInit = false;
  const retry = await initiatePayment(order());

  assert.equal(retry.payment.reference, `${ORDER}-a2`);
  assert.equal(prisma.get(`${ORDER}-a1`).status, "FAILED", "the broken attempt is retired");
  assert.equal(prisma.get(`${ORDER}-a2`).status, "PENDING");
});

test("settle: a verified payment is recorded and Orders is told, once", async () => {
  const { payment } = await initiatePayment(order());
  paystack.pay(payment.reference);

  const settled = must(await verifyAndSettle(payment.reference));

  assert.equal(settled.status, "SUCCESS");
  assert.equal(settled.orderAccepted, true);
  assert.ok(settled.notifiedAt);
  assert.equal(Number(settled.paystackId), must(paystack.transactions.get(payment.reference)).id);
  assert.deepEqual(orders.calls, [
    { orderId: ORDER, reference: payment.reference, amount: 2400, currency: "NGN" },
  ]);
  assert.equal(paystack.refunds.length, 0);

  // A repeated webhook or verify changes nothing and doesn't re-notify.
  await verifyAndSettle(payment.reference);
  assert.equal(orders.calls.length, 1);

  // And a repeated initiate reports the order as already paid.
  assert.equal((await initiatePayment(order())).status, "SUCCESS");
});

test("settle: an unpaid or abandoned transaction stays PENDING; a failed one becomes FAILED", async () => {
  const { payment } = await initiatePayment(order());

  assert.equal(must(await verifyAndSettle(payment.reference)).status, "PENDING");
  assert.equal(orders.calls.length, 0);

  must(paystack.transactions.get(payment.reference)).status = "failed";
  assert.equal(must(await verifyAndSettle(payment.reference)).status, "FAILED");
  assert.equal(orders.calls.length, 0);
});

test("settle: a Paystack outage while verifying is an error, never a verdict", async () => {
  const { payment } = await initiatePayment(order());
  paystack.pay(payment.reference);
  paystack.failVerify = true;

  await assert.rejects(verifyAndSettle(payment.reference));
  assert.equal(prisma.get(payment.reference).status, "PENDING", "nothing was decided");
});

test("settle: a reference Paystack never saw is retired once the attempt had no checkout URL", async () => {
  const row = await prisma.payment.create({
    data: { ...order(), attempt: 1, reference: `${ORDER}-a1` } as never,
  });

  const settled = must(await verifyAndSettle(row.reference));

  assert.equal(settled.status, "FAILED");
});

test("Orders unreachable: the payment is recorded, nothing is refunded, the worker notifies later", async () => {
  const { payment } = await initiatePayment(order());
  paystack.pay(payment.reference);
  orders.down = true;

  const settled = must(await quiet(() => verifyAndSettle(payment.reference)));

  assert.equal(settled.status, "SUCCESS");
  assert.equal(settled.notifiedAt, null);
  assert.equal(settled.refundState, "NONE", "no answer is not a rejection");
  assert.equal(paystack.refunds.length, 0);

  orders.down = false;
  const stats = await sweep();

  assert.equal(stats.notified, 1);
  assert.equal(prisma.get(payment.reference).orderAccepted, true);
  assert.equal(paystack.refunds.length, 0);
});

test("Orders rejects the money (cancelled/expired/duplicate): it is refunded in full", async () => {
  const { payment } = await initiatePayment(order());
  paystack.pay(payment.reference);
  orders.answer = { accepted: false, reason: "ORDER_CANCELLED" };

  const settled = must(await verifyAndSettle(payment.reference));

  assert.equal(settled.status, "SUCCESS");
  assert.equal(settled.orderAccepted, false);
  assert.equal(settled.rejectReason, "ORDER_CANCELLED");
  assert.equal(settled.refundState, "DONE");
  assert.equal(paystack.refunds.length, 1);
  assert.equal(paystack.refunds[0].transaction, payment.reference);
});

test("a late payment on an attempt we had retired is still honoured, and refunded if unwanted", async () => {
  paystack.failInit = true;
  await quiet(() => assert.rejects(initiatePayment(order())));
  paystack.failInit = false;

  // The lost initialize call had in fact reached Paystack, and the customer paid.
  paystack.transactions.set(`${ORDER}-a1`, {
    id: 7,
    status: "success",
    amount: 2400,
    currency: "NGN",
    reference: `${ORDER}-a1`,
  });

  await initiatePayment(order()); // retires attempt 1, creates attempt 2
  assert.equal(prisma.get(`${ORDER}-a1`).status, "FAILED");

  orders.answer = { accepted: false, reason: "ALREADY_PAID" };
  const settled = must(await verifyAndSettle(`${ORDER}-a1`));

  assert.equal(settled.status, "SUCCESS");
  assert.equal(settled.refundState, "DONE");
  assert.equal(paystack.refunds.length, 1);
});

test("amount mismatch: the money is refunded and Orders is never asked to accept it", async () => {
  const { payment } = await initiatePayment(order());
  paystack.pay(payment.reference, { amount: 100 });

  const settled = must(await quiet(() => verifyAndSettle(payment.reference)));

  assert.equal(settled.status, "SUCCESS");
  assert.equal(settled.rejectReason, "AMOUNT_MISMATCH");
  assert.equal(settled.refundState, "DONE");
  assert.equal(orders.calls.length, 0);
  assert.equal(paystack.refunds.length, 1);
});

test("refund outage: stays owed and the worker retries; success is applied once", async () => {
  const { payment } = await initiatePayment(order());
  paystack.pay(payment.reference);
  orders.answer = { accepted: false, reason: "ORDER_CANCELLED" };
  paystack.failRefund = true;

  const settled = must(await quiet(() => verifyAndSettle(payment.reference)));
  assert.equal(settled.refundState, "OWED");
  assert.equal(paystack.refunds.length, 0);

  paystack.failRefund = false;
  const stats = await sweep();

  assert.equal(stats.refunded, 1);
  assert.equal(prisma.get(payment.reference).refundState, "DONE");

  await sweep();
  assert.equal(paystack.refunds.length, 1);
});

test("a refund whose response was lost is not repeated: Paystack's own record is checked first", async () => {
  const { payment } = await initiatePayment(order());
  paystack.pay(payment.reference);
  orders.answer = { accepted: false, reason: "ORDER_CANCELLED" };
  paystack.refundThenThrow = true; // refund is created, but we see an error

  const settled = must(await quiet(() => verifyAndSettle(payment.reference)));
  assert.equal(settled.refundState, "OWED");
  assert.equal(paystack.refunds.length, 1);

  await sweep();

  assert.equal(prisma.get(payment.reference).refundState, "DONE");
  assert.equal(paystack.refunds.length, 1, "no second refund");
});

test("a refund that keeps failing is eventually flagged for manual handling", async () => {
  const { payment } = await initiatePayment(order());
  paystack.pay(payment.reference);
  orders.answer = { accepted: false, reason: "ORDER_CANCELLED" };
  paystack.failRefund = true;

  await quiet(async () => {
    await verifyAndSettle(payment.reference);

    for (let i = 0; i < 12; i += 1) {
      await sweep();
    }
  });

  assert.equal(prisma.get(payment.reference).refundState, "FAILED");
  assert.equal(paystack.refunds.length, 0);
});

test("requestRefund (order cancelled after payment): NOT_PAID, then refunds once, idempotently", async () => {
  assert.deepEqual(await requestRefund(ORDER, "x"), { state: "NOT_PAID" });

  const { payment } = await initiatePayment(order());
  assert.deepEqual(await requestRefund(ORDER, "x"), { state: "NOT_PAID" }, "unpaid yet");

  paystack.pay(payment.reference);
  await verifyAndSettle(payment.reference);

  assert.deepEqual(await requestRefund(ORDER, "Changed my mind"), { state: "DONE" });
  assert.deepEqual(await requestRefund(ORDER, "Changed my mind"), { state: "DONE" });

  assert.equal(paystack.refunds.length, 1);
  assert.equal(prisma.get(payment.reference).refundReason, "Changed my mind");
});

test("requestRefund while Paystack is down is QUEUED, and completes later", async () => {
  const { payment } = await initiatePayment(order());
  paystack.pay(payment.reference);
  await verifyAndSettle(payment.reference);

  paystack.failRefund = true;
  assert.deepEqual(await quiet(() => requestRefund(ORDER, "x")), { state: "QUEUED" });

  paystack.failRefund = false;
  await sweep();

  assert.equal(prisma.get(payment.reference).refundState, "DONE");
  assert.equal(paystack.refunds.length, 1);
});

test("verifyOrderPayment: settles a payment the webhook hasn't delivered yet", async () => {
  assert.deepEqual(await verifyOrderPayment(ORDER), { status: "NONE" });

  const { payment } = await initiatePayment(order());
  assert.deepEqual(await verifyOrderPayment(ORDER), { status: "PENDING" });

  paystack.pay(payment.reference);
  assert.deepEqual(await verifyOrderPayment(ORDER), { status: "SUCCESS" });
  assert.equal(orders.calls.length, 1);
});

test("worker: re-checks old pending payments, leaves fresh ones, abandons very old ones", async () => {
  const paid = await initiatePayment(order({ orderId: "22222222-2222-4222-8222-222222222222" }));
  const open = await initiatePayment(order({ orderId: "33333333-3333-4333-8333-333333333333" }));
  const ancient = await initiatePayment(order({ orderId: "44444444-4444-4444-8444-444444444444" }));

  paystack.pay(paid.payment.reference); // the webhook never arrived
  prisma.get(ancient.payment.reference).createdAt = new Date(Date.now() - 48 * 60 * 60 * 1000);

  // Nothing is old enough yet: the webhook gets first go.
  const fresh = await runPaymentWorker({ minAgeMs: 60 * 1000 });
  assert.equal(fresh.checked, 0);

  const stats = await sweep();

  assert.equal(stats.checked, 3);
  assert.equal(prisma.get(paid.payment.reference).status, "SUCCESS");
  assert.equal(prisma.get(open.payment.reference).status, "PENDING");
  assert.equal(prisma.get(ancient.payment.reference).status, "FAILED");
});

test("two instances refunding the same payment at once: Paystack is asked exactly once", async () => {
  const { payment } = await initiatePayment(order());
  paystack.pay(payment.reference);
  orders.answer = { accepted: false, reason: "ORDER_CANCELLED" };
  paystack.failRefund = true;
  await quiet(() => verifyAndSettle(payment.reference)); // leaves the refund OWED
  paystack.failRefund = false;

  // Both callers read the same row, as two replicas would.
  const snapshot = { ...prisma.get(payment.reference) };
  await Promise.all([processRefund({ ...snapshot }), processRefund({ ...snapshot })]);

  assert.equal(paystack.refunds.length, 1, "one refund, not two");
  assert.equal(prisma.get(payment.reference).refundState, "DONE");
});
