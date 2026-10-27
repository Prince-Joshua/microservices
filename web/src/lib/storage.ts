import type { User } from "../api/types";

/** Who is signed in. A profile only, never a secret: it lets the UI show the user before the session is confirmed. */
export const SESSION_KEY = "shop.session";
/** Where earlier versions kept the access AND refresh token. Removed on sight. */
const LEGACY_AUTH_KEY = "shop.auth";
export const PENDING_ORDER_KEY = "shop.pendingOrder";

try {
  localStorage.removeItem(LEGACY_AUTH_KEY);
} catch {
  /* storage unavailable */
}

/**
 * The short-lived access token lives in memory only: it is gone on reload and
 * a script can't find it in storage. The long-lived refresh token is an
 * HttpOnly cookie this code never sees; a reload gets a new access token
 * from it (see refreshSession in api/http.ts).
 */
let accessToken: string | null = null;

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

export function getToken(): string | null {
  return accessToken;
}

export function setToken(token: string | null): void {
  accessToken = token;
}

export function loadUser(): User | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as User | null;
    return parsed && typeof parsed.id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function saveUser(user: User | null): void {
  try {
    if (user) localStorage.setItem(SESSION_KEY, JSON.stringify(user));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable: the session just won't survive a reload */
  }
}

/** True while someone is signed in here, even before this tab has an access token. */
export function hasSession(): boolean {
  return loadUser() !== null;
}

/** Forget the user and the access token. Ending the session on the server is the caller's job. */
export function clearSession(): void {
  accessToken = null;
  saveUser(null);
}

// Tabs share the cookie but not memory, so they tell each other when the session changes.
const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("shop.session");

/** Tell the other tabs that someone signed in or out, or that the profile changed. */
export function announceSessionChange(): void {
  channel?.postMessage("changed");
}

/** Runs when ANOTHER tab announces a change (a tab never hears itself). Returns the unsubscribe function. */
export function onSessionChange(callback: () => void): () => void {
  if (!channel) return () => undefined;
  channel.addEventListener("message", callback);
  return () => channel.removeEventListener("message", callback);
}
