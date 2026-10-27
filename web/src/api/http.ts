import { getToken } from "../lib/storage";

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

/** Like `request`, but also hands back the status code (POST /orders uses 200/201/202 differently). */
export async function requestRaw<T>(
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

    if (response.status === 401 && auth && token) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }

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
