import mongoose from "mongoose";

/**
 * One row per refresh token handed out. Only a SHA-256 hash of the token is
 * stored, so a leaked database can't be used to sign in.
 *
 * Tokens are rotated on every use. All tokens descended from one login share
 * a familyId (a "session"), which lets us revoke the whole session at once.
 */
export interface IRefreshToken {
  userId: string;
  familyId: string;
  tokenHash: string;
  /** When the login this token descends from happened; caps total session length. */
  sessionStartedAt: Date;
  expiresAt: Date;
  /** Set when the token is used (rotated) or the session is revoked. */
  revokedAt: Date | null;
  createdAt: Date;
}

const refreshTokenSchema = new mongoose.Schema<IRefreshToken>(
  {
    userId: { type: String, required: true, index: true },
    familyId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    sessionStartedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// MongoDB deletes the row once it has expired.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshToken = mongoose.model<IRefreshToken>(
  "RefreshToken",
  refreshTokenSchema
);
