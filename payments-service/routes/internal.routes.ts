import { Router, type Response } from "express";

import { PaymentError } from "../errors.js";
import {
  initiatePayment,
  requestRefund,
  verifyOrderPayment,
} from "../services/payments.js";

const router = Router();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validOrderId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

function handleError(res: Response, error: unknown, what: string) {
  if (error instanceof PaymentError) {
    return res.status(error.statusCode).json({ message: error.message });
  }

  console.error(`${what} failed:`, error);
  return res.status(500).json({ message: `Unable to ${what}` });
}

router.post("/payments", async (req, res) => {
  const { orderId, userId, email, amount, currency } = req.body ?? {};

  if (
    !validOrderId(orderId) ||
    !validOrderId(userId) ||
    typeof email !== "string" ||
    !EMAIL_PATTERN.test(email) ||
    typeof amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    amount < 1 ||
    typeof currency !== "string" ||
    !/^[A-Z]{3}$/.test(currency)
  ) {
    return res.status(400).json({
      message:
        "orderId, userId, a valid email, a positive integer amount (minor units) and a 3-letter currency are required",
    });
  }

  try {
    return res.json(
      await initiatePayment({ orderId, userId, email, amount, currency }),
    );
  } catch (error) {
    return handleError(res, error, "start payment");
  }
});

router.post("/payments/refund", async (req, res) => {
  const { orderId, reason } = req.body ?? {};

  if (!validOrderId(orderId)) {
    return res.status(400).json({ message: "orderId is required" });
  }

  try {
    return res.json(
      await requestRefund(
        orderId,
        typeof reason === "string" ? reason.slice(0, 200) : undefined,
      ),
    );
  } catch (error) {
    return handleError(res, error, "refund payment");
  }
});

router.post("/payments/verify", async (req, res) => {
  const { orderId } = req.body ?? {};

  if (!validOrderId(orderId)) {
    return res.status(400).json({ message: "orderId is required" });
  }

  try {
    return res.json(await verifyOrderPayment(orderId));
  } catch (error) {
    console.error("Payment verification failed:", error);
    return res.status(503).json({ message: "Payment provider is unavailable" });
  }
});

export default router;
