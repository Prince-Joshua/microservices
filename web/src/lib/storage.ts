import type { User } from "../api/types";

export const PENDING_ORDER_KEY = "shop.pendingOrder";

for (const key of ["shop.auth", "shop.session"]) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

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

export function setSessionUser(user: User): void {
  if (currentUser) currentUser = user;
}

/** True while someone is signed in in this tab. */
export function isSignedIn(): boolean {
  return currentUser !== null;
}

export function clearSession(): void {
  accessToken = null;
  currentUser = null;
}

const channel =
  typeof BroadcastChannel === "undefined"
    ? null
    : new BroadcastChannel("shop.session");

export function announceSessionChange(): void {
  channel?.postMessage("changed");
}

export function onSessionChange(callback: () => void): () => void {
  if (!channel) return () => undefined;
  channel.addEventListener("message", callback);
  return () => channel.removeEventListener("message", callback);
}
