import jwt, { type SignOptions } from "jsonwebtoken";

import type { UserRole } from "../models/user.model.js";

/**
 * The short-lived JWT other services verify. `sid` names the session it
 * belongs to, which is how a token can be revoked before it expires: when the
 * session is ended, services that ask the users service stop accepting it.
 * It stays short anyway, as a safety net.
 */
export function signAccessToken(
  user: { _id: unknown; role: UserRole },
  sessionId: string
): string {
  return jwt.sign({ role: user.role, sid: sessionId }, String(process.env.JWT_SECRET), {
    algorithm: "HS256",
    subject: String(user._id),
    expiresIn: (process.env.JWT_EXPIRES_IN || "15m") as SignOptions["expiresIn"],
  });
}
