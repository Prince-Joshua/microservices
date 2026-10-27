import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

import { User } from "../models/user.model.js";
import type { AuthUser } from "../types/express.js";

/**
 * Verifies a Bearer JWT, then loads the account, so a deactivation or a role
 * change applies on the very next request. The token only proves who is
 * calling; `isActive` and `role` always come from the database.
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

  let id: string;

  try {
    const payload = jwt.verify(token, String(process.env.JWT_SECRET), {
      algorithms: ["HS256"],
    });

    if (typeof payload === "string" || !payload.sub) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    id = String(payload.sub);
  } catch {
    res.status(401).json({ message: "Authentication required" });
    return;
  }

  if (!mongoose.isValidObjectId(id)) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }

  try {
    const user = await User.findById(id).select("role isActive").lean();

    if (!user || !user.isActive) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    req.user = { id, role: user.role === "admin" ? "admin" : "customer" };
    next();
  } catch (error) {
    console.error("Account check failed:", error);
    res.status(503).json({ message: "Unable to verify your account right now" });
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
