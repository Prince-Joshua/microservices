import { Router, type Request, type Response } from "express";
import type { Prisma } from "@prisma/client";

import { prisma } from "../config/prisma.js";
import { OrderError } from "../errors.js";
import { getUser } from "../clients/users.client.js";
import {
  initializePayment,
  verifyPayment,
  type PaymentSession,
} from "../clients/payments.client.js";
import { currentUser, requireAdmin } from "../middleware/auth.js";
import { toMinorUnits } from "../services/money.js";
import {
  type OrderWithItems,
  type RequestedItem,
  type SagaOutcome,
  loadOrder,
  mustLoadOrder,
  driveCreateSaga,
  outcomeFromOrder,
  runCompensation,
  cancelOrder,
  fulfillConfirmedOrder,
} from "../services/order-saga.js";

const router = Router();

const MAX_ITEMS = 50;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER_STATUSES = new Set<string>([
  "PENDING",
  "AWAITING_PAYMENT",
  "CONFIRMED",
  "FULFILLED",
  "CANCELLED",
  "FAILED",
]);

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

/**
 * The shape of an order that leaves this service: internal saga fields
 * are dropped, and item IDs (BigInt in Postgres, which JSON can't
 * serialize) become strings.
 */
function serializeOrder(order: OrderWithItems) {
  const {
    requestedItems,
    sagaState,
    failureStatus,
    reservationId,
    ...visible
  } = order;

  return {
    ...visible,
    items: (order.items ?? []).map((item) => ({
      ...item,
      id: String(item.id),
    })),
  };
}

function sameRequested(stored: unknown, requested: RequestedItem[]): boolean {
  return JSON.stringify(stored ?? null) === JSON.stringify(requested);
}

/**
 * Get the customer a checkout link for an order. Idempotent: Payments
 * hands back the same live session. Resolves to null (never throws) when
 * the link can't be produced right now; the order is safe either way and
 * the customer can ask again with POST /orders/:id/pay.
 */
async function startPayment(order: OrderWithItems): Promise<PaymentSession | null> {
  try {
    const user = await getUser(order.userId);

    if (!user?.email) {
      return null;
    }

    return await initializePayment({
      orderId: order.id,
      userId: order.userId,
      email: user.email,
      amount: toMinorUnits(order.totalAmount),
      currency: order.currency,
    });
  } catch (error) {
    console.error("Could not start payment for order:", order.id, error);
    return null;
  }
}

async function respondForOutcome(
  res: Response,
  result: SagaOutcome,
  { created }: { created: boolean }
) {
  if (result.outcome === "placed") {
    const awaiting = result.order.status === "AWAITING_PAYMENT";
    const body: Record<string, unknown> = {
      message: created
        ? awaiting
          ? "Order created; complete payment to confirm it"
          : "Order created successfully"
        : "Order already created",
      order: serializeOrder(result.order),
    };

    if (awaiting) {
      const started = await startPayment(result.order);

      body.payment = started?.payment ?? null;

      if (!started) {
        body.paymentNote =
          "The payment link couldn't be created right now; call POST /orders/:id/pay";
      }
    }

    return res.status(created ? 201 : 200).json(body);
  }

  if (result.outcome === "failed") {
    return res.status(result.status).json({
      message: result.message,
      orderId: result.order?.id,
    });
  }

  // Undecided: the saga is saved and will finish (or roll back) on its own.
  res.set("Retry-After", "5");

  return res.status(202).json({
    message: "Order is being processed; check its status shortly",
    order: result.order ? serializeOrder(result.order) : undefined,
  });
}

/**
 * Orders: customers see their own; admins see everything. Someone
 * else's order is reported as not found, so IDs can't be probed.
 */
async function findVisibleOrder(
  req: Request,
  res: Response
): Promise<OrderWithItems | null> {
  const id = String(req.params.id);
  const user = currentUser(req);

  if (!UUID_PATTERN.test(id)) {
    res.status(404).json({ message: "Order not found" });
    return null;
  }

  const order = await loadOrder(id);

  if (!order || (user.role !== "admin" && order.userId !== user.id)) {
    res.status(404).json({ message: "Order not found" });
    return null;
  }

  return order;
}

/**
 * POST /orders   { items: [{ productId, quantity }] }
 * Header: Idempotency-Key (required)
 *
 * 201 created (AWAITING_PAYMENT, with a `payment.authorizationUrl` to send
 *     the customer to) | 200 replay | 202 still processing
 * 404/409/... the saga was rolled back (replayed for the same key)
 */
router.post("/", async (req, res) => {
  const userId = String(currentUser(req).id);
  const { items } = req.body ?? {};

  if (!validId(userId) || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({
      message: "A valid customer and at least one item are required",
    });
  }

  if (items.length > MAX_ITEMS) {
    return res.status(400).json({
      message: `An order can contain at most ${MAX_ITEMS} items`,
    });
  }

  for (const item of items) {
    if (
      !validId(item?.productId) ||
      !Number.isSafeInteger(item?.quantity) ||
      item.quantity < 1
    ) {
      return res.status(400).json({
        message: "Every item needs a valid product ID and positive integer quantity",
      });
    }
  }

  // The key is what makes retries safe: the same key always resolves to
  // the same order. Scoped to the user so customers can't collide.
  const idempotencyKey = req.get("Idempotency-Key");

  if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return res.status(400).json({
      message:
        "An Idempotency-Key header is required: 8-128 characters, letters, digits, '-' or '_'",
    });
  }

  // Combine duplicate product IDs, then sort so reservations are always
  // taken in a consistent order.
  const combined = new Map<string, number>();

  for (const item of items) {
    const id = String(item.productId);
    const total = (combined.get(id) || 0) + item.quantity;

    if (!Number.isSafeInteger(total)) {
      return res.status(400).json({ message: "Product quantity is too large" });
    }

    combined.set(id, total);
  }

  const requested = [...combined.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([productId, quantity]) => ({ productId, quantity }));

  const reservationId = `${userId}:${idempotencyKey}`;

  try {
    // A retry of a request we've already seen: resume or replay it.
    const prior = await prisma.order.findUnique({
      where: { reservationId },
      include: { items: true },
    });

    if (prior) {
      return await respondToExisting(res, prior, requested);
    }

    // Validate the customer. Nothing has been written anywhere yet, so
    // failing here leaves no trace.
    const user = await getUser(userId);

    if (!user || !user.isActive) {
      throw new OrderError("Customer not found or inactive", 404);
    }

    // STEP 1: record the intent before touching any other service.
    let order: OrderWithItems;

    try {
      order = await prisma.order.create({
        data: {
          userId,
          reservationId,
          totalAmount: "0.00",
          currency: process.env.PAYMENT_CURRENCY || "NGN",
          status: "PENDING",
          sagaState: "RUNNING",
          requestedItems: requested as unknown as Prisma.InputJsonValue,
        },
        include: { items: true },
      });
    } catch (error) {
      // A concurrent request with the same key won the unique index.
      const winner = await prisma.order.findUnique({
        where: { reservationId },
        include: { items: true },
      });

      if (!winner) {
        throw error;
      }

      return await respondToExisting(res, winner, requested);
    }

    // STEPS 2-4: reserve stock, commit, tidy up (or roll back).
    const result = await driveCreateSaga(order);

    return await respondForOutcome(res, result, { created: true });
  } catch (error) {
    if (error instanceof OrderError) {
      return res.status(error.statusCode).json({ message: error.message });
    }

    console.error("Order creation failed:", error);

    return res.status(500).json({ message: "Unable to create order" });
  }
});

async function respondToExisting(
  res: Response,
  order: OrderWithItems,
  requested: RequestedItem[]
) {
  if (!sameRequested(order.requestedItems, requested)) {
    return res.status(422).json({
      message: "Idempotency-Key was already used with different items",
    });
  }

  if (order.status === "PENDING") {
    // The first request may have died mid-saga; nudge it forward. Safe
    // even if it is still running, because every step is idempotent.
    return respondForOutcome(res, await driveCreateSaga(order), {
      created: false,
    });
  }

  // Already decided (awaiting payment, paid, cancelled or failed): replay it.
  return respondForOutcome(res, outcomeFromOrder(order), { created: false });
}

/**
 * GET /orders?status=&userId=&page=&limit=
 * Customers get their own orders; admins get everyone's (and may filter
 * by userId).
 */
router.get("/", async (req, res) => {
  const user = currentUser(req);
  const page = Math.max(1, Number.parseInt(String(req.query.page), 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(String(req.query.limit), 10) || 20)
  );

  const where: Prisma.OrderWhereInput = {};

  if (user.role === "admin") {
    if (typeof req.query.userId === "string" && req.query.userId) {
      where.userId = req.query.userId;
    }
  } else {
    where.userId = user.id;
  }

  if (req.query.status !== undefined) {
    const status = String(req.query.status);

    if (!ORDER_STATUSES.has(status)) {
      return res.status(400).json({
        message: `status must be one of ${[...ORDER_STATUSES].join(", ")}`,
      });
    }

    where.status = status as OrderWithItems["status"];
  }

  try {
    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: { items: true },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.order.count({ where }),
    ]);

    return res.json({
      data: orders.map(serializeOrder),
      page,
      limit,
      total,
    });
  } catch (error) {
    console.error("Order list failed:", error);
    return res.status(500).json({ message: "Unable to list orders" });
  }
});

/** GET /orders/:id */
router.get("/:id", async (req, res) => {
  try {
    const order = await findVisibleOrder(req, res);

    if (!order) {
      return undefined;
    }

    return res.json({ order: serializeOrder(order) });
  } catch (error) {
    console.error("Order lookup failed:", error);
    return res.status(500).json({ message: "Unable to load order" });
  }
});

/**
 * POST /orders/:id/pay
 * (Re)issues the checkout link for an order that is awaiting payment.
 * Idempotent: the same live checkout session comes back until it is paid.
 */
router.post("/:id/pay", async (req, res) => {
  try {
    const order = await findVisibleOrder(req, res);

    if (!order) {
      return undefined;
    }

    if (order.status === "CONFIRMED" || order.status === "FULFILLED") {
      return res.json({
        message: "Order is already paid",
        order: serializeOrder(order),
      });
    }

    if (order.status !== "AWAITING_PAYMENT") {
      const reasons: Record<string, string> = {
        PENDING: "Order is still being processed",
        CANCELLED: "Order was cancelled",
        FAILED: "Order failed and was never placed",
      };

      return res.status(409).json({ message: reasons[order.status] });
    }

    const started = await startPayment(order);

    if (!started) {
      res.set("Retry-After", "5");

      return res.status(503).json({
        message: "Payments are unavailable right now; please retry shortly",
      });
    }

    return res.json({ order: serializeOrder(order), payment: started.payment });
  } catch (error) {
    console.error("Starting payment failed:", error);
    return res.status(500).json({ message: "Unable to start payment" });
  }
});

/**
 * POST /orders/:id/verify-payment
 * For the page Paystack sends the customer back to: checks with Paystack
 * right now instead of waiting for the webhook, then returns the order.
 */
router.post("/:id/verify-payment", async (req, res) => {
  try {
    const order = await findVisibleOrder(req, res);

    if (!order) {
      return undefined;
    }

    if (order.status === "AWAITING_PAYMENT") {
      try {
        await verifyPayment(order.id);
      } catch (error) {
        console.error("Payment verification failed:", order.id, error);

        res.set("Retry-After", "5");

        return res.status(503).json({
          message: "Couldn't check the payment right now; please retry shortly",
        });
      }
    }

    return res.json({ order: serializeOrder(await mustLoadOrder(order.id)) });
  } catch (error) {
    console.error("Payment verification failed:", error);
    return res.status(500).json({ message: "Unable to verify payment" });
  }
});

/**
 * POST /orders/:id/cancel
 * Cancels an order that is awaiting payment or already paid. Stock goes
 * back, and a paid order is refunded. Idempotent: cancelling an already
 * cancelled order succeeds (and finishes any stock return or refund that
 * was still outstanding).
 */
router.post("/:id/cancel", async (req, res) => {
  try {
    const found = await findVisibleOrder(req, res);

    if (!found) {
      return undefined;
    }

    if (found.status === "CANCELLED") {
      if (found.sagaState === "COMPENSATING") {
        await runCompensation(found);
      }

      return res.json({
        message: "Order cancelled",
        order: serializeOrder(await mustLoadOrder(found.id)),
      });
    }

    if (found.status !== "AWAITING_PAYMENT" && found.status !== "CONFIRMED") {
      const reasons: Record<string, string> = {
        PENDING: "Order is still being processed",
        FULFILLED: "Order has already been fulfilled",
        FAILED: "Order failed and was never placed",
      };

      return res.status(409).json({ message: reasons[found.status] });
    }

    const { changed, order } = await cancelOrder(found.id);

    if (!changed && order.status !== "CANCELLED") {
      // Lost a race with fulfillment.
      return res.status(409).json({
        message: `Order can't be cancelled while ${order.status}`,
      });
    }

    return res.json({
      message: "Order cancelled",
      order: serializeOrder(order),
    });
  } catch (error) {
    console.error("Order cancellation failed:", error);
    return res.status(500).json({ message: "Unable to cancel order" });
  }
});

/**
 * POST /orders/:id/fulfill   (admin)
 * CONFIRMED (paid) -> FULFILLED. After this the order can't be cancelled.
 * This is where a shipping service would plug in.
 */
router.post("/:id/fulfill", requireAdmin, async (req, res) => {
  try {
    const found = await findVisibleOrder(req, res);

    if (!found) {
      return undefined;
    }

    if (found.status === "FULFILLED") {
      return res.json({
        message: "Order already fulfilled",
        order: serializeOrder(found),
      });
    }

    const { changed, order } = await fulfillConfirmedOrder(found.id);

    if (!changed) {
      return res.status(409).json({
        message: `Only paid (confirmed) orders can be fulfilled (this one is ${order.status})`,
      });
    }

    return res.json({
      message: "Order fulfilled",
      order: serializeOrder(order),
    });
  } catch (error) {
    console.error("Order fulfillment failed:", error);
    return res.status(500).json({ message: "Unable to fulfill order" });
  }
});

export default router;
