import { Router } from "express";
import jwt, { type SignOptions } from "jsonwebtoken";

import { User } from "../models/user.model.js";
import {
  hashPassword,
  verifyPassword,
  DUMMY_HASH,
} from "../services/password.js";
import { publicUser } from "../services/public-user.js";

const router = Router();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validPassword(value: unknown): value is string {
  // The upper bound keeps scrypt from being used to burn CPU.
  return typeof value === "string" && value.length >= 8 && value.length <= 128;
}

/**
 * POST /auth/register  { name, email, password }
 * Always creates a customer; admins come from `pnpm run create-admin`.
 */
router.post("/register", async (req, res) => {
  const { name, email, password } = (req.body ?? {}) as Record<string, unknown>;

  if (
    typeof name !== "string" ||
    name.trim().length < 1 ||
    name.trim().length > 100 ||
    typeof email !== "string" ||
    !EMAIL_PATTERN.test(email.trim()) ||
    !validPassword(password)
  ) {
    res.status(400).json({
      message:
        "name (1-100 chars), a valid email and a password of 8-128 characters are required",
    });
    return;
  }

  try {
    const user = await User.create({
      name,
      email,
      passwordHash: await hashPassword(password),
    });

    res.status(201).json(publicUser(user));
  } catch (error) {
    if ((error as { code?: number } | null)?.code === 11000) {
      res.status(409).json({ message: "Email already registered" });
      return;
    }

    console.error("Registration failed:", error);
    res.status(500).json({ message: "Unable to register" });
  }
});

/**
 * POST /auth/login  { email, password }  ->  { token, user }
 */
router.post("/login", async (req, res) => {
  const { email, password } = (req.body ?? {}) as Record<string, unknown>;

  if (typeof email !== "string" || typeof password !== "string") {
    res.status(400).json({ message: "email and password are required" });
    return;
  }

  try {
    const user = await User.findOne({
      email: email.trim().toLowerCase(),
    }).select("+passwordHash");

    const passwordOk = await verifyPassword(
      password,
      user ? user.passwordHash : DUMMY_HASH
    );

    // Same answer for unknown email, wrong password and deactivated
    // account, so the response doesn't reveal which accounts exist.
    if (!user || !passwordOk || !user.isActive) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    const token = jwt.sign({ role: user.role }, String(process.env.JWT_SECRET), {
      algorithm: "HS256",
      subject: String(user._id),
      expiresIn: (process.env.JWT_EXPIRES_IN || "1h") as SignOptions["expiresIn"],
    });

    res.json({ token, user: publicUser(user) });
  } catch (error) {
    console.error("Login failed:", error);
    res.status(500).json({ message: "Unable to log in" });
  }
});

export default router;
