import { test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret";

interface Account {
  id: string;
  isActive: boolean;
  role: "customer" | "admin";
}

const accounts = new Map<string, Account>();
const state = { down: false, calls: 0 };

mock.module(new URL("../clients/users.client.js", import.meta.url).href, {
  namedExports: {
    getUser: async (id: string) => {
      state.calls += 1;

      if (state.down) {
        throw new Error("Users service returned 503");
      }

      return accounts.get(id) ?? null;
    },
  },
});

const { optionalAuth, requireAdmin } = await import("../middleware/auth.js");
const { clearUserStatusCache } = await import("../services/user-status.js");

let server: Server;
let base: string;

before(async () => {
  const app = express();
  app.get("/who", optionalAuth, (req, res) => res.json({ role: req.user?.role ?? null }));
  app.get("/admin", requireAdmin, (_req, res) => res.json({ ok: true }));

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });

  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

beforeEach(() => {
  accounts.clear();
  accounts.set("boss", { id: "boss", isActive: true, role: "admin" });
  accounts.set("shopper", { id: "shopper", isActive: true, role: "customer" });
  state.down = false;
  state.calls = 0;
  process.env.USER_STATUS_TTL_MS = "0";
  clearUserStatusCache();
});

const token = (sub: string, claimedRole: string) =>
  jwt.sign({ role: claimedRole }, "test-secret", { subject: sub, algorithm: "HS256" });

const get = (path: string, bearer?: string) =>
  fetch(`${base}${path}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });

test("a deactivated admin loses write access at once, token still valid", async () => {
  assert.equal((await get("/admin", token("boss", "admin"))).status, 200);

  accounts.get("boss")!.isActive = false;
  assert.equal((await get("/admin", token("boss", "admin"))).status, 401);
});

test("a demoted admin gets 403, and a promoted customer gets in, without new tokens", async () => {
  accounts.get("boss")!.role = "customer";
  assert.equal((await get("/admin", token("boss", "admin"))).status, 403);

  accounts.get("shopper")!.role = "admin";
  assert.equal((await get("/admin", token("shopper", "customer"))).status, 200);
});

test("admin writes fail closed (503) when the Users service is down", async () => {
  state.down = true;
  assert.equal((await get("/admin", token("boss", "admin"))).status, 503);
});

test("catalogue browsing never depends on the Users service", async () => {
  state.down = true;

  // Customers and anonymous visitors: no lookup at all.
  const before = state.calls;
  assert.equal(((await (await get("/who", token("shopper", "customer"))).json()) as { role: string }).role, "customer");
  assert.equal(((await (await get("/who")).json()) as { role: string | null }).role, null);
  assert.equal(state.calls, before);

  // A token claiming admin can't be verified, so it is treated as anonymous, not rejected.
  const reply = await get("/who", token("boss", "admin"));
  assert.equal(reply.status, 200);
  assert.equal(((await reply.json()) as { role: string | null }).role, null);
});

test("optionalAuth drops a stale admin claim", async () => {
  accounts.get("boss")!.role = "customer";
  assert.equal(((await (await get("/who", token("boss", "admin"))).json()) as { role: string }).role, "customer");

  accounts.get("boss")!.isActive = false;
  assert.equal(((await (await get("/who", token("boss", "admin"))).json()) as { role: string | null }).role, null);
});
