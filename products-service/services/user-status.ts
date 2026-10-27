import { getUser, type RemoteUser } from "../clients/users.client.js";

interface Entry {
  value: RemoteUser | null;
  expiresAt: number;
}

const MAX_ENTRIES = 5000;
const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<RemoteUser | null>>();

/**
 * How long an answer from the Users service is reused. This is the longest a
 * deactivation or role change can go unnoticed here. 0 turns the cache off.
 */
function ttlMs(): number {
  const raw = process.env.USER_STATUS_TTL_MS;

  if (raw === undefined || raw.trim() === "") {
    return 15_000;
  }

  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 15_000;
}

/** The account behind a token, cached for a few seconds. Failures are never cached. */
export async function getUserStatus(userId: string): Promise<RemoteUser | null> {
  const ttl = ttlMs();

  if (ttl > 0) {
    const hit = cache.get(userId);

    if (hit && hit.expiresAt > Date.now()) {
      return hit.value;
    }
  }

  const pending = inFlight.get(userId);

  if (pending) {
    return pending;
  }

  const lookup = getUser(userId)
    .then((value) => {
      if (ttl > 0) {
        if (cache.size >= MAX_ENTRIES) {
          const oldest = cache.keys().next().value;

          if (oldest !== undefined) {
            cache.delete(oldest);
          }
        }

        cache.set(userId, { value, expiresAt: Date.now() + ttl });
      }

      return value;
    })
    .finally(() => {
      inFlight.delete(userId);
    });

  inFlight.set(userId, lookup);
  return lookup;
}

export function clearUserStatusCache(): void {
  cache.clear();
}
