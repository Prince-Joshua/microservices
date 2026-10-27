import { RateLimiter, envInt } from "./rate-limit.js";

const MINUTE = 60_000;

/**
 * Every limit can be changed with an environment variable; the defaults are
 * sized so normal use never notices them.
 */

/** All login requests from one address. Loose on purpose: offices share an IP. */
export const loginByIp = new RateLimiter({
  windowMs: 15 * MINUTE,
  max: envInt("RATE_LIMIT_LOGIN_IP_MAX", 20),
});

/**
 * Failed logins for one email address, wherever they come from. This is what
 * stops password guessing; it applies equally to emails that don't exist, so
 * it reveals nothing about which accounts do.
 */
export const loginFailures = new RateLimiter({
  windowMs: 15 * MINUTE,
  max: envInt("RATE_LIMIT_LOGIN_FAILS_MAX", 8),
});

/** Refresh tokens are 256-bit random, so this only protects the database from floods. */
export const refreshByIp = new RateLimiter({
  windowMs: 15 * MINUTE,
  max: envInt("RATE_LIMIT_REFRESH_MAX", 60),
});

/** Account creation is the cheapest way to fill the database with junk. */
export const registerByIp = new RateLimiter({
  windowMs: 60 * MINUTE,
  max: envInt("RATE_LIMIT_REGISTER_MAX", 10),
});

/** Wrong "current password" attempts on a signed-in account (stolen access token case). */
export const passwordFailures = new RateLimiter({
  windowMs: 15 * MINUTE,
  max: envInt("RATE_LIMIT_PASSWORD_FAILS_MAX", 8),
});
