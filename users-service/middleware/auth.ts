import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

import type { AuthUser } from "../types/express.js";
import { isSessionActive } from "../services/refresh-tokens.js";

/**
 * Verifies a Bearer JWT and sets req.user = { id, role }, and rejects the
 * token at once if its session was ended (sign-out, password change,
 * deactivation). A role change ends the user's sessions, so the role in the
 * token is never stale for long.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const [scheme, token] = (req.get("authorization") ?? "").split(" ");

  if (scheme !== "Bearer" || !token) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }

  try {
    const payload = jwt.verify(token, String(process.env.JWT_SECRET), {
      algorithms: ["HS256"],
    });

    if (typeof payload === "string" || !payload.sub) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    // Tokens issued before sessions existed carry no sid and live out their short life.
    if (typeof payload.sid === "string" && !(await isSessionActive(payload.sid))) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    req.user = {
      id: String(payload.sub),
      role: payload.role === "admin" ? "admin" : "customer",
    };

    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    console.error("Authentication failed:", error);
    res.status(503).json({ message: "Unable to verify your session" });
  }
}

/** The authenticated user. Only valid on routes behind requireAuth. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) {
    throw new Error("currentUser() called on a route without requireAuth");
  }

  return req.user;
}

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (req.user?.role !== "admin") {
    res.status(403).json({ message: "Admin access required" });
    return;
  }

  next();
}
