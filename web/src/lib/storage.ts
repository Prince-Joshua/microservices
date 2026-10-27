import type { User } from "../api/types";

export const AUTH_KEY = "shop.auth";
export const PENDING_ORDER_KEY = "shop.pendingOrder";

export interface StoredAuth {
  /** Short-lived access token (JWT), sent with every request. */
  token: string;
  /** Long-lived, single-use token that gets a new pair when `token` expires. */
  refreshToken?: string;
  user: User;
}

function decodePayload(token: string): { exp?: number } | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as { exp?: number };
  } catch {
    return null;
  }
}

export function isExpired(token: string): boolean {
  const exp = decodePayload(token)?.exp;
  return typeof exp === "number" && exp * 1000 <= Date.now();
}

export function loadAuth(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAuth;
    // An expired access token is fine while a refresh token can replace it.
    if (!parsed?.token || !parsed.user || (isExpired(parsed.token) && !parsed.refreshToken)) {
      localStorage.removeItem(AUTH_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveAuth(auth: StoredAuth | null): void {
  try {
    if (auth) localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
    else localStorage.removeItem(AUTH_KEY);
  } catch {
    /* storage unavailable: the session just won't survive a reload */
  }
}

export function getToken(): string | null {
  return loadAuth()?.token ?? null;
}

export function getRefreshToken(): string | null {
  return loadAuth()?.refreshToken ?? null;
}
