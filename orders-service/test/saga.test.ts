import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { installMocks } from "./helpers/fakes.js";
import { must } from "./helpers/must.js";
import type { OrderWithItems, RequestedItem } from "../services/order-saga.js";

const { prisma, products, payments } = installMocks(mock);

const {
  driveCreateSaga,
  applyPaymentSuccess,
  cancelOrder,
  fulfillConfirmedOrder,
  mustLoadOrder: loadOrder,
} = await import("../services/order-saga.js");
const { recoverSagas } = await import("../jobs/saga-recovery.js");
const { toMinorUnits } = await import("../services/money.js");

const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbb";

// Mirrors step 1 of the create saga in the route: persist the intent.
async function newOrder(items: RequestedItem[], key = "key-" + Math.random()) {
  return prisma.order.create({
    data: {
      userId: "user-1",
      reservationId: `user-1:${key}`,
      totalAmount: "0.00",
      status: "PENDING",
      sagaState: "RUNNING",
      requestedItems: [...items].sort((x, y) => x.productId.localeCompare(y.productId)),
    },
  });
}

// A placed order, waiting for payment.
async function placedOrder(items = [{ productId: A, quantity: 3 }]) {
  const result = await driveCreateSaga(await newOrder(items));
  assert.equal(result.outcome, "placed");
  return result.order;
}

// What the Payments service reports after Paystack confirms the money.
async function pay(
  order: OrderWithItems,
  overrides: Partial<{ reference: string; amount: number; currency: string }> = {}
) {
  const current = await loadOrder(order.id);

  return applyPaymentSuccess(order.id, {
    reference: `ref-${order.id}`,
    amount: toMinorUnits(current.totalAmount),
    currency: current.currency,
    ...overrides,
  });
}

const sweep = () => recoverSagas({ staleMs: -1000 }); // treat everything as stale

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

  payments.down = false;
  payments.failRefund = false;
  payments.refunds = [];
  delete process.env.SAGA_MAX_AGE_MS;

  products.add(A, { name: "Widget", price: 10.5, stock: 10 });
  products.add(B, { name: "Gadget", price: 3, stock: 5 });
});

test("money: text amounts convert to minor units without float errors", () => {
  assert.equal(toMinorUnits("24.00"), 2400);
  assert.equal(toMinorUnits("24"), 2400);
  assert.equal(toMinorUnits("0.07"), 7);
  assert.equal(toMinorUnits("19.99"), 1999);
  assert.equal(toMinorUnits("1234567.89"), 123456789);
  assert.throws(() => toMinorUnits("abc"));
  assert.throws(() => toMinorUnits("-1"));
});

test("happy path: reserves, commits with the right total, awaits payment, clears markers", async () => {
  const order = await newOrder([
    { productId: A, quantity: 2 },
    { productId: B, quantity: 1 },
  ]);

  const result = await driveCreateSaga(order);

  assert.equal(result.outcome, "placed");
  assert.equal(result.order.status, "AWAITING_PAYMENT");
  assert.equal(result.order.sagaState, "DONE");
  assert.equal(result.order.totalAmount, "24.00"); // 2 x 10.50 + 1 x 3.00
  assert.equal(result.order.items.length, 2);
  assert.ok(
    must(result.order.paymentDueAt) > new Date(),
    "a payment deadline is set"
  );
  assert.equal(result.order.paidAt, null);
  assert.equal(products.stock(A), 8);
  assert.equal(products.stock(B), 4);
  assert.equal(products.markers(A), 0);
  assert.equal(products.markers(B), 0);
});

test("rejection (out of stock on item 2): rolls back item 1 and marks FAILED", async () => {
  const order = await newOrder([
    { productId: A, quantity: 2 },
    { productId: B, quantity: 99 },
  ]);

  const result = await driveCreateSaga(order);

  assert.equal(result.outcome, "failed");
  assert.equal(result.status, 409);

  const stored = await loadOrder(order.id);
  assert.equal(stored.status, "FAILED");
  assert.equal(stored.sagaState, "DONE");
  assert.equal(stored.failureStatus, 409);
  assert.equal(stored.items.length, 0);
  assert.equal(products.stock(A), 10, "item 1's stock came back");
  assert.equal(products.markers(A), 0);
});

test("unknown product is rejected with 404 and rolled back", async () => {
  const order = await newOrder([
    { productId: A, quantity: 1 },
    { productId: "cccccccccccccccccccccccc", quantity: 1 },
  ]);

  const result = await driveCreateSaga(order);

  assert.equal(result.outcome, "failed");
  assert.equal(result.status, 404);
  assert.equal(products.stock(A), 10);
});

test("a free order is rejected: there is nothing to charge", async () => {
  products.add(A, { price: 0, stock: 10 });

  const result = await driveCreateSaga(await newOrder([{ productId: A, quantity: 1 }]));

  assert.equal(result.outcome, "failed");
  assert.equal(result.status, 422);
  assert.equal(products.stock(A), 10);
});

test("Products outage: saga stays PENDING, the worker finishes it later", async () => {
  products.down = true;
  const order = await newOrder([{ productId: A, quantity: 3 }]);

  const first = await driveCreateSaga(order);

  assert.equal(first.outcome, "retry");
  assert.equal((await loadOrder(order.id)).status, "PENDING");
  assert.equal(products.stock(A), 10);

  products.down = false;
  const stats = await sweep();

  assert.equal(stats.driven, 1);
  assert.equal((await loadOrder(order.id)).status, "AWAITING_PAYMENT");
  assert.equal(products.stock(A), 7);
});

test("outage outlasting SAGA_MAX_AGE_MS rolls back; failed release is retried until it lands", async () => {
  process.env.SAGA_MAX_AGE_MS = "1";

  const order = await newOrder([
    { productId: A, quantity: 2 },
    { productId: B, quantity: 1 },
  ]);

  await new Promise((resolve) => setTimeout(resolve, 5));

  // A reserves fine, then B's service is unreachable, and so is release.
  products.unreachableFor.add(B);
  products.failRelease = true;

  const result = await driveCreateSaga(order);

  assert.equal(result.outcome, "failed");
  assert.equal(result.status, 503);

  let stored = await loadOrder(order.id);
  assert.equal(stored.status, "FAILED");
  assert.equal(stored.sagaState, "COMPENSATING", "compensation still owed");
  assert.equal(products.stock(A), 8, "A is still reserved");

  products.failRelease = false;
  const stats = await sweep();

  assert.equal(stats.compensated, 1);
  stored = await loadOrder(order.id);
  assert.equal(stored.sagaState, "DONE");
  assert.equal(products.stock(A), 10);
  assert.equal(products.markers(A), 0);
});

test("ambiguous commit (transaction commits, caller sees an error): order stands, stock is NOT released", async () => {
  prisma.commitThenThrow = true;
  const order = await newOrder([{ productId: A, quantity: 4 }]);

  const result = await driveCreateSaga(order);

  assert.equal(result.outcome, "placed");
  assert.equal(result.order.status, "AWAITING_PAYMENT");
  assert.equal(products.stock(A), 6, "the sale keeps its decrement");
});

test("ambiguous commit AND unreadable database: stays undecided and releases nothing", async () => {
  const order = await newOrder([{ productId: A, quantity: 4 }]);

  prisma.commitThenThrow = true;

  // Reads start failing as soon as the saga reaches the commit.
  const originalTransaction = prisma.$transaction.bind(prisma);
  prisma.$transaction = async (fn) => {
    try {
      return await originalTransaction(fn);
    } finally {
      prisma.failLoads = true;
    }
  };

  const result = await driveCreateSaga(order);
  prisma.$transaction = originalTransaction;

  assert.equal(result.outcome, "retry");

  prisma.failLoads = false;
  const stored = await loadOrder(order.id);
  assert.equal(stored.status, "AWAITING_PAYMENT", "it did commit");
  assert.equal(products.stock(A), 6, "and its stock was never released");
});

test("two drivers on the same order (request + worker): one commit, stock taken once", async () => {
  const order = await newOrder([
    { productId: A, quantity: 2 },
    { productId: B, quantity: 2 },
  ]);

  const [one, two] = await Promise.all([
    driveCreateSaga(order),
    driveCreateSaga(order),
  ]);

  assert.equal(one.outcome, "placed");
  assert.equal(two.outcome, "placed");
  assert.equal((await loadOrder(order.id)).items.length, 2, "items created once");
  assert.equal(products.stock(A), 8);
  assert.equal(products.stock(B), 3);
  assert.equal(products.markers(A), 0);
});

// ---------------------------------------------------------------- payment

test("payment: a verified payment confirms the order; reporting it again is accepted again", async () => {
  const order = await placedOrder();

  assert.deepEqual(await pay(order), { accepted: true });

  const stored = await loadOrder(order.id);
  assert.equal(stored.status, "CONFIRMED");
  assert.equal(stored.paymentReference, `ref-${order.id}`);
  assert.ok(stored.paidAt instanceof Date);

  assert.deepEqual(await pay(order), { accepted: true }, "idempotent per reference");
  assert.equal((await loadOrder(order.id)).status, "CONFIRMED");
});

test("payment: a second payment attempt for an already paid order is rejected (to be refunded)", async () => {
  const order = await placedOrder();
  await pay(order);

  const second = await pay(order, { reference: "another-attempt" });

  assert.deepEqual(second, { accepted: false, reason: "ALREADY_PAID" });
  assert.equal((await loadOrder(order.id)).paymentReference, `ref-${order.id}`);
});

test("payment: wrong amount, wrong currency and unknown orders are rejected", async () => {
  const order = await placedOrder([{ productId: A, quantity: 2 }]); // 21.00 => 2100

  assert.deepEqual(await pay(order, { amount: 100 }), {
    accepted: false,
    reason: "AMOUNT_MISMATCH",
  });
  assert.deepEqual(await pay(order, { currency: "USD" }), {
    accepted: false,
    reason: "AMOUNT_MISMATCH",
  });
  assert.deepEqual(
    await applyPaymentSuccess("00000000-0000-4000-8000-000000000000", {
      reference: "x",
      amount: 2100,
      currency: "NGN",
    }),
    { accepted: false, reason: "ORDER_NOT_FOUND" }
  );

  assert.equal((await loadOrder(order.id)).status, "AWAITING_PAYMENT", "still unpaid");
});

test("payment arriving after cancellation is rejected; the order stays cancelled", async () => {
  const order = await placedOrder();

  const cancelled = await cancelOrder(order.id);
  assert.equal(cancelled.changed, true);
  assert.equal(products.stock(A), 10);

  assert.deepEqual(await pay(order), { accepted: false, reason: "ORDER_CANCELLED" });
  assert.equal((await loadOrder(order.id)).status, "CANCELLED");
});

test("cancelling an unpaid order returns stock and does not refund anything", async () => {
  const order = await placedOrder();

  const result = await cancelOrder(order.id);

  assert.equal(result.order.status, "CANCELLED");
  assert.equal(result.order.sagaState, "DONE");
  assert.equal(products.stock(A), 10);
  assert.deepEqual(payments.refunds, []);
});

test("cancelling a paid order returns stock once and refunds once", async () => {
  const order = await placedOrder();
  await pay(order);

  const first = await cancelOrder(order.id, { reason: "Changed my mind" });
  assert.equal(first.changed, true);
  assert.equal(first.order.sagaState, "DONE");
  assert.equal(products.stock(A), 10);
  assert.deepEqual(payments.refunds, [{ orderId: order.id, reason: "Changed my mind" }]);

  const second = await cancelOrder(order.id);
  assert.equal(second.changed, false);
  assert.equal(products.stock(A), 10, "no double return");
  assert.equal(payments.refunds.length, 1, "no double refund");
});

test("cancelling a paid order while Payments is down: refund is owed, the worker completes it", async () => {
  const order = await placedOrder();
  await pay(order);

  payments.failRefund = true;
  const cancelled = await cancelOrder(order.id);

  assert.equal(cancelled.order.status, "CANCELLED");
  assert.equal(cancelled.order.sagaState, "COMPENSATING", "refund still owed");
  assert.equal(products.stock(A), 10, "stock was returned regardless");
  assert.deepEqual(payments.refunds, []);

  payments.failRefund = false;
  await sweep();
  await sweep(); // a second sweep must not refund or return again

  assert.equal((await loadOrder(order.id)).sagaState, "DONE");
  assert.equal(payments.refunds.length, 1);
  assert.equal(products.stock(A), 10);
});

test("cancel with Products down: CANCELLED/COMPENSATING, worker returns stock once", async () => {
  const order = await placedOrder();
  await pay(order);

  products.failReturn = true;
  const cancelled = await cancelOrder(order.id);

  assert.equal(cancelled.order.sagaState, "COMPENSATING");
  assert.equal(products.stock(A), 7);

  products.failReturn = false;
  await sweep();
  await sweep();

  assert.equal((await loadOrder(order.id)).sagaState, "DONE");
  assert.equal(products.stock(A), 10);
  assert.equal(payments.refunds.length, 1);
});

test("unpaid orders past their deadline are cancelled by the worker; a late payment is then rejected", async () => {
  const unpaid = await placedOrder([{ productId: A, quantity: 2 }]);
  const stillOpen = await placedOrder([{ productId: B, quantity: 1 }]);
  const paid = await placedOrder([{ productId: A, quantity: 1 }]);
  await pay(paid);

  // Only the first order's deadline has passed.
  prisma.row(unpaid.id).paymentDueAt = new Date(Date.now() - 1000);
  prisma.row(paid.id).paymentDueAt = new Date(Date.now() - 1000);

  const stats = await sweep();

  assert.equal(stats.expired, 1, "the paid order is not touched");

  const expired = await loadOrder(unpaid.id);
  assert.equal(expired.status, "CANCELLED");
  assert.equal(expired.cancelReason, "Payment not received in time");
  assert.equal(expired.sagaState, "DONE");
  assert.equal(products.stock(A), 10 - 1, "only the paid order still holds stock");
  assert.equal((await loadOrder(stillOpen.id)).status, "AWAITING_PAYMENT");
  assert.equal((await loadOrder(paid.id)).status, "CONFIRMED");
  assert.deepEqual(payments.refunds, [], "nothing had been paid, nothing to refund");

  assert.deepEqual(await pay(unpaid), { accepted: false, reason: "ORDER_CANCELLED" });
});

test("fulfillment needs a paid order, and a fulfilled order can no longer be cancelled", async () => {
  const order = await placedOrder([{ productId: A, quantity: 1 }]);

  const unpaid = await fulfillConfirmedOrder(order.id);
  assert.equal(unpaid.changed, false, "can't ship an unpaid order");
  assert.equal(unpaid.order.status, "AWAITING_PAYMENT");

  await pay(order);

  const fulfilled = await fulfillConfirmedOrder(order.id);
  assert.equal(fulfilled.changed, true);
  assert.equal(fulfilled.order.status, "FULFILLED");

  const cancel = await cancelOrder(order.id);
  assert.equal(cancel.changed, false);
  assert.equal(cancel.order.status, "FULFILLED");
  assert.equal(products.stock(A), 9, "stock stays sold");
  assert.deepEqual(payments.refunds, []);
});
