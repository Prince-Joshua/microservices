import { Router } from "express";
import mongoose from "mongoose";

import { User } from "../models/user.model.js";
import { isSessionActive } from "../services/refresh-tokens.js";

const router = Router();

/**
 * Minimal view of a user for other services: whether they may place an
 * order, and the email the payment provider needs for checkout.
 */
router.get("/users/:id", async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ message: "Invalid user ID" });
    return;
  }

  try {
    const user = await User.findById(id).select("_id isActive email").lean();

    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    res.json({
      id: String(user._id),
      isActive: user.isActive,
      email: user.email,
    });
  } catch (error) {
    console.error("User lookup failed:", error);
    res.status(500).json({ message: "Unable to look up user" });
  }
});

/**
 * Is this session (the `sid` in an access token) still alive? Other services
 * ask this to reject a token whose session was ended before it expired.
 */
router.get("/sessions/:sid", async (req, res) => {
  const { sid } = req.params;

  if (!sid || sid.length > 100) {
    res.status(400).json({ message: "Invalid session ID" });
    return;
  }

  try {
    res.json({ active: await isSessionActive(sid) });
  } catch (error) {
    console.error("Session lookup failed:", error);
    res.status(500).json({ message: "Unable to look up session" });
  }
});

export default router;
