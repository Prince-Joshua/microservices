import { test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret";
process.env.INTERNAL_API_TOKEN = "internal-secret";

// Any database call throws, so a request that passes authentication shows up
// as a 500 and one that is rejected as a 401: the status tells them apart.
const Product = new Proxy(
  {},
  {
    get: (_target, method) => () => {
      throw new Error(`database touched via Product.${String(method)}`);
    },
  }
);

mock.module(new URL("../models/product.model.js", import.meta.url).href, {
  namedExports: { Product },
});

const { default: productsRoutes } = await import("../routes/products.routes.js");
const { isSessionActive, clearSessionCache } = await import("../services/session-check.js");

// A stand-in for the users service: GET /internal/sessions/:sid.
const sessions = new Map<string, boolean>();
let hits = 0;
let mode: "ok" | "error" | "garbage" = "ok";
let seenToken: string | undefined;

let usersServer: Server;
let appServer: Server;
let base: string;

before(async () => {
  usersServer = createServer((req, res) => {
    hits += 1;
    seenToken = req.headers["x-internal-token"] as string | undefined;

    if (mode === "error") {
      res.statusCode = 500;
      res.end("boom");
      return;
    }

    if (mode === "garbage") {
      res.end("not json");
      return;
    }

    const sid = decodeURIComponent((req.url ?? "").split("/").pop() ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ active: sessions.get(sid) ?? true }));
  });

  await new Promise<void>((resolve) => usersServer.listen(0, "127.0.0.1", resolve));

  const app = express();
  app.use(express.json());
  app.use("/products", productsRoutes);

  await new Promise<void>((resolve) => {
    appServer = app.listen(0, "127.0.0.1", resolve);
  });

  base = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
});

after(() => {
  usersServer.close();
  appServer.close();
});

function useUsersService() {
  process.env.USERS_SERVICE_URL = `http://127.0.0.1:${(usersServer.address() as AddressInfo).port}`;
}

beforeEach(() => {
  sessions.clear();
  hits = 0;
  mode = "ok";
  seenToken = undefined;
  clearSessionCache();
  delete process.env.SESSION_CACHE_MS;
  delete process.env.SESSION_CHECK_TIMEOUT_MS;
  useUsersService();
});

const adminToken = (sid?: string) =>
  jwt.sign({ role: "admin", ...(sid ? { sid } : {}) }, "test-secret", {
    subject: "u1",
    algorithm: "HS256",
  });

async function createProduct(token: string) {
  const response = await fetch(`${base}/products`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: "Widget", price: 5 }),
  });

  return response.status;
}

/** A port nothing listens on: open a server, note its port, close it. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a live session passes authentication; an ended one is rejected with 401", async () => {
  sessions.set("live", true);
  sessions.set("ended", false);

  assert.equal(await createProduct(adminToken("live")), 500, "reached the database");
  assert.equal(await createProduct(adminToken("ended")), 401);
});

test("a token with no sid (issued before sessions existed) still works until it expires", async () => {
  assert.equal(await createProduct(adminToken()), 500);
  assert.equal(hits, 0);
});

test("with no USERS_SERVICE_URL the check is off", async () => {
  delete process.env.USERS_SERVICE_URL;
  sessions.set("ended", false);

  assert.equal(await createProduct(adminToken("ended")), 500);
  assert.equal(hits, 0);
});

test("the users service is called with the internal token", async () => {
  await isSessionActive("s1");
  assert.equal(seenToken, "internal-secret");
});

test("answers are cached, so a busy service doesn't ask on every request", async () => {
  sessions.set("s1", true);

  for (let i = 0; i < 5; i += 1) {
    assert.equal(await isSessionActive("s1"), true);
  }

  assert.equal(hits, 1);
});

test("a revocation is noticed once the cache entry expires", async () => {
  process.env.SESSION_CACHE_MS = "10";
  sessions.set("s1", true);

  assert.equal(await isSessionActive("s1"), true);

  sessions.set("s1", false);
  assert.equal(await isSessionActive("s1"), true, "still cached");

  await sleep(25);
  assert.equal(await isSessionActive("s1"), false, "noticed after the cache expired");
});

test("an ended session stays ended without asking again", async () => {
  sessions.set("s1", false);

  assert.equal(await isSessionActive("s1"), false);
  assert.equal(await isSessionActive("s1"), false);
  assert.equal(hits, 1);
});

test("if the users service errors, the token is accepted (fail open) and not hammered", async () => {
  mode = "error";

  assert.equal(await isSessionActive("s1"), true);
  assert.equal(await isSessionActive("s1"), true);
  assert.equal(hits, 1, "the failure is remembered for a few seconds");

  mode = "garbage";
  clearSessionCache();
  assert.equal(await isSessionActive("s2"), true);
});

test("if the users service is unreachable, the token is accepted", async () => {
  process.env.USERS_SERVICE_URL = `http://127.0.0.1:${await closedPort()}`;
  process.env.SESSION_CHECK_TIMEOUT_MS = "500";

  assert.equal(await isSessionActive("s1"), true);
});

test("an ended session does not turn an admin into an anonymous visitor with admin rights", async () => {
  sessions.set("ended", false);

  // Public list: the revoked admin is treated as anonymous, so the database is
  // reached without the admin-only filter; here that shows as a 500, not a 401.
  const response = await fetch(`${base}/products?includeInactive=true`, {
    headers: { authorization: `Bearer ${adminToken("ended")}` },
  });

  assert.equal(response.status, 500);
});
