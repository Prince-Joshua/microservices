import type { User } from "../api/types";

export const PENDING_ORDER_KEY = "shop.pendingOrder";

// Earlier versions kept the tokens (shop.auth) and then the user's profile (shop.session)
// here. Nothing about the session is stored in the browser any more: remove what is left.
for (const key of ["shop.auth", "shop.session"]) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

/**
 * The session lives in memory only, so a script can't find any of it in storage.
 * The short-lived access token and the user's profile are gone on reload; the
 * long-lived refresh token is an HttpOnly cookie this code never sees, and a
 * reload gets a new access token and the profile back from it (restoreSession
 * in api/http.ts).
 */
let accessToken: string | null = null;
let currentUser: User | null = null;

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

export function getUser(): User | null {
  return currentUser;
}

export function setSession(token: string, user: User): void {
  accessToken = token;
  currentUser = user;
}

/** A changed profile (a rename, a new role) for the session that is already open. */
export function setSessionUser(user: User): void {
  if (currentUser) currentUser = user;
}

/** True while someone is signed in in this tab. */
export function isSignedIn(): boolean {
  return currentUser !== null;
}

/** Forget the user and the access token. Ending the session on the server is the caller's job. */
export function clearSession(): void {
  accessToken = null;
  currentUser = null;
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
