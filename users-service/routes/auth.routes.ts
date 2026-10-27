import { Router } from "express";
import { User } from "../models/user.model.js";
import {
  hashPassword,
  verifyPassword,
  DUMMY_HASH,
} from "../services/password.js";
import { publicUser } from "../services/public-user.js";
import { signAccessToken } from "../services/access-token.js";
import { limitByIp, tooMany } from "../middleware/rate-limit.js";
import {
  loginByIp,
  loginFailures,
  refreshByIp,
  registerByIp,
} from "../middleware/auth-limits.js";
import {
  issueRefreshToken,
  revokeByToken,
  revokeFamily,
  rotateRefreshToken,
} from "../services/refresh-tokens.js";

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
router.post("/register", limitByIp(registerByIp), async (req, res) => {
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
 * POST /auth/login  { email, password }  ->  { token, refreshToken, user }
 *
 * `token` is a short-lived JWT; `refreshToken` is exchanged at /auth/refresh
 * for a new pair when it expires.
 */
router.post("/login", limitByIp(loginByIp), async (req, res) => {
  const { email, password } = (req.body ?? {}) as Record<string, unknown>;

  if (typeof email !== "string" || typeof password !== "string") {
    res.status(400).json({ message: "email and password are required" });
    return;
  }

  // Counted per email, not per address, so spreading guesses over many IPs
  // doesn't help. Checked before the password is hashed, so a locked account
  // costs no CPU.
  const accountKey = email.trim().toLowerCase().slice(0, 254);
  const locked = loginFailures.check(accountKey);

  if (locked.limited) {
    tooMany(res, locked.retryAfterSec, "Too many failed sign-in attempts.");
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
      loginFailures.hit(accountKey);
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    loginFailures.reset(accountKey);

    const { token: refreshToken } = await issueRefreshToken(String(user._id));

    res.json({
      token: signAccessToken(user),
      refreshToken,
      user: publicUser(user),
    });
  } catch (error) {
    console.error("Login failed:", error);
    res.status(500).json({ message: "Unable to log in" });
  }
});

/**
 * POST /auth/refresh  { refreshToken }  ->  { token, refreshToken, user }
 *
 * The refresh token is single-use: the response carries a replacement, and
 * the old one stops working. The user is re-read, so a deactivation or a new
 * role takes effect here.
 */
router.post("/refresh", limitByIp(refreshByIp), async (req, res) => {
  const { refreshToken } = (req.body ?? {}) as Record<string, unknown>;
  const rejected = { message: "Invalid or expired refresh token" };

  try {
    const result = await rotateRefreshToken(refreshToken);

    if (!result.ok) {
      if (result.reason === "reused") {
        console.warn("Refresh token reuse detected; session revoked");
      }

      res.status(401).json(rejected);
      return;
    }

    const user = await User.findById(result.userId);

    if (!user || !user.isActive) {
      await revokeFamily(result.familyId);
      res.status(401).json(rejected);
      return;
    }

    res.json({
      token: signAccessToken(user),
      refreshToken: result.token,
      user: publicUser(user),
    });
  } catch (error) {
    console.error("Token refresh failed:", error);
    res.status(500).json({ message: "Unable to refresh the session" });
  }
});

/**
 * POST /auth/logout  { refreshToken }  ->  204
 * Revokes the whole session. Always 204 for an unknown token, so it can be
 * called blindly on sign-out.
 */
router.post("/logout", async (req, res) => {
  const { refreshToken } = (req.body ?? {}) as Record<string, unknown>;

  try {
    await revokeByToken(refreshToken);
    res.status(204).end();
  } catch (error) {
    console.error("Logout failed:", error);
    res.status(500).json({ message: "Unable to sign out" });
  }
});

export default router;
