import { config } from "../config";
import { getRefreshToken, getToken, isExpired, loadAuth, saveAuth } from "../lib/storage";
import type { User } from "./types";

export class ApiError extends Error {
  status: number;
  body: unknown;
  retryAfter?: number;
  /** X-Request-Id of the failed call: quote it to find the request in the logs. */
  requestId?: string;

  constructor(
    status: number,
    message: string,
    body?: unknown,
    retryAfter?: number,
    requestId?: string
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
    this.requestId = requestId;
  }
}

export const UNAUTHORIZED_EVENT = "auth:unauthorized";
/** Fired when the server answers 403: a role may have changed, so the app re-reads the profile. */
export const FORBIDDEN_EVENT = "auth:forbidden";
/** Fired after a silent refresh, with the up-to-date user as `detail`. */
export const SESSION_REFRESHED_EVENT = "auth:refreshed";

const SESSION_UNAVAILABLE = "Couldn't refresh your session. Check your connection and try again.";

type RefreshOutcome = "ok" | "invalid" | "unavailable";

let refreshInFlight: Promise<RefreshOutcome> | null = null;

/**
 * Swap the refresh token for a new pair. Everything that needs a refresh at
 * the same moment shares one call: refresh tokens are single-use, so two
 * parallel calls would fight over the same token.
 */
function refreshSession(): Promise<RefreshOutcome> {
  refreshInFlight ??= doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefresh(): Promise<RefreshOutcome> {
  const sent = getRefreshToken();
  if (!sent) return "invalid";

  let response: Response;
  try {
    response = await fetch(`${config.usersUrl}/auth/refresh`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: sent }),
    });
  } catch {
    return "unavailable"; // offline or the server is waking up: the session itself is fine
  }

  if (response.ok) {
    try {
      const data = (await response.json()) as { token: string; refreshToken: string; user: User };
      saveAuth({ token: data.token, refreshToken: data.refreshToken, user: data.user });
      window.dispatchEvent(new CustomEvent(SESSION_REFRESHED_EVENT, { detail: data.user }));
      return "ok";
    } catch {
      return "unavailable";
    }
  }

  if (response.status === 401) {
    // Another tab may have refreshed first and stored a newer token: that is a success, not a sign-out.
    const latest = getRefreshToken();
    return latest && latest !== sent ? "ok" : "invalid";
  }

  return "unavailable"; // 5xx, 429 and so on: try again later, don't sign anyone out
}

function sessionEnded(): ApiError {
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  return new ApiError(401, "Your session has expired. Please sign in again.");
}

type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Query;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Send the JWT (default true). Public calls still send it when present so admins see more. */
  auth?: boolean;
}

export interface RawResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

function buildUrl(base: string, path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return `${base}${path}${qs ? `?${qs}` : ""}`;
}

/** One HTTP call with whatever token is stored right now. No refresh logic here. */
async function attempt<T>(
  base: string,
  path: string,
  { method = "GET", body, query, headers = {}, signal, auth = true }: RequestOptions = {}
): Promise<RawResponse<T>> {
  const finalHeaders: Record<string, string> = { Accept: "application/json", ...headers };

  const token = getToken();
  if (auth && token) finalHeaders.Authorization = `Bearer ${token}`;

  if (body !== undefined) finalHeaders["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(buildUrl(base, path, query), {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new ApiError(0, "Can't reach the server. Check your connection and that the services are running.");
  }

  const text = response.status === 204 ? "" : await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }

  if (!response.ok) {
    const message =
      (data as { message?: string } | undefined)?.message ||
      `Request failed (${response.status})`;
    const retry = Number(response.headers.get("Retry-After"));

    if (response.status === 403) window.dispatchEvent(new Event(FORBIDDEN_EVENT));

    throw new ApiError(
      response.status,
      message,
      data,
      Number.isFinite(retry) && retry > 0 ? retry : undefined,
      response.headers.get("x-request-id") ?? undefined
    );
  }

  return { status: response.status, data: data as T, headers: response.headers };
}

/**
 * Like `request`, but also hands back the status code (POST /orders uses 200/201/202 differently).
 *
 * Keeps people signed in: an expired access token is replaced with the refresh
 * token, and the call is repeated once. Only a refresh the server refuses signs
 * the person out; a network failure or a sleeping server never does.
 */
export async function requestRaw<T>(
  base: string,
  path: string,
  options: RequestOptions = {}
): Promise<RawResponse<T>> {
  const auth = options.auth ?? true;

  if (!auth) return attempt<T>(base, path, options);

  // Skip a doomed round trip when we already know the access token has expired.
  const stored = loadAuth();
  if (stored?.refreshToken && isExpired(stored.token)) {
    const outcome = await refreshSession();
    if (outcome === "unavailable") throw new ApiError(0, SESSION_UNAVAILABLE);
    if (outcome === "invalid") throw sessionEnded();
  }

  const sentToken = getToken();

  try {
    return await attempt<T>(base, path, options);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401 || !sentToken) throw error;

    // Signed in but refused: the token expired, or this account was deactivated.
    const now = getToken();
    if (now && now !== sentToken) {
      // Another request or tab already refreshed: just repeat with the new token.
    } else {
      if (!getRefreshToken()) throw sessionEnded();

      const outcome = await refreshSession();
      if (outcome === "unavailable") throw new ApiError(0, SESSION_UNAVAILABLE);
      if (outcome === "invalid") throw sessionEnded();
    }

    try {
      return await attempt<T>(base, path, options);
    } catch (retryError) {
      if (retryError instanceof ApiError && retryError.status === 401) throw sessionEnded();
      throw retryError;
    }
  }
}

export async function request<T>(base: string, path: string, options?: RequestOptions): Promise<T> {
  return (await requestRaw<T>(base, path, options)).data;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    // For server-side failures, give the person something to quote to support.
    return error.requestId && error.status >= 500
      ? `${error.message} (ref: ${error.requestId})`
      : error.message;
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}
