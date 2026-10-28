/**
 * Asks the users service whether the session named in an access token is
 * still alive, so a token can be rejected before it expires (sign-out,
 * password change, deactivation, "sign out everywhere").
 *
 * Services share no code, so orders-service has its own copy of this file.
 *
 * Trade-offs, on purpose:
 *  - Answers are cached briefly, so a revocation reaches this service within
 *    SESSION_CACHE_MS (30 s), not instantly. The users service itself checks
 *    on every request and is instant.
 *  - If the users service can't be reached (it may be asleep on a free host),
 *    the token is accepted: a short outage must not lock everyone out. The
 *    token's own short expiry still applies. A "can't tell" answer is cached
 *    for a few seconds so a sleeping service isn't hammered or waited on.
 *  - Without USERS_SERVICE_URL the check is off (handy for local development).
 */
interface Entry {
  active: boolean;
  until: number;
}

const cache = new Map<string, Entry>();
const MAX_ENTRIES = 5000;

const number = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const cacheMs = () => number(process.env.SESSION_CACHE_MS, 30_000);
const timeoutMs = () => number(process.env.SESSION_CHECK_TIMEOUT_MS, 2_000) || 2_000;
const UNKNOWN_CACHE_MS = 5_000;
/** An ended session never comes back, so remembering that is safe for long. */
const REVOKED_CACHE_MS = 10 * 60_000;

function remember(sid: string, active: boolean, ttl: number): void {
  if (cache.size >= MAX_ENTRIES) {
    const now = Date.now();

    for (const [key, entry] of cache) {
      if (entry.until <= now) cache.delete(key);
    }

    if (cache.size >= MAX_ENTRIES) cache.clear();
  }

  cache.set(sid, { active, until: Date.now() + ttl });
}

export async function isSessionActive(sid: string): Promise<boolean> {
  const base = process.env.USERS_SERVICE_URL;

  if (!base) return true;

  const hit = cache.get(sid);

  if (hit && hit.until > Date.now()) return hit.active;

  try {
    const response = await fetch(
      `${base}/internal/sessions/${encodeURIComponent(sid)}`,
      {
        headers: { "x-internal-token": process.env.INTERNAL_API_TOKEN ?? "" },
        signal: AbortSignal.timeout(timeoutMs()),
      }
    );

    if (response.status === 200) {
      const body = (await response.json()) as { active?: unknown };

      if (typeof body.active === "boolean") {
        remember(sid, body.active, body.active ? cacheMs() : REVOKED_CACHE_MS);
        return body.active;
      }
    }

    console.error(`Session check got status ${response.status}; allowing the request`);
  } catch (error) {
    console.error("Session check failed; allowing the request:", error);
  }

  remember(sid, true, UNKNOWN_CACHE_MS);
  return true;
}

/** For tests. */
export function clearSessionCache(): void {
  cache.clear();
}
