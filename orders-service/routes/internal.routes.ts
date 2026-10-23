import { Router } from "express";

import { prisma } from "../config/prisma.js";
import { applyPaymentSuccess } from "../services/order-saga.js";

const router = Router();

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Used by the Products reconciler to learn what became of a reservation.
 * Always answers 200 with an explicit status string ("NOT_FOUND" when no
 * order carries it), so a wrong URL or a proxy error can't be mistaken
 * for an answer.
 */
router.get("/reservations/:reservationId", async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { reservationId: req.params.reservationId },
      select: { id: true, status: true },
    });

    return res.json({
      status: order?.status ?? "NOT_FOUND",
      orderId: order?.id ?? null,
    });
  } catch (error) {
    console.error("Reservation lookup failed:", error);
    return res.status(500).json({ message: "Unable to look up order" });
  }
});

/**
 * Called by the Payments service once Paystack has verifiably received
 * money for an order.
 *   { reference, amount (minor units), currency }
 *   -> { accepted: true }                  order confirmed (or already was)
 *   -> { accepted: false, reason }         money can't be applied; Payments
 *                                          refunds it
 * Idempotent per reference.
 */
router.post("/orders/:id/payment-succeeded", async (req, res) => {
  const { reference, amount, currency } = req.body ?? {};
  const orderId = String(req.params.id);

  if (
    !UUID_PATTERN.test(orderId) ||
    typeof reference !== "string" ||
    reference.length === 0 ||
    reference.length > 200 ||
    typeof amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    typeof currency !== "string"
  ) {
    return res.status(400).json({
      message: "reference, integer amount and currency are required",
    });
  }

  try {
    return res.json(
      await applyPaymentSuccess(orderId, { reference, amount, currency })
    );
  } catch (error) {
    console.error("Applying payment failed:", error);
    return res.status(500).json({ message: "Unable to apply payment" });
  }
});

export default router;
