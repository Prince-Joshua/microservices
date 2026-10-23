import { Router, type Response } from "express";
import mongoose from "mongoose";

import {
  ReservationError,
  reserveStock,
  releaseStock,
  finalizeStockReservation,
  returnStock,
} from "../services/stock-reservations.js";

const router = Router();

function validReservationId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 200
  );
}

function validProductId(value: unknown): value is string {
  return typeof value === "string" && mongoose.isValidObjectId(value);
}

function validQuantity(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function handleError(res: Response, error: unknown, what: string) {
  if (error instanceof ReservationError) {
    return res.status(error.statusCode).json({ message: error.message });
  }

  console.error(`${what} failed:`, error);
  return res.status(500).json({ message: `Unable to ${what}` });
}

/**
 * Reserve stock. Idempotent per reservationId.
 * 200 -> { productId, name, price }
 * 404 -> product missing or inactive; 409 -> insufficient stock
 */
router.post("/reservations", async (req, res) => {
  const { productId, quantity, reservationId } = req.body ?? {};

  if (
    !validProductId(productId) ||
    !validQuantity(quantity) ||
    !validReservationId(reservationId)
  ) {
    return res.status(400).json({
      message:
        "productId, positive integer quantity and reservationId are required",
    });
  }

  try {
    const product = await reserveStock(productId, quantity, reservationId);

    return res.json({
      productId: String(product._id),
      name: product.name,
      price: product.price,
    });
  } catch (error) {
    return handleError(res, error, "reserve stock");
  }
});

/**
 * Give reserved stock back. Idempotent: { released: false } means there
 * was nothing to release (already released, or never reserved).
 */
router.post("/reservations/release", async (req, res) => {
  const { productId, quantity, reservationId } = req.body ?? {};

  if (
    !validProductId(productId) ||
    !validQuantity(quantity) ||
    !validReservationId(reservationId)
  ) {
    return res.status(400).json({
      message:
        "productId, positive integer quantity and reservationId are required",
    });
  }

  try {
    const released = await releaseStock(productId, quantity, reservationId);
    return res.json({ released });
  } catch (error) {
    return handleError(res, error, "release stock");
  }
});

/**
 * The order committed: drop the marker, keep the stock decrement.
 */
router.post("/reservations/finalize", async (req, res) => {
  const { productId, reservationId } = req.body ?? {};

  if (!validProductId(productId) || !validReservationId(reservationId)) {
    return res.status(400).json({
      message: "productId and reservationId are required",
    });
  }

  try {
    await finalizeStockReservation(productId, reservationId);
    return res.json({ ok: true });
  } catch (error) {
    return handleError(res, error, "finalize reservation");
  }
});

/**
 * A confirmed order was cancelled: put its stock back.
 * Idempotent per returnId: { returned: false } means already applied.
 */
router.post("/stock/return", async (req, res) => {
  const { productId, quantity, returnId } = req.body ?? {};

  if (
    !validProductId(productId) ||
    !validQuantity(quantity) ||
    !validReservationId(returnId)
  ) {
    return res.status(400).json({
      message:
        "productId, positive integer quantity and returnId are required",
    });
  }

  try {
    const returned = await returnStock(productId, quantity, returnId);
    return res.json({ returned });
  } catch (error) {
    return handleError(res, error, "return stock");
  }
});

export default router;
