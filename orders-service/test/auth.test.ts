import { test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import jwt from "jsonwebtoken";

import { OrderError } from "../errors.js";

process.env.JWT_SECRET = "test-secret";

interface Account {
  id: string;
  isActive: boolean;
  role: "customer" | "admin";
}

const accounts = new Map<string, Account>();
const calls = { count: 0 };
const state = { down: false };

mock.module(new URL("../clients/users.client.js", import.meta.url).href, {
  namedExports: {
    getUser: async (id: string) => {
      calls.count += 1;

      if (state.down) {
        throw new OrderError("Users service is unavailable", 503);
      }

      return accounts.get(id) ?? null;
    },
  },
});

const { authenticate, currentUser, requireAdmin } = await import("../middleware/auth.js");
const { clearUserStatusCache } = await import("../services/user-status.js");

let server: Server;
let base: string;

before(async () => {
  const app = express();
  app.get("/me", authenticate, (req, res) => res.json(currentUser(req)));
  app.get("/admin", authenticate, requireAdmin, (_req, res) => res.json({ ok: true }));

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });

  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

beforeEach(() => {
  accounts.clear();
  accounts.set("alice", { id: "alice", isActive: true, role: "customer" });
  calls.count = 0;
  state.down = false;
  process.env.USER_STATUS_TTL_MS = "0";
  clearUserStatusCache();
});

const token = (sub: string, claimedRole = "customer") =>
  jwt.sign({ role: claimedRole }, "test-secret", { subject: sub, algorithm: "HS256" });

const get = (path: string, bearer?: string) =>
  fetch(`${base}${path}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });

test("a deactivated account is refused even though its token is still valid", async () => {
  assert.equal((await get("/me", token("alice"))).status, 200);

  accounts.get("alice")!.isActive = false;
  assert.equal((await get("/me", token("alice"))).status, 401);
});

test("the role comes from the Users service, not from the token", async () => {
  assert.equal((await get("/admin", token("alice", "admin"))).status, 403, "token claims admin");

  accounts.get("alice")!.role = "admin";
  assert.equal((await get("/admin", token("alice", "customer"))).status, 200, "promoted without a new token");

  accounts.get("alice")!.role = "customer";
  assert.equal((await get("/admin", token("alice", "admin"))).status, 403, "demoted without a new token");
});

test("an unknown account and bad tokens are a 401, and no Users call is made for a bad token", async () => {
  assert.equal((await get("/me", token("ghost"))).status, 401);

  calls.count = 0;
  assert.equal((await get("/me")).status, 401);
  assert.equal((await get("/me", "garbage")).status, 401);
  assert.equal(calls.count, 0);
});

test("when the Users service is down the request fails closed with a 503", async () => {
  state.down = true;
  assert.equal((await get("/me", token("alice"))).status, 503);
});

test("answers are reused for the TTL, so a busy customer costs one Users call", async () => {
  process.env.USER_STATUS_TTL_MS = "60000";

  for (let i = 0; i < 5; i++) {
    assert.equal((await get("/me", token("alice"))).status, 200);
  }

  assert.equal(calls.count, 1);

  // A failure is never cached: once the service is back, requests succeed again.
  clearUserStatusCache();
  state.down = true;
  assert.equal((await get("/me", token("alice"))).status, 503);
  state.down = false;
  assert.equal((await get("/me", token("alice"))).status, 200);
});

test("simultaneous requests for one account share a single lookup", async () => {
  process.env.USER_STATUS_TTL_MS = "60000";

  const replies = await Promise.all(
    Array.from({ length: 6 }, () => get("/me", token("alice")))
  );

  assert.ok(replies.every((reply) => reply.status === 200));
  assert.equal(calls.count, 1);
});
