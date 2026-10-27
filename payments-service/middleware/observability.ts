import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { format } from "node:util";
import type { NextFunction, Request, Response } from "express";

/**
 * Request tracing + structured logs, with no extra dependencies.
 *
 *  - nginx stamps every incoming request with X-Request-Id (or this service
 *    makes one if it was called directly).
 *  - The id travels with the request through async code (AsyncLocalStorage),
 *    is attached to every log line, is sent on calls to the other services,
 *    and is returned to the client in the X-Request-Id response header.
 *  - Logs are one JSON object per line, so any collector can index them.
 *
 * Search all services for one id with `deploy/trace.sh <id>`.
 */

export const REQUEST_ID_HEADER = "x-request-id";

// Ids from callers are only trusted if they look like ids (no log injection).
const ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

const storage = new AsyncLocalStorage<{ requestId: string }>();

export const getRequestId = (): string | undefined => storage.getStore()?.requestId;

/** Run `fn` as part of the trace `requestId` (used by background jobs). */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

export const newJobId = (job: string): string => `job-${job}-${randomUUID().slice(0, 8)}`;

let serviceName = "service";

function emit(level: string, stream: NodeJS.WriteStream, fields: Record<string, unknown>): void {
  stream.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      service: serviceName,
      requestId: getRequestId(),
      ...fields,
    }) + "\n"
  );
}

/** Turns every console.log/info/warn/error call into a JSON line carrying the request id. */
export function installStructuredLogging(service: string): void {
  serviceName = service;

  const line =
    (level: string, stream: NodeJS.WriteStream) =>
    (...args: unknown[]): void =>
      emit(level, stream, { msg: format(...args) });

  console.log = line("info", process.stdout);
  console.info = line("info", process.stdout);
  console.warn = line("warn", process.stderr);
  console.error = line("error", process.stderr);
}

/** Adds the current request id to calls made to the other services (not to Paystack etc.). */
export function installOutboundTracing(serviceUrls: (string | undefined)[]): void {
  const internalOrigins = new Set<string>();

  for (const value of serviceUrls) {
    try {
      if (value) internalOrigins.add(new URL(value).origin);
    } catch {
      /* ignore malformed URLs; startup validation reports those */
    }
  }

  const original = globalThis.fetch;

  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const requestId = getRequestId();

    if (requestId && (typeof input === "string" || input instanceof URL)) {
      try {
        const url = new URL(input instanceof URL ? input.href : (input as string));

        if (internalOrigins.has(url.origin)) {
          const headers = new Headers(init?.headers);

          if (!headers.has(REQUEST_ID_HEADER)) {
            headers.set(REQUEST_ID_HEADER, requestId);
          }

          return original(input, { ...init, headers });
        }
      } catch {
        /* fall through to the untouched call */
      }
    }

    return original(input, init);
  }) as typeof fetch;
}

/** Express middleware: assigns/propagates the id, scopes it to the request, writes one access-log line. */
export function requestContext() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header(REQUEST_ID_HEADER);
    const requestId = incoming && ID_PATTERN.test(incoming) ? incoming : randomUUID();

    res.setHeader("X-Request-Id", requestId);

    const started = process.hrtime.bigint();

    res.on("finish", () => {
      // Health checks every few seconds would drown everything else.
      if (req.path === "/health") return;

      storage.run({ requestId }, () =>
        emit("info", process.stdout, {
          msg: "request",
          method: req.method,
          path: req.originalUrl.split("?")[0], // never log query strings
          status: res.statusCode,
          ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
          userId: (req as Request & { user?: { id?: string } }).user?.id,
        })
      );
    });

    storage.run({ requestId }, () => next());
  };
}
