import jwt, { type SignOptions } from "jsonwebtoken";

import type { UserRole } from "../models/user.model.js";

/**
 * The short-lived JWT other services verify. It stays short because it can't
 * be revoked; the refresh token (see refresh-tokens.ts) is what keeps a
 * person signed in.
 */
export function signAccessToken(user: { _id: unknown; role: UserRole }): string {
  return jwt.sign({ role: user.role }, String(process.env.JWT_SECRET), {
    algorithm: "HS256",
    subject: String(user._id),
    expiresIn: (process.env.JWT_EXPIRES_IN || "15m") as SignOptions["expiresIn"],
  });
}
