import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret";

const ID = "000000000000000000000001";

const state = {
  account: { role: "customer", isActive: true } as { role: string; isActive: boolean } | null,
  down: false,
};

const User = {
  findById(id: string) {
    return {
      select() {
        return {
          lean: async () => {
            if (state.down) throw new Error("db down");
            return id === ID ? state.account : null;
          },
        };
      },
    };
  },
};

mock.module(new URL("../models/user.model.js", import.meta.url).href, {
  namedExports: { User },
});

const { requireAuth, requireAdmin, currentUser } = await import("../middleware/auth.js");

let server: Server;
let base: string;

before(async () => {
  const app = express();
  app.get("/me", requireAuth, (req, res) => res.json(currentUser(req)));
  app.get("/admin", requireAuth, requireAdmin, (_req, res) => res.json({ ok: true }));

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });

  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

const token = (claimedRole = "customer", sub = ID) =>
  jwt.sign({ role: claimedRole }, "test-secret", { subject: sub, algorithm: "HS256" });

const get = (path: string, bearer?: string) =>
  fetch(`${base}${path}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });

test("a deactivated account is refused at once, with a token that has not expired", async () => {
  state.account = { role: "customer", isActive: true };
  assert.equal((await get("/me", token())).status, 200);

  state.account = { role: "customer", isActive: false };
  assert.equal((await get("/me", token())).status, 401);
});

test("the role comes from the database, not from the token", async () => {
  state.account = { role: "customer", isActive: true };
  assert.equal((await get("/admin", token("admin"))).status, 403, "token claims admin, database says customer");

  state.account = { role: "admin", isActive: true };
  assert.equal((await get("/admin", token("customer"))).status, 200, "promoted without a new token");
  assert.equal(((await (await get("/me", token("customer"))).json()) as { role: string }).role, "admin");
});

test("an account that no longer exists, or a bad token, is a 401", async () => {
  state.account = null;
  assert.equal((await get("/me", token())).status, 401);
  assert.equal((await get("/me")).status, 401);
  assert.equal((await get("/me", "garbage")).status, 401);
  assert.equal((await get("/me", token("customer", "not-an-object-id"))).status, 401);
});

test("when the database fails, the request fails closed with a 503", async () => {
  state.account = { role: "admin", isActive: true };
  state.down = true;

  try {
    assert.equal((await get("/admin", token("admin"))).status, 503);
  } finally {
    state.down = false;
  }
});
