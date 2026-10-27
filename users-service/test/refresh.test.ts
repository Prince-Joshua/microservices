import { test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import jwt from "jsonwebtoken";

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
const { revokeAllForUser, hashToken } = await import("../services/refresh-tokens.js");

let server: Server;
let base: string;

before(async () => {
  const app = express();
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
  delete process.env.REFRESH_REUSE_GRACE_MS;
  delete process.env.REFRESH_TOKEN_TTL_DAYS;
  delete process.env.REFRESH_MAX_SESSION_DAYS;

  users.push({
    _id: "000000000000000000000001",
    name: "Ada",
    email: "ada@example.com",
    passwordHash: await hashPassword(PASSWORD),
    role: "customer",
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

async function post(path: string, body: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = response.status === 204 ? "" : await response.text();

  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as Record<string, any>,
  };
}

async function login() {
  const response = await post("/auth/login", { email: "ada@example.com", password: PASSWORD });
  assert.equal(response.status, 200);
  return response.body as { token: string; refreshToken: string; user: { id: string } };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function theUser(): FakeUser {
  const [user] = users;
  assert.ok(user);
  return user;
}

test("login returns a refresh token and stores only its hash", async () => {
  const { refreshToken } = await login();

  assert.ok(refreshToken.length >= 32);
  assert.equal(refreshStore.rows.length, 1);

  const [row] = refreshStore.rows;
  assert.ok(row);
  assert.equal(row.tokenHash, hashToken(refreshToken));
  assert.notEqual(row.tokenHash, refreshToken);
  assert.equal(JSON.stringify(refreshStore.rows).includes(refreshToken), false);
});

test("refresh: swaps the token for a new pair, and the chain keeps working", async () => {
  let current = (await login()).refreshToken;

  for (let i = 0; i < 3; i += 1) {
    const response = await post("/auth/refresh", { refreshToken: current });

    assert.equal(response.status, 200);
    assert.notEqual(response.body.refreshToken, current);
    assert.equal(response.body.user.email, "ada@example.com");

    const payload = jwt.verify(response.body.token, "test-secret", {
      algorithms: ["HS256"],
    }) as jwt.JwtPayload;
    assert.equal(payload.sub, theUser()._id);

    current = response.body.refreshToken as string;
  }

  // One session throughout.
  assert.equal(new Set(refreshStore.rows.map((row) => row.familyId)).size, 1);
});

test("refresh: the new access token carries the user's current role", async () => {
  const { refreshToken } = await login();
  theUser().role = "admin";

  const response = await post("/auth/refresh", { refreshToken });
  const payload = jwt.decode(response.body.token) as jwt.JwtPayload;

  assert.equal(payload.role, "admin");
  assert.equal(response.body.user.role, "admin");
});

test("a used token replayed after the grace window revokes the whole session", async () => {
  process.env.REFRESH_REUSE_GRACE_MS = "1";

  const first = (await login()).refreshToken;
  const second = (await post("/auth/refresh", { refreshToken: first })).body.refreshToken as string;

  await sleep(15);

  // Someone presents the already-used first token: theft is assumed.
  assert.equal((await post("/auth/refresh", { refreshToken: first })).status, 401);

  // So the newest token is dead too.
  assert.equal((await post("/auth/refresh", { refreshToken: second })).status, 401);
  assert.ok(refreshStore.rows.every((row) => row.revokedAt !== null));
});

test("two simultaneous refreshes: one wins, the session survives", async () => {
  process.env.REFRESH_REUSE_GRACE_MS = "10000";
  const { refreshToken } = await login();

  const [a, b] = await Promise.all([
    post("/auth/refresh", { refreshToken }),
    post("/auth/refresh", { refreshToken }),
  ]);

  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 401]);

  // The loser must not have killed the winner's new token.
  const winner = a.status === 200 ? a : b;
  assert.equal(
    (await post("/auth/refresh", { refreshToken: winner.body.refreshToken })).status,
    200
  );
});

test("an expired refresh token is rejected", async () => {
  const { refreshToken } = await login();
  const [row] = refreshStore.rows;
  assert.ok(row);
  row.expiresAt = new Date(Date.now() - 1000);

  assert.equal((await post("/auth/refresh", { refreshToken })).status, 401);
});

test("a session can't outlive REFRESH_MAX_SESSION_DAYS", async () => {
  process.env.REFRESH_TOKEN_TTL_DAYS = "30";
  process.env.REFRESH_MAX_SESSION_DAYS = "1";

  await login();
  const [row] = refreshStore.rows;
  assert.ok(row);

  const lifetime = row.expiresAt.getTime() - row.sessionStartedAt.getTime();
  assert.ok(lifetime <= 86_400_000, `lifetime ${lifetime}`);
});

test("a deactivated account can't refresh, and its session is revoked", async () => {
  const { refreshToken } = await login();
  theUser().isActive = false;

  assert.equal((await post("/auth/refresh", { refreshToken })).status, 401);
  assert.ok(refreshStore.rows.every((row) => row.revokedAt !== null));
});

test("missing, malformed and oversized tokens get a 401, never a crash", async () => {
  for (const body of [{}, { refreshToken: "" }, { refreshToken: 42 }, { refreshToken: null }, { refreshToken: "nope" }, { refreshToken: "x".repeat(500) }]) {
    assert.equal((await post("/auth/refresh", body)).status, 401, JSON.stringify(body).slice(0, 60));
  }
});

test("logout revokes the session; unknown tokens are harmless", async () => {
  const { refreshToken } = await login();

  assert.equal((await post("/auth/logout", { refreshToken })).status, 204);
  assert.equal((await post("/auth/refresh", { refreshToken })).status, 401);

  assert.equal((await post("/auth/logout", { refreshToken: "garbage" })).status, 204);
  assert.equal((await post("/auth/logout", {})).status, 204);
});

test("revokeAllForUser signs out every session except the one named", async () => {
  const laptop = (await login()).refreshToken;
  const phone = (await login()).refreshToken;

  await revokeAllForUser(theUser()._id, laptop);

  assert.equal((await post("/auth/refresh", { refreshToken: phone })).status, 401);
  assert.equal((await post("/auth/refresh", { refreshToken: laptop })).status, 200);
});

test("revokeAllForUser without a token signs out everything", async () => {
  const laptop = (await login()).refreshToken;
  const phone = (await login()).refreshToken;

  await revokeAllForUser(theUser()._id);

  assert.equal((await post("/auth/refresh", { refreshToken: laptop })).status, 401);
  assert.equal((await post("/auth/refresh", { refreshToken: phone })).status, 401);
});

test("revokeAllForUser ignores a token that belongs to someone else", async () => {
  const mine = (await login()).refreshToken;

  // A different user asks to keep *my* session alive: that must not spare it.
  await revokeAllForUser("000000000000000000000002", mine);
  assert.equal((await post("/auth/refresh", { refreshToken: mine })).status, 200);

  await revokeAllForUser(theUser()._id, undefined);
  assert.ok(refreshStore.rows.every((row) => row.revokedAt !== null));
});
