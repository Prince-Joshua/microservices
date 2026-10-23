import express, { type Request, type Response } from "express";

import { verifySignature } from "../services/signature.js";
import { handlePaystackEvent, type PaystackEvent } from "../services/payments.js";

const router = express.Router();

/**
 * POST /webhooks/paystack
 *
 * Paystack signs the raw body (HMAC-SHA512 with your secret key), so this
 * route reads the body as raw bytes and must be mounted BEFORE any JSON
 * body parser. An unsigned or wrongly signed request is rejected without
 * being parsed.
 *
 * A 2xx tells Paystack to stop retrying. A processing failure answers 500
 * so Paystack retries (live mode: every 3 minutes, then hourly); the
 * background worker would also catch up, and every step is idempotent.
 */
router.post(
  "/paystack",
  express.raw({ type: () => true, limit: "200kb" }),
  async (req: Request, res: Response) => {
    if (
      !verifySignature(
        req.body,
        req.get("x-paystack-signature"),
        process.env.PAYSTACK_SECRET_KEY
      )
    ) {
      return res.status(401).json({ message: "Invalid signature" });
    }

    let event: PaystackEvent;

    try {
      event = JSON.parse((req.body as Buffer).toString("utf8"));
    } catch {
      return res.status(400).json({ message: "Invalid JSON" });
    }

    try {
      await handlePaystackEvent(event);
      return res.sendStatus(200);
    } catch (error) {
      console.error("Webhook processing failed:", event?.event, error);
      return res.sendStatus(500);
    }
  }
);

export default router;
