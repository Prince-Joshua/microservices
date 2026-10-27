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
  clearRefreshCookie,
  csrfGuard,
  readRefreshCookie,
  setRefreshCookie,
} from "../services/refresh-cookie.js";
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
 * POST /auth/login  { email, password }  ->  { token, user }
 *
 * `token` is a short-lived JWT. The refresh token is set as an HttpOnly
 * cookie (never in the body) and is exchanged at /auth/refresh for a new
 * pair when the JWT expires.
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

    const { token: refreshToken, expiresAt } = await issueRefreshToken(String(user._id));

    setRefreshCookie(res, refreshToken, expiresAt);
    res.set("Cache-Control", "no-store");
    res.json({
      token: signAccessToken(user),
      user: publicUser(user),
    });
  } catch (error) {
    console.error("Login failed:", error);
    res.status(500).json({ message: "Unable to log in" });
  }
});

/**
 * POST /auth/refresh  (refresh-token cookie)  ->  { token, user }
 *
 * The refresh token is single-use: the response sets a replacement cookie,
 * and the old token stops working. The user is re-read, so a deactivation or
 * a new role takes effect here. Needs the X-Requested-With header and an allowed Origin (CSRF).
 */
router.post("/refresh", limitByIp(refreshByIp), csrfGuard, async (req, res) => {
  const rejected = { message: "Invalid or expired refresh token" };

  try {
    const result = await rotateRefreshToken(readRefreshCookie(req));

    if (!result.ok) {
      if (result.reason === "reused") {
        console.warn("Refresh token reuse detected; session revoked");
      }

      // A "concurrent" loser keeps its cookie: the winner's response is about to replace it.
      if (result.reason !== "concurrent") clearRefreshCookie(res);
      res.status(401).json(rejected);
      return;
    }

    const user = await User.findById(result.userId);

    if (!user || !user.isActive) {
      await revokeFamily(result.familyId);
      clearRefreshCookie(res);
      res.status(401).json(rejected);
      return;
    }

    setRefreshCookie(res, result.token, result.expiresAt);
    res.set("Cache-Control", "no-store");
    res.json({
      token: signAccessToken(user),
      user: publicUser(user),
    });
  } catch (error) {
    console.error("Token refresh failed:", error);
    res.status(500).json({ message: "Unable to refresh the session" });
  }
});

/**
 * POST /auth/logout  (refresh-token cookie)  ->  204
 * Revokes the whole session and clears the cookie. Always 204 for an unknown
 * token, so it can be called blindly on sign-out. Needs X-Requested-With and an allowed Origin.
 */
router.post("/logout", csrfGuard, async (req, res) => {
  try {
    await revokeByToken(readRefreshCookie(req));
    clearRefreshCookie(res);
    res.status(204).end();
  } catch (error) {
    console.error("Logout failed:", error);
    res.status(500).json({ message: "Unable to sign out" });
  }
});

export default router;
