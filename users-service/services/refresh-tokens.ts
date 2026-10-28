import { createHash, randomBytes, randomUUID } from "node:crypto";

import { RefreshToken } from "../models/refresh-token.model.js";

const DAY_MS = 86_400_000;

function positiveNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** How long one refresh token lasts without being used. */
const ttlMs = () => positiveNumber(process.env.REFRESH_TOKEN_TTL_DAYS, 30) * DAY_MS;

/** Hard limit on a session, however often it refreshes. */
const maxSessionMs = () =>
  positiveNumber(process.env.REFRESH_MAX_SESSION_DAYS, 90) * DAY_MS;

/**
 * Two tabs can refresh with the same token at nearly the same moment. The
 * loser presents a token that was rotated a moment ago; within this window
 * that is treated as a harmless race, not as theft.
 */
const graceMs = () => positiveNumber(process.env.REFRESH_REUSE_GRACE_MS, 10_000);

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function plausible(token: unknown): token is string {
  return typeof token === "string" && token.length > 0 && token.length <= 200;
}

export interface Session {
  familyId: string;
  sessionStartedAt: Date;
}

/** Create and store a new refresh token; returns the plain token (shown once). */
export async function issueRefreshToken(
  userId: string,
  session?: Session
): Promise<{ token: string; familyId: string }> {
  const now = Date.now();
  const familyId = session?.familyId ?? randomUUID();
  const sessionStartedAt = session?.sessionStartedAt ?? new Date(now);
  const expiresAt = new Date(
    Math.min(now + ttlMs(), sessionStartedAt.getTime() + maxSessionMs())
  );
  const token = randomBytes(32).toString("base64url");

  await RefreshToken.create({
    userId,
    familyId,
    tokenHash: hashToken(token),
    sessionStartedAt,
    expiresAt,
    revokedAt: null,
    terminated: false,
  });

  return { token, familyId };
}

export type RotateResult =
  | { ok: true; userId: string; token: string; familyId: string }
  | { ok: false; reason: "invalid" | "concurrent" | "reused" };

/**
 * Exchange a refresh token for a new one. The old token is claimed with a
 * conditional update, so of two simultaneous requests only one wins.
 *
 * A token that was already used long ago is a sign it was copied: the whole
 * session is revoked, so neither the thief nor the owner can keep refreshing.
 */
export async function rotateRefreshToken(presented: unknown): Promise<RotateResult> {
  if (!plausible(presented)) {
    return { ok: false, reason: "invalid" };
  }

  const tokenHash = hashToken(presented);
  const now = new Date();

  const claimed = await RefreshToken.findOneAndUpdate(
    { tokenHash, revokedAt: null, expiresAt: { $gt: now } },
    { $set: { revokedAt: now } }
  );

  if (claimed) {
    // The session may have been ended in the instant between lookup and claim.
    if (!(await isSessionActive(claimed.familyId))) {
      return { ok: false, reason: "invalid" };
    }

    const next = await issueRefreshToken(String(claimed.userId), {
      familyId: claimed.familyId,
      sessionStartedAt: claimed.sessionStartedAt,
    });

    // ...or while the new token was being written: don't let it outlive the session.
    if (!(await isSessionActive(claimed.familyId))) {
      await revokeFamily(claimed.familyId);
      return { ok: false, reason: "invalid" };
    }

    return { ok: true, userId: String(claimed.userId), ...next };
  }

  const existing = await RefreshToken.findOne({ tokenHash });

  if (existing?.revokedAt) {
    if (now.getTime() - existing.revokedAt.getTime() <= graceMs()) {
      return { ok: false, reason: "concurrent" };
    }

    await revokeFamily(existing.familyId);
    return { ok: false, reason: "reused" };
  }

  return { ok: false, reason: "invalid" };
}

/**
 * End one session: its refresh tokens stop working, and so do the access
 * tokens that name it (see isSessionActive).
 */
export async function revokeFamily(familyId: string): Promise<void> {
  await RefreshToken.updateMany(
    { familyId, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
  await RefreshToken.updateMany({ familyId }, { $set: { terminated: true } });
}

/**
 * False once the session was ended on purpose. Services call this (through
 * /internal/sessions/:id) to reject an access token that hasn't expired yet.
 */
export async function isSessionActive(familyId: string): Promise<boolean> {
  return !(await RefreshToken.findOne({ familyId, terminated: true }));
}

/** Sign-out: revoke the session a presented token belongs to. Unknown tokens are ignored. */
export async function revokeByToken(presented: unknown): Promise<void> {
  if (!plausible(presented)) {
    return;
  }

  const existing = await RefreshToken.findOne({ tokenHash: hashToken(presented) });

  if (existing) {
    await revokeFamily(existing.familyId);
  }
}

/**
 * Sign a person out everywhere (password change, deactivation). Pass the
 * token of the session making the request to leave that one signed in.
 */
export async function revokeAllForUser(
  userId: string,
  keepToken?: unknown
): Promise<void> {
  const scope: Record<string, unknown> = { userId };

  if (plausible(keepToken)) {
    const current = await RefreshToken.findOne({ tokenHash: hashToken(keepToken) });

    // Only spare a session that really is this person's and still alive.
    if (current && current.userId === userId && !current.revokedAt) {
      scope.familyId = { $ne: current.familyId };
    }
  }

  await RefreshToken.updateMany(
    { ...scope, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
  await RefreshToken.updateMany(scope, { $set: { terminated: true } });
}
