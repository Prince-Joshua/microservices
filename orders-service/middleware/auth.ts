import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

import { OrderError } from "../errors.js";
import { getUserStatus } from "../services/user-status.js";
import type { AuthUser } from "../types/express.js";

/**
 * Verifies a Bearer JWT (issued by the users service), then asks the Users
 * service whether the account is still active and what its role is now, so a
 * deactivation or a role change applies within seconds instead of when the
 * 15-minute token expires. The token only proves who is calling: `role`
 * always comes from the Users service. If it can't be reached the request is
 * refused (503), never waved through.
 */
export async function authenticate(
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

  try {
    const account = await getUserStatus(id);

    if (!account || !account.isActive) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    req.user = { id, role: account.role === "admin" ? "admin" : "customer" };
    next();
  } catch (error) {
    if (!(error instanceof OrderError)) {
      console.error("Account check failed:", error);
    }

    res.status(503).json({ message: "Unable to verify your account right now" });
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
  next: NextFunction
): void {
  if (req.user?.role !== "admin") {
    res.status(403).json({ message: "Admin access required" });
    return;
  }

  next();
}
