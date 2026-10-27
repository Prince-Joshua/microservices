import type { NextFunction, Request, Response } from "express";

/**
 * The refresh token travels in an HttpOnly cookie, so page scripts (and any
 * XSS payload) can never read it. The browser sends it back on its own.
 */
export const REFRESH_COOKIE = "refresh_token";

/**
 * Any value will do: a cross-site form or image can't add a custom header,
 * and a cross-site fetch that does would need a CORS preflight, which these
 * services never approve. SameSite=Strict is the first line; this is the second.
 */
export const CSRF_HEADER = "x-requested-with";

/**
 * The path the browser sees, not the one this service sees: the gateway and
 * the Vercel rewrite strip /api/users before the request arrives. It covers
 * /auth/* and /users/me/password (which needs the cookie to keep this session).
 */
function cookiePath(): string {
  return process.env.REFRESH_COOKIE_PATH || "/api/users";
}

function cookieSecure(): boolean {
  const flag = process.env.REFRESH_COOKIE_SECURE?.trim().toLowerCase();

  if (flag === "true") return true;
  if (flag === "false") return false;

  return process.env.NODE_ENV === "production";
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "strict" as const,
    path: cookiePath(),
  };
}

/** Sets the cookie to expire together with the token it carries. */
export function setRefreshCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, token, { ...cookieOptions(), expires: expiresAt });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, cookieOptions());
}

/** No cookie-parser: this is the only cookie the service reads. */
export function readRefreshCookie(req: Request): string | undefined {
  const header = req.headers.cookie;

  if (!header) return undefined;

  for (const part of header.split(";")) {
    const index = part.indexOf("=");

    if (index === -1 || part.slice(0, index).trim() !== REFRESH_COOKIE) continue;

    const raw = part.slice(index + 1).trim();

    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function allowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, "").toLowerCase())
    .filter(Boolean);
}

/**
 * Guards the calls that rely on the refresh cookie:
 *  1. the custom header must be present, and
 *  2. when ALLOWED_ORIGINS is set, a request that names an Origin (browsers
 *     always do on a POST) must name one of them. A request without an Origin
 *     isn't a cross-site browser request and still has to pass the header check.
 */
export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  if (!req.get(CSRF_HEADER)) {
    res.status(403).json({ message: `Missing ${CSRF_HEADER} header` });
    return;
  }

  const allowed = allowedOrigins();
  const origin = req.get("origin");

  if (allowed.length > 0 && origin && !allowed.includes(origin.replace(/\/+$/, "").toLowerCase())) {
    res.status(403).json({ message: "Origin not allowed" });
    return;
  }

  next();
}
