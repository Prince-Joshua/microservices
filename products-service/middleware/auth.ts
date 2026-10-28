import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

import type { AuthUser } from "../types/express.js";
import { isSessionActive } from "../services/session-check.js";

/**
 * The user behind a valid token, or null. A token whose session was ended
 * (sign-out, password change, deactivation) counts as no token at all.
 */
async function readUser(req: Request): Promise<AuthUser | null> {
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

    // Tokens issued before sessions existed carry no sid and live out their short life.
    if (typeof payload.sid === "string" && !(await isSessionActive(payload.sid))) {
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

/** Sets req.user when a valid token is present; never rejects. */
export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const user = await readUser(req);

  if (user) {
    req.user = user;
  } else {
    delete req.user;
  }

  next();
}

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const user = await readUser(req);

  if (!user) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }

  if (user.role !== "admin") {
    res.status(403).json({ message: "Admin access required" });
    return;
  }

  req.user = user;
  next();
}
