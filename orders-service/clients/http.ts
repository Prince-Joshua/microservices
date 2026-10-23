import { OrderError } from "../errors.js";

/**
 * One call to another service.
 *
 * Returns { status, data } for anything below 500, so callers decide
 * what a 404 or 409 means. Network failures, timeouts and 5xx responses
 * throw a 503 OrderError: the outcome of the call is unknown, which the
 * order route already handles (it tracks attempted reservations and
 * releases them idempotently).
 */
export interface ServiceReply {
  status: number;
  /** Parsed JSON body, or null when empty or not JSON. */
  data: any;
}

export async function request(
  serviceName: string,
  url: string,
  { method = "GET", body }: { method?: string; body?: unknown } = {}
): Promise<ServiceReply> {
  let response: Response;

  try {
    response = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        "x-internal-token": process.env.INTERNAL_API_TOKEN ?? "",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(
        Number(process.env.HTTP_TIMEOUT_MS) || 3000
      ),
    });
  } catch (cause) {
    console.error(`${serviceName} call failed:`, method, url, cause);
    throw new OrderError(`${serviceName} is unavailable`, 503);
  }

  let data: any = null;

  try {
    data = await response.json();
  } catch {
    // Empty or non-JSON body; callers check status first.
  }

  if (response.status >= 500) {
    console.error(`${serviceName} returned ${response.status}:`, method, url);
    throw new OrderError(`${serviceName} is unavailable`, 503);
  }

  return { status: response.status, data };
}
