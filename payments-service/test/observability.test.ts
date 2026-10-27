import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  getRequestId,
  installOutboundTracing,
  requestContext,
  runWithRequestId,
} from "../middleware/observability.js";

// Stand in for the network, then let the tracing wrapper sit in front of it.
const sent: { url: string; headers: Headers }[] = [];

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  sent.push({ url: String(url), headers: new Headers(init?.headers) });
  return new Response("{}");
}) as typeof fetch;

installOutboundTracing(["http://products:4002", "http://users:4001/"]);

/** Runs one fake request through the middleware; `inside` plays the route handler. */
async function request(
  incomingId: string | undefined,
  inside: () => Promise<void> | void = () => {}
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const req = {
    header: (name: string) => (name.toLowerCase() === "x-request-id" ? incomingId : undefined),
    method: "GET",
    originalUrl: "/orders?token=secret",
    path: "/orders",
  };
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader: (key: string, value: string) => {
      headers[key.toLowerCase()] = value;
    },
  });

  await new Promise<void>((resolve, reject) => {
    requestContext()(req as never, res as never, () => {
      Promise.resolve(inside()).then(() => {
        res.emit("finish");
        resolve();
      }, reject);
    });
  });

  return headers;
}

test("a valid incoming id is kept, returned to the caller and visible in async code", async () => {
  let seen: string | undefined;

  const headers = await request("abc12345-good-id", async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    seen = getRequestId();
  });

  assert.equal(seen, "abc12345-good-id");
  assert.equal(headers["x-request-id"], "abc12345-good-id");
});

test("a missing or malformed id is replaced, so callers can't forge log lines", async () => {
  for (const bad of [undefined, 'x"\n{"level":"error"}', "short"]) {
    const headers = await request(bad);
    assert.match(headers["x-request-id"] ?? "", /^[0-9a-f-]{36}$/);
  }
});

test("the id is sent to the other services, but never to third parties", async () => {
  sent.length = 0;

  await request("trace-me-12345", async () => {
    await fetch("http://products:4002/internal/stock", { headers: { "Idempotency-Key": "k1" } });
    await fetch("https://api.paystack.co/transaction/verify/x");
  });

  assert.equal(sent[0]?.headers.get("x-request-id"), "trace-me-12345");
  assert.equal(sent[0]?.headers.get("idempotency-key"), "k1", "existing headers survive");
  assert.equal(sent[1]?.headers.get("x-request-id"), null);
});

test("background jobs can run under their own id; outside any request there is none", () => {
  assert.equal(getRequestId(), undefined);
  runWithRequestId("job-test-1234", () => assert.equal(getRequestId(), "job-test-1234"));
});
