import { test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import jwt from "jsonwebtoken";

import { installMocks } from "./helpers/fakes.js";

process.env.JWT_SECRET = "test-secret";
process.env.INTERNAL_API_TOKEN = "internal-secret";

installMocks(mock);

const { authenticate } = await import("../middleware/auth.js");
const { default: orderRoutes } = await import("../routes/order.routes.js");
const { isSessionActive, clearSessionCache } = await import("../services/session-check.js");

// A stand-in for the users service: GET /internal/sessions/:sid.
const sessions = new Map<string, boolean>();
let hits = 0;
let mode: "ok" | "error" = "ok";
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

    const sid = decodeURIComponent((req.url ?? "").split("/").pop() ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ active: sessions.get(sid) ?? true }));
  });

  await new Promise<void>((resolve) => usersServer.listen(0, "127.0.0.1", resolve));

  const app = express();
  app.use(express.json());
  app.use("/orders", authenticate, orderRoutes);

  await new Promise<void>((resolve) => {
    appServer = app.listen(0, "127.0.0.1", resolve);
  });

  base = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
});

after(() => {
  usersServer.close();
  appServer.close();
});

beforeEach(() => {
  sessions.clear();
  hits = 0;
  mode = "ok";
  seenToken = undefined;
  clearSessionCache();
  delete process.env.SESSION_CACHE_MS;
  delete process.env.SESSION_CHECK_TIMEOUT_MS;
  delete process.env.ADMIN_SESSION_CACHE_MS;
  process.env.USERS_SERVICE_URL = `http://127.0.0.1:${(usersServer.address() as AddressInfo).port}`;
});

const token = (sid?: string) =>
  jwt.sign({ role: "customer", ...(sid ? { sid } : {}) }, "test-secret", {
    subject: "aaaaaaaaaaaaaaaaaaaaaaaa",
    algorithm: "HS256",
  });

const adminToken = (sid?: string) =>
  jwt.sign({ role: "admin", ...(sid ? { sid } : {}) }, "test-secret", {
    subject: "bbbbbbbbbbbbbbbbbbbbbbbb",
    algorithm: "HS256",
  });

async function listOrders(bearer: string) {
  const response = await fetch(`${base}/orders`, {
    headers: { authorization: `Bearer ${bearer}` },
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

test("a live session is accepted; an ended one gets 401", async () => {
  sessions.set("live", true);
  sessions.set("ended", false);

  assert.equal(await listOrders(token("live")), 200);
  assert.equal(await listOrders(token("ended")), 401);
});

test("a token with no sid (issued before sessions existed) still works", async () => {
  assert.equal(await listOrders(token()), 200);
  assert.equal(hits, 0);
});

test("with no USERS_SERVICE_URL the check is off", async () => {
  delete process.env.USERS_SERVICE_URL;
  sessions.set("ended", false);

  assert.equal(await listOrders(token("ended")), 200);
  assert.equal(hits, 0);
});

test("the users service is called with the internal token", async () => {
  await isSessionActive("s1");
  assert.equal(seenToken, "internal-secret");
});

test("answers are cached, and a revocation is noticed once the entry expires", async () => {
  process.env.SESSION_CACHE_MS = "10";
  sessions.set("s1", true);

  assert.equal(await isSessionActive("s1"), true);
  assert.equal(await isSessionActive("s1"), true);
  assert.equal(hits, 1);

  sessions.set("s1", false);
  await sleep(25);
  assert.equal(await isSessionActive("s1"), false);
  assert.equal(await isSessionActive("s1"), false);
  assert.equal(hits, 2, "an ended session is remembered");
});

test("if the users service errors or is unreachable, the token is accepted", async () => {
  mode = "error";
  assert.equal(await isSessionActive("s1"), true);
  assert.equal(await isSessionActive("s1"), true);
  assert.equal(hits, 1, "the failure is remembered for a few seconds");

  process.env.USERS_SERVICE_URL = `http://127.0.0.1:${await closedPort()}`;
  process.env.SESSION_CHECK_TIMEOUT_MS = "500";
  assert.equal(await isSessionActive("s2"), true);
});

test("admin tokens fail closed: if the session can't be confirmed, 401", async () => {
  mode = "error";
  assert.equal(await listOrders(adminToken("s1")), 401);

  process.env.USERS_SERVICE_URL = `http://127.0.0.1:${await closedPort()}`;
  process.env.SESSION_CHECK_TIMEOUT_MS = "500";
  assert.equal(await listOrders(adminToken("s3")), 401);
});

test("customers still fail open when the users service is down", async () => {
  mode = "error";
  assert.equal(await listOrders(token("c1")), 200);
});

test("a failed check is remembered briefly for admins, and never read as active", async () => {
  mode = "error";

  assert.equal(await isSessionActive("s1", { strict: true }), false);
  assert.equal(await isSessionActive("s1", { strict: true }), false);
  assert.equal(hits, 1);
  assert.equal(await isSessionActive("s1"), true);
});

test("admins are re-checked sooner than customers", async () => {
  process.env.ADMIN_SESSION_CACHE_MS = "10";
  sessions.set("s1", true);

  assert.equal(await isSessionActive("s1", { strict: true }), true);
  assert.equal(await isSessionActive("s1", { strict: true }), true);
  assert.equal(hits, 1);

  sessions.set("s1", false);
  await sleep(25);
  assert.equal(await isSessionActive("s1", { strict: true }), false);
});

test("a confirmed admin answer is still used while the users service is down", async () => {
  sessions.set("s1", true);
  assert.equal(await isSessionActive("s1", { strict: true }), true);

  mode = "error";
  assert.equal(await isSessionActive("s1", { strict: true }), true);
});
