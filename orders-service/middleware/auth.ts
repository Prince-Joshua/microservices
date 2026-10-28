import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

import type { AuthUser } from "../types/express.js";
import { isSessionActive } from "../services/session-check.js";

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
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

    // Admin tokens fail closed: if the session can't be confirmed, refuse.
    if (
      typeof payload.sid === "string" &&
      !(await isSessionActive(payload.sid, { strict: payload.role === "admin" }))
    ) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    req.user = {
      id: String(payload.sub),
      role: payload.role === "admin" ? "admin" : "customer",
    };

    next();
  } catch {
    res.status(401).json({ message: "Authentication required" });
  }
}

/** The authenticated user. Only valid on routes behind authenticate. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) {
    throw new Error("currentUser() called on a route without authenticate");
  }

  return req.user;
}

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.user?.role !== "admin") {
    res.status(403).json({ message: "Admin access required" });
    return;
  }

  next();
}
