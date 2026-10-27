import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

import { getUserStatus } from "../services/user-status.js";
import type { AuthUser } from "../types/express.js";

/** What the token claims. Proves who is calling, nothing more. */
function readClaims(req: Request): AuthUser | null {
  const [scheme, token] = (req.get("authorization") ?? "").split(" ");

  if (scheme !== "Bearer" || !token) {
    return null;
  }

  try {
    const payload = jwt.verify(token, String(process.env.JWT_SECRET), {
      algorithms: ["HS256"],
    });

    if (typeof payload === "string" || !payload.sub) {
      return null;
    }

    return {
      id: String(payload.sub),
      role: payload.role === "admin" ? "admin" : "customer",
    };
  } catch {
    return null;
  }
}

/**
 * Sets req.user when a valid token is present; never rejects.
 *
 * Only an admin changes what the catalogue shows (inactive products), so only
 * a token that claims admin is checked with the Users service. Everyone else
 * browses without that extra call. If the check can't be made, the caller is
 * treated as an anonymous shopper.
 */
export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const claims = readClaims(req);

  delete req.user;

  if (claims?.role !== "admin") {
    if (claims) {
      req.user = claims;
    }

    next();
    return;
  }

  try {
    const account = await getUserStatus(claims.id);

    if (account?.isActive) {
      req.user = { id: claims.id, role: account.role };
    }
  } catch (error) {
    console.error("Account check failed:", error);
  }

  next();
}

/**
 * Admin-only routes. The role and the active flag come from the Users
 * service, not from the token, so a deactivated or demoted admin loses access
 * within seconds. If the Users service can't be reached the request is
 * refused (503), never waved through.
 */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const claims = readClaims(req);

  if (!claims) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }

  try {
    const account = await getUserStatus(claims.id);

    if (!account || !account.isActive) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    if (account.role !== "admin") {
      res.status(403).json({ message: "Admin access required" });
      return;
    }

    req.user = { id: claims.id, role: "admin" };
    next();
  } catch (error) {
    console.error("Account check failed:", error);
    res.status(503).json({ message: "Unable to verify your account right now" });
  }
}
