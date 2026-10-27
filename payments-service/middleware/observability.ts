import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { format } from "node:util";
import type { NextFunction, Request, Response } from "express";

export const REQUEST_ID_HEADER = "x-request-id";

const ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

const storage = new AsyncLocalStorage<{ requestId: string }>();

export const getRequestId = (): string | undefined =>
  storage.getStore()?.requestId;

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

export const newJobId = (job: string): string =>
  `job-${job}-${randomUUID().slice(0, 8)}`;

let serviceName = "service";

function emit(
  level: string,
  stream: NodeJS.WriteStream,
  fields: Record<string, unknown>,
): void {
  stream.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      service: serviceName,
      requestId: getRequestId(),
      ...fields,
    }) + "\n",
  );
}

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

export function installOutboundTracing(
  serviceUrls: (string | undefined)[],
): void {
  const internalOrigins = new Set<string>();

  for (const value of serviceUrls) {
    try {
      if (value) internalOrigins.add(new URL(value).origin);
    } catch {}
  }

  const original = globalThis.fetch;

  globalThis.fetch = ((
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const requestId = getRequestId();

    if (requestId && (typeof input === "string" || input instanceof URL)) {
      try {
        const url = new URL(
          input instanceof URL ? input.href : (input as string),
        );

        if (internalOrigins.has(url.origin)) {
          const headers = new Headers(init?.headers);

          if (!headers.has(REQUEST_ID_HEADER)) {
            headers.set(REQUEST_ID_HEADER, requestId);
          }

          return original(input, { ...init, headers });
        }
      } catch {}
    }

    return original(input, init);
  }) as typeof fetch;
}

export function requestContext() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header(REQUEST_ID_HEADER);
    const requestId =
      incoming && ID_PATTERN.test(incoming) ? incoming : randomUUID();

    res.setHeader("X-Request-Id", requestId);

    const started = process.hrtime.bigint();

    res.on("finish", () => {
      if (req.path === "/health") return;

      storage.run({ requestId }, () =>
        emit("info", process.stdout, {
          msg: "request",
          method: req.method,
          path: req.originalUrl.split("?")[0],
          status: res.statusCode,
          ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
          userId: (req as Request & { user?: { id?: string } }).user?.id,
        }),
      );
    });

    storage.run({ requestId }, () => next());
  };
}
