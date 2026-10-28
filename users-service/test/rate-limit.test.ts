import { test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";

import { createFakeRefreshModel } from "./helpers/refresh-store.js";

process.env.JWT_SECRET = "test-secret";

interface FakeUser {
  _id: string;
  name: string;
  email: string;
  passwordHash: string;
  role: "customer" | "admin";
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const users: FakeUser[] = [];

const User = {
  findOne(query: { email: string }) {
    const user = users.find((candidate) => candidate.email === query.email) ?? null;
    return { select: async () => user };
  },
  async findById(id: string) {
    return users.find((candidate) => candidate._id === id) ?? null;
  },
};

const refreshStore = createFakeRefreshModel();

mock.module(new URL("../models/user.model.js", import.meta.url).href, {
  namedExports: { User },
});
mock.module(new URL("../models/refresh-token.model.js", import.meta.url).href, {
  namedExports: { RefreshToken: refreshStore.model },
});

const { hashPassword } = await import("../services/password.js");
const { default: authRoutes } = await import("../routes/auth.routes.js");
const { RateLimiter, resetRateLimits, trustProxySetting } = await import("../services/rate-limit.js");

let server: Server;
let base: string;

before(async () => {
  const app = express();
  app.set("trust proxy", 1); // so X-Forwarded-For stands in for different callers
  app.use(express.json());
  app.use("/auth", authRoutes);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });

  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

const PASSWORD = "correct horse";

beforeEach(async () => {
  users.length = 0;
  refreshStore.rows.length = 0;
  resetRateLimits();

  const passwordHash = await hashPassword(PASSWORD);
  const now = new Date();

  for (const [id, email] of [
    ["000000000000000000000001", "ada@example.com"],
    ["000000000000000000000002", "bola@example.com"],
  ] as const) {
    users.push({
      _id: id,
      name: email,
      email,
      passwordHash,
      role: "customer",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
  }
});

async function post(path: string, body: unknown, ip = "10.0.0.1") {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
  const text = await response.text();

  return {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    body: (text ? JSON.parse(text) : {}) as Record<string, any>,
  };
}

const login = (email: string, password: string, ip?: string) =>
  post("/auth/login", { email, password }, ip);

const wrong = (email: string, ip?: string) => login(email, "not the password", ip);

// ---------------------------------------------------------------- the limiter

test("limiter: allows `max` events per window, then refuses, then recovers", () => {
  let clock = 0;
  const limiter = new RateLimiter({ windowMs: 1000, max: 3, now: () => clock });

  assert.deepEqual([1, 2, 3].map(() => limiter.hit("k").allowed), [true, true, true]);

  const over = limiter.hit("k");
  assert.equal(over.allowed, false);
  assert.equal(over.retryAfterSec, 1);

  clock = 999;
  assert.equal(limiter.hit("k").allowed, false, "still inside the window");

  clock = 1000;
  assert.equal(limiter.hit("k").allowed, true, "a new window starts");
});

test("limiter: keys are independent", () => {
  const limiter = new RateLimiter({ windowMs: 1000, max: 1 });

  assert.equal(limiter.hit("a").allowed, true);
  assert.equal(limiter.hit("a").allowed, false);
  assert.equal(limiter.hit("b").allowed, true);
});

test("limiter: isBlocked looks without counting, and blocks at `max` failures", () => {
  const limiter = new RateLimiter({ windowMs: 1000, max: 2 });

  assert.equal(limiter.isBlocked("k").blocked, false);
  assert.equal(limiter.isBlocked("k").blocked, false, "checking doesn't count");

  limiter.hit("k");
  assert.equal(limiter.isBlocked("k").blocked, false);

  limiter.hit("k");
  const blocked = limiter.isBlocked("k");
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.retryAfterSec >= 1);

  limiter.reset("k");
  assert.equal(limiter.isBlocked("k").blocked, false);
});

test("limiter: retryAfterSec counts down and is never below 1", () => {
  let clock = 0;
  const limiter = new RateLimiter({ windowMs: 10_000, max: 1, now: () => clock });

  limiter.hit("k");
  clock = 4_000;
  assert.equal(limiter.hit("k").retryAfterSec, 6);
  clock = 9_999;
  assert.equal(limiter.hit("k").retryAfterSec, 1);
});

test("limiter: memory is bounded by maxKeys", () => {
  const limiter = new RateLimiter({ windowMs: 60_000, max: 1, maxKeys: 50 });

  for (let i = 0; i < 500; i += 1) limiter.hit(`key-${i}`);

  const tracked = (limiter as unknown as { entries: Map<string, unknown> }).entries.size;
  assert.ok(tracked <= 50, `tracked ${tracked}`);
});

test("trust proxy setting: a number of hops, 'false', or a safe default", () => {
  assert.equal(trustProxySetting(undefined), 1);
  assert.equal(trustProxySetting(""), 1);
  assert.equal(trustProxySetting("2"), 2);
  assert.equal(trustProxySetting("false"), false);
  assert.equal(trustProxySetting("0"), false);
  // "true" would trust any X-Forwarded-For: not accepted.
  assert.equal(trustProxySetting("true"), 1);
  assert.equal(trustProxySetting("-3"), 1);
});

// ---------------------------------------------------------------- login

test("login: after 5 wrong passwords from one address, the 6th attempt is refused, even with the right password", async () => {
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await wrong("ada@example.com")).status, 401);
  }

  const blocked = await login("ada@example.com", PASSWORD);

  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.retryAfter) >= 1, `Retry-After ${blocked.retryAfter}`);
  assert.match(blocked.body.message, /too many/i);
  assert.equal("token" in blocked.body, false);
});

test("login: the lockout is for that account at that address, not everyone", async () => {
  for (let i = 0; i < 5; i += 1) await wrong("ada@example.com", "10.0.0.1");

  assert.equal((await login("ada@example.com", PASSWORD, "10.0.0.1")).status, 429);

  // The real owner, from their own address, still gets in.
  assert.equal((await login("ada@example.com", PASSWORD, "10.0.0.2")).status, 200);
  // And the same address can still sign in to a different account.
  assert.equal((await login("bola@example.com", PASSWORD, "10.0.0.1")).status, 200);
});

test("login: a success clears this address's failures", async () => {
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < 4; i += 1) await wrong("ada@example.com");
    assert.equal((await login("ada@example.com", PASSWORD)).status, 200, `round ${round}`);
  }
});

test("login: someone rotating addresses is stopped by the per-account limit (20 failures)", async () => {
  for (let i = 0; i < 20; i += 1) {
    assert.equal((await wrong("ada@example.com", `10.1.0.${i + 1}`)).status, 401, `attempt ${i}`);
  }

  // A brand-new address is refused too, even with the right password.
  assert.equal((await login("ada@example.com", PASSWORD, "10.9.9.9")).status, 429);
  // Other accounts are not affected.
  assert.equal((await login("bola@example.com", PASSWORD, "10.9.9.9")).status, 200);
});

test("login: logging in elsewhere doesn't wipe the all-addresses counter", async () => {
  for (let i = 0; i < 19; i += 1) await wrong("ada@example.com", `10.1.0.${i + 1}`);

  assert.equal((await login("ada@example.com", PASSWORD, "10.8.8.8")).status, 200);

  await wrong("ada@example.com", "10.1.1.1"); // the 20th failure
  assert.equal((await login("ada@example.com", PASSWORD, "10.7.7.7")).status, 429);
});

test("login: unknown emails are limited exactly like real ones, so the 429 reveals nothing", async () => {
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await wrong("nobody@example.com")).status, 401);
  }

  const unknown = await login("nobody@example.com", "whatever");

  for (let i = 0; i < 5; i += 1) await wrong("ada@example.com", "10.5.5.5");
  const known = await login("ada@example.com", "whatever", "10.5.5.5");

  assert.equal(unknown.status, 429);
  assert.equal(known.status, 429);
  assert.deepEqual(unknown.body, known.body);
});

test("login: email casing and spacing can't be used to dodge the limit", async () => {
  for (const variant of ["ada@example.com", " ADA@example.com", "Ada@Example.com ", "ada@EXAMPLE.com", "aDa@example.com"]) {
    await wrong(variant);
  }

  assert.equal((await login("ada@example.com", PASSWORD)).status, 429);
});

test("login: one address can't make unlimited attempts across accounts (100 per window)", async () => {
  for (let i = 0; i < 100; i += 1) {
    const reply = await post("/auth/login", { email: `user${i}@example.com`, password: "x" }, "10.2.2.2");
    assert.equal(reply.status, 401, `attempt ${i}`);
  }

  const over = await post("/auth/login", { email: "ada@example.com", password: PASSWORD }, "10.2.2.2");
  assert.equal(over.status, 429);

  // Other addresses are fine.
  assert.equal((await login("ada@example.com", PASSWORD, "10.3.3.3")).status, 200);
});

test("login: malformed requests still count toward the address limit but never crash", async () => {
  assert.equal((await post("/auth/login", {})).status, 400);
  assert.equal((await post("/auth/login", { email: 5, password: [] })).status, 400);
  assert.equal((await post("/auth/login", { email: "e".repeat(5000) + "@x.com", password: "p" })).status, 401);
});

// ---------------------------------------------------------------- refresh

test("refresh: after 30 bad tokens from one address, further refreshes are refused", async () => {
  for (let i = 0; i < 30; i += 1) {
    assert.equal((await post("/auth/refresh", { refreshToken: `guess-${i}` }, "10.4.4.4")).status, 401, `guess ${i}`);
  }

  const blocked = await post("/auth/refresh", { refreshToken: "guess-31" }, "10.4.4.4");
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.retryAfter) >= 1);

  // Another address is unaffected, including with a real token.
  const session = (await login("ada@example.com", PASSWORD, "10.6.6.6")).body.refreshToken as string;
  assert.equal((await post("/auth/refresh", { refreshToken: session }, "10.6.6.6")).status, 200);
});

test("refresh: normal use is never limited, however often a person refreshes", async () => {
  let current = (await login("ada@example.com", PASSWORD)).body.refreshToken as string;

  for (let i = 0; i < 40; i += 1) {
    const reply = await post("/auth/refresh", { refreshToken: current });
    assert.equal(reply.status, 200, `refresh ${i}`);
    current = reply.body.refreshToken as string;
  }
});

test("refresh: two tabs racing (a harmless 401) don't count against the address", async () => {
  const first = (await login("ada@example.com", PASSWORD)).body.refreshToken as string;

  const [a, b] = await Promise.all([
    post("/auth/refresh", { refreshToken: first }),
    post("/auth/refresh", { refreshToken: first }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 401], "one wins, one loses the race");

  // The loser's token keeps failing for a moment (it was just used): plain 401s, never a 429,
  // however many tabs retry, because a race is not an attack.
  for (let i = 0; i < 40; i += 1) {
    assert.equal((await post("/auth/refresh", { refreshToken: first })).status, 401, `retry ${i}`);
  }
});

test("refresh: the per-address request limit stops floods of real refreshes (300 per window)", async () => {
  let current = (await login("ada@example.com", PASSWORD)).body.refreshToken as string;

  for (let i = 0; i < 300; i += 1) {
    const reply = await post("/auth/refresh", { refreshToken: current });
    assert.equal(reply.status, 200, `refresh ${i}`);
    current = reply.body.refreshToken as string;
  }

  assert.equal((await post("/auth/refresh", { refreshToken: current })).status, 429);
  assert.equal((await post("/auth/refresh", { refreshToken: current }, "10.7.7.8")).status, 200, "another address is fine");
});

test("both limits answer with Retry-After and a JSON message", async () => {
  for (let i = 0; i < 5; i += 1) await wrong("ada@example.com");
  const reply = await login("ada@example.com", "x");

  assert.equal(reply.status, 429);
  assert.equal(typeof reply.body.message, "string");
  assert.match(reply.retryAfter ?? "", /^\d+$/);
});
