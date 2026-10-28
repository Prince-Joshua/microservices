import { Router } from "express";
import { User } from "../models/user.model.js";
import {
  hashPassword,
  verifyPassword,
  DUMMY_HASH,
} from "../services/password.js";
import { publicUser } from "../services/public-user.js";
import { signAccessToken } from "../services/access-token.js";
import {
  clientIp,
  limitByIp,
  limits,
  tooManyRequests,
} from "../services/rate-limit.js";
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
 *
 * `token` is a short-lived JWT. The refresh token is set as an HttpOnly
 * cookie (never in the body) and is exchanged at /auth/refresh for a new
 * pair when the JWT expires.
 *
 * Rate limited: per address, and per account (failures only), so passwords
 * can't be guessed quickly. The 429 is the same for accounts that exist and
 * ones that don't.
 */
router.post("/login", limitByIp(limits.loginPerIp, "login"), async (req, res) => {
  const { email, password } = (req.body ?? {}) as Record<string, unknown>;

  if (typeof email !== "string" || typeof password !== "string") {
    res.status(400).json({ message: "email and password are required" });
    return;
  }

  // Keys are bounded so a flood of long or random emails can't fill memory.
  const account = email.trim().toLowerCase().slice(0, 254);
  const accountAtIp = `${account}|${clientIp(req)}`;

  // Refuse before touching the database or hashing a password.
  const lockedHere = limits.loginFailsPerAccountIp.isBlocked(accountAtIp);
  const lockedAnywhere = limits.loginFailsPerAccount.isBlocked(account);

  if (lockedHere.blocked || lockedAnywhere.blocked) {
    console.warn(`Login blocked after repeated failures ip=${clientIp(req)}`);
    tooManyRequests(res, Math.max(lockedHere.retryAfterSec, lockedAnywhere.retryAfterSec));
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
      limits.loginFailsPerAccountIp.hit(accountAtIp);
      limits.loginFailsPerAccount.hit(account);
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    // A correct password clears this address's failures. The all-addresses counter is
    // left to expire on its own, so a guesser can't wipe it by logging in elsewhere.
    limits.loginFailsPerAccountIp.reset(accountAtIp);

    const {
      token: refreshToken,
      familyId,
      expiresAt,
    } = await issueRefreshToken(String(user._id));

    setRefreshCookie(res, refreshToken, expiresAt);
    res.set("Cache-Control", "no-store");
    res.json({
      token: signAccessToken(user, familyId),
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
 * a new role takes effect here. Needs the X-Requested-With header and an
 * allowed Origin (CSRF).
 *
 * Rate limited per address, with a tighter limit on tokens that don't work.
 * A visitor with no cookie at all (not signed in) is refused without counting
 * as a bad token, so loading the page anonymously can't lock an address out.
 */
router.post(
  "/refresh",
  limitByIp(limits.refreshPerIp, "refresh"),
  csrfGuard,
  async (req, res) => {
  const refreshToken = readRefreshCookie(req);
  const rejected = { message: "Invalid or expired refresh token" };
  const ip = clientIp(req);

  const locked = limits.refreshFailsPerIp.isBlocked(ip);

  if (locked.blocked) {
    console.warn(`Refresh blocked after repeated failures ip=${ip}`);
    tooManyRequests(res, locked.retryAfterSec);
    return;
  }

  try {
    if (refreshToken === undefined) {
      res.status(401).json(rejected);
      return;
    }

    const result = await rotateRefreshToken(refreshToken);

    if (!result.ok) {
      // Two tabs racing is normal; only count tokens that really are wrong or reused.
      if (result.reason !== "concurrent") {
        limits.refreshFailsPerIp.hit(ip);
        clearRefreshCookie(res);
      }

      if (result.reason === "reused") {
        console.warn("Refresh token reuse detected; session revoked");
      }

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
      token: signAccessToken(user, result.familyId),
      user: publicUser(user),
    });
  } catch (error) {
    console.error("Token refresh failed:", error);
    res.status(500).json({ message: "Unable to refresh the session" });
  }
  }
);

/**
 * POST /auth/logout  (refresh-token cookie)  ->  204
 * Revokes the whole session and clears the cookie. Always 204 for an unknown
 * token, so it can be called blindly on sign-out. Needs X-Requested-With and
 * an allowed Origin.
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
