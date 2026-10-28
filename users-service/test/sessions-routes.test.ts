import { test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import jwt from "jsonwebtoken";

import { createFakeRefreshModel } from "./helpers/refresh-store.js";

process.env.JWT_SECRET = "test-secret";
process.env.INTERNAL_API_TOKEN = "internal-secret";

interface FakeUser {
  _id: string;
  name: string;
  email: string;
  passwordHash: string;
  role: "customer" | "admin";
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  save(): Promise<void>;
}

const ADA = "000000000000000000000001";
const ROOT = "000000000000000000000002";
const BOLA = "000000000000000000000003";

const users: FakeUser[] = [];
const find = (id: unknown) => users.find((user) => user._id === String(id)) ?? null;

const User = {
  findOne(query: { email: string }) {
    const user = users.find((candidate) => candidate.email === query.email) ?? null;
    return { select: async () => user };
  },
  // Awaitable on its own, and also chainable with .select(), like a Mongoose query.
  findById(id: string) {
    const user = find(id);
    return Object.assign(Promise.resolve(user), { select: async () => user });
  },
  async exists(query: { _id: string }) {
    return find(query._id) ? { _id: query._id } : null;
  },
  async updateOne(filter: { _id: string }, update: { $set: Partial<FakeUser> }) {
    const user = find(filter._id);
    if (user) Object.assign(user, update.$set);
    return { matchedCount: user ? 1 : 0 };
  },
  async findByIdAndUpdate(id: string, update: { $set: Partial<FakeUser> }) {
    const user = find(id);
    if (user) Object.assign(user, update.$set);
    return user;
  },
};

const refreshStore = createFakeRefreshModel();

mock.module(new URL("../models/user.model.js", import.meta.url).href, {
  namedExports: { User },
});
mock.module(new URL("../models/refresh-token.model.js", import.meta.url).href, {
  namedExports: { RefreshToken: refreshStore.model },
});

const { resetRateLimits } = await import("../services/rate-limit.js");
const { hashPassword } = await import("../services/password.js");
const { default: authRoutes } = await import("../routes/auth.routes.js");
const { default: usersRoutes } = await import("../routes/users.routes.js");
const { default: internalRoutes } = await import("../routes/internal.routes.js");
const { internalAuth } = await import("../middleware/internal-auth.js");

let server: Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/auth", authRoutes);
  app.use("/users", usersRoutes);
  app.use("/internal", internalAuth, internalRoutes);

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

  for (const [id, name, email, role] of [
    [ADA, "Ada", "ada@example.com", "customer"],
    [ROOT, "Root", "root@example.com", "admin"],
    [BOLA, "Bola", "bola@example.com", "customer"],
  ] as const) {
    users.push({
      _id: id,
      name,
      email,
      passwordHash,
      role,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      save: async () => undefined,
    });
  }
});

interface Session {
  token: string;
  refreshToken: string;
  sid: string;
}

async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; internal?: boolean; cookie?: string } = {}
) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-requested-with": "fetch" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie !== undefined) headers.cookie = `refresh_token=${opts.cookie}`;
  if (opts.internal) headers["x-internal-token"] = "internal-secret";

  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = response.status === 204 ? "" : await response.text();

  const setCookie = response.headers.getSetCookie().find((line) => line.startsWith("refresh_token="));

  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as Record<string, any>,
    /** What the response put in the refresh cookie ("" = being cleared, undefined = untouched). */
    refreshToken: setCookie ? setCookie.split(";")[0]?.slice("refresh_token=".length) : undefined,
  };
}

async function signIn(email: string): Promise<Session> {
  const { status, body, refreshToken } = await call("POST", "/auth/login", { body: { email, password: PASSWORD } });
  assert.equal(status, 200);
  assert.ok(refreshToken);
  const sid = (jwt.decode(body.token) as jwt.JwtPayload).sid as string;
  return { token: body.token, refreshToken, sid };
}

const me = (session: Session) => call("GET", "/users/me", { token: session.token }).then((r) => r.status);
const sessionActive = (sid: string) =>
  call("GET", `/internal/sessions/${sid}`, { internal: true }).then((r) => r.body.active);

test("a session works until it is ended, then its access token is refused at once", async () => {
  const ada = await signIn("ada@example.com");

  assert.equal(await me(ada), 200);
  assert.equal(await sessionActive(ada.sid), true);

  await call("POST", "/auth/logout", { cookie: ada.refreshToken });

  // The JWT itself hasn't expired, but its session is over.
  assert.equal(await me(ada), 401);
  assert.equal(await sessionActive(ada.sid), false);
});

test("sign out of all devices ends every session of the account, and only that account's", async () => {
  const laptop = await signIn("ada@example.com");
  const phone = await signIn("ada@example.com");
  const bola = await signIn("bola@example.com");

  const out = await call("POST", "/users/me/logout-all", { token: laptop.token, cookie: laptop.refreshToken });
  assert.equal(out.status, 204);
  assert.equal(out.refreshToken, "", "this device's cookie is cleared too");

  assert.equal(await me(laptop), 401);
  assert.equal(await me(phone), 401);
  assert.equal(await me(bola), 200);
  assert.equal((await call("POST", "/auth/refresh", { cookie: phone.refreshToken })).status, 401);
});

test("an admin can force a user out; customers can't", async () => {
  const root = await signIn("root@example.com");
  const ada = await signIn("ada@example.com");
  const bola = await signIn("bola@example.com");

  assert.equal((await call("POST", `/users/${BOLA}/revoke-sessions`, { token: ada.token })).status, 403);
  assert.equal((await call("POST", `/users/${BOLA}/revoke-sessions`)).status, 401);

  assert.equal((await call("POST", `/users/${BOLA}/revoke-sessions`, { token: root.token })).status, 204);
  assert.equal(await me(bola), 401);
  assert.equal(await me(ada), 200, "other users are untouched");
  assert.equal(await me(root), 200, "so is the admin");

  assert.equal((await call("POST", "/users/nope/revoke-sessions", { token: root.token })).status, 404);
  assert.equal(
    (await call("POST", "/users/0000000000000000000000ff/revoke-sessions", { token: root.token })).status,
    404
  );
});

test("changing a password signs out other devices but keeps this one", async () => {
  const laptop = await signIn("ada@example.com");
  const phone = await signIn("ada@example.com");

  const changed = await call("POST", "/users/me/password", {
    token: laptop.token,
    cookie: laptop.refreshToken,
    body: { currentPassword: PASSWORD, newPassword: "a brand new password" },
  });

  assert.equal(changed.status, 204);
  assert.equal(changed.refreshToken, undefined, "this device's cookie is left alone");
  assert.equal(await me(phone), 401);
  assert.equal(await me(laptop), 200);
  assert.equal((await call("POST", "/auth/refresh", { cookie: laptop.refreshToken })).status, 200);
});

test("deactivating an account (by itself or by an admin) ends its sessions", async () => {
  const ada = await signIn("ada@example.com");
  const bola = await signIn("bola@example.com");
  const root = await signIn("root@example.com");

  const gone = await call("DELETE", "/users/me", { token: ada.token, cookie: ada.refreshToken });
  assert.equal(gone.status, 204);
  assert.equal(gone.refreshToken, "", "the cookie is cleared");
  assert.equal(await me(ada), 401);

  const patched = await call("PATCH", `/users/${BOLA}`, { token: root.token, body: { isActive: false } });
  assert.equal(patched.status, 200);
  assert.equal(await me(bola), 401);
  assert.equal((await call("POST", "/auth/refresh", { cookie: bola.refreshToken })).status, 401);
});

test("changing a role ends the user's sessions, so a demoted admin can't keep admin access", async () => {
  const root = await signIn("root@example.com");
  const bola = await signIn("bola@example.com");

  await call("PATCH", `/users/${BOLA}`, { token: root.token, body: { role: "admin" } });
  assert.equal(await me(bola), 401, "old token, old role: gone");

  const promoted = await signIn("bola@example.com");
  assert.equal((jwt.decode(promoted.token) as jwt.JwtPayload).role, "admin");

  await call("PATCH", `/users/${BOLA}`, { token: root.token, body: { role: "customer" } });
  assert.equal(await me(promoted), 401);
});

test("a token without a sid (issued before sessions existed) still works", async () => {
  const legacy = jwt.sign({ role: "customer" }, "test-secret", { subject: ADA, algorithm: "HS256" });

  assert.equal((await call("GET", "/users/me", { token: legacy })).status, 200);
});

test("the session endpoint is internal only", async () => {
  assert.equal((await call("GET", "/internal/sessions/abc")).status, 401);
  assert.equal((await call("GET", "/internal/sessions/abc", { internal: true })).status, 200);
  assert.equal((await call("GET", `/internal/sessions/${"x".repeat(101)}`, { internal: true })).status, 400);
});

test("a forged or malformed token is a 401, not a crash", async () => {
  const forged = jwt.sign({ role: "admin", sid: "x" }, "wrong-secret", { subject: ADA });

  assert.equal((await call("GET", "/users/me", { token: forged })).status, 401);
  assert.equal((await call("GET", "/users/me", { token: "garbage" })).status, 401);
  assert.equal((await call("GET", "/users/me")).status, 401);
});
