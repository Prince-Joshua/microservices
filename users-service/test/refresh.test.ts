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
  delete process.env.ALLOWED_ORIGINS;

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

interface Reply {
  status: number;
  body: Record<string, any>;
  /** The Set-Cookie header for the refresh cookie, if the response had one. */
  setCookie: string | undefined;
  /** The refresh token in that cookie ("" when it is being cleared). */
  refreshToken: string | undefined;
}

async function post(
  path: string,
  { token, csrf = true, body, origin }: { token?: string; csrf?: boolean; body?: unknown; origin?: string } = {}
): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json" };

  if (token !== undefined) headers.cookie = `refresh_token=${token}`;
  if (csrf) headers["x-requested-with"] = "fetch";
  if (origin) headers.origin = origin;

  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  const text = response.status === 204 ? "" : await response.text();
  const setCookie = response.headers
    .getSetCookie()
    .find((line) => line.startsWith("refresh_token="));

  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as Record<string, any>,
    setCookie,
    refreshToken: setCookie ? setCookie.split(";")[0]?.slice("refresh_token=".length) : undefined,
  };
}

const refresh = (token?: string) => post("/auth/refresh", { token });
const logout = (token?: string, csrf = true) => post("/auth/logout", { token, csrf });

async function login() {
  const response = await post("/auth/login", {
    body: { email: "ada@example.com", password: PASSWORD },
  });
  assert.equal(response.status, 200);
  assert.ok(response.refreshToken);
  return { ...response, refreshToken: response.refreshToken };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function theUser(): FakeUser {
  const [user] = users;
  assert.ok(user);
  return user;
}

test("login sets the refresh token as a cookie, not in the body, and stores only its hash", async () => {
  const { refreshToken, body, setCookie } = await login();

  assert.equal("refreshToken" in body, false);
  assert.equal(JSON.stringify(body).includes(refreshToken), false);
  assert.ok(typeof body.token === "string");
  assert.ok(setCookie);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Path=\/api\/users(;|$)/i);
  assert.match(setCookie, /Expires=/i);
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
    const response = await refresh(current);

    assert.equal(response.status, 200);
    assert.equal("refreshToken" in response.body, false);
    assert.ok(response.refreshToken);
    assert.notEqual(response.refreshToken, current);
    assert.equal(response.body.user.email, "ada@example.com");

    const payload = jwt.verify(response.body.token, "test-secret", {
      algorithms: ["HS256"],
    }) as jwt.JwtPayload;
    assert.equal(payload.sub, theUser()._id);

    current = response.refreshToken;
  }

  // One session throughout.
  assert.equal(new Set(refreshStore.rows.map((row) => row.familyId)).size, 1);
});

test("refresh: the new access token carries the user's current role", async () => {
  const { refreshToken } = await login();
  theUser().role = "admin";

  const response = await refresh(refreshToken);
  const payload = jwt.decode(response.body.token) as jwt.JwtPayload;

  assert.equal(payload.role, "admin");
  assert.equal(response.body.user.role, "admin");
});

test("a used token replayed after the grace window revokes the whole session", async () => {
  process.env.REFRESH_REUSE_GRACE_MS = "1";

  const first = (await login()).refreshToken;
  const second = (await refresh(first)).refreshToken;
  assert.ok(second);

  await sleep(15);

  // Someone presents the already-used first token: theft is assumed.
  assert.equal((await refresh(first)).status, 401);

  // So the newest token is dead too.
  assert.equal((await refresh(second)).status, 401);
  assert.ok(refreshStore.rows.every((row) => row.revokedAt !== null));
});

test("two simultaneous refreshes: one wins, the session survives", async () => {
  process.env.REFRESH_REUSE_GRACE_MS = "10000";
  const { refreshToken } = await login();

  const [a, b] = await Promise.all([refresh(refreshToken), refresh(refreshToken)]);

  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 401]);

  // The loser must not have killed the winner's new token, nor clear its cookie.
  const winner = a.status === 200 ? a : b;
  const loser = a.status === 200 ? b : a;
  assert.equal(loser.setCookie, undefined);
  assert.equal((await refresh(winner.refreshToken)).status, 200);
});

test("an expired refresh token is rejected", async () => {
  const { refreshToken } = await login();
  const [row] = refreshStore.rows;
  assert.ok(row);
  row.expiresAt = new Date(Date.now() - 1000);

  assert.equal((await refresh(refreshToken)).status, 401);
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

  const response = await refresh(refreshToken);

  assert.equal(response.status, 401);
  assert.equal(response.refreshToken, ""); // cookie cleared
  assert.ok(refreshStore.rows.every((row) => row.revokedAt !== null));
});

test("missing, malformed and oversized cookies get a 401, never a crash", async () => {
  for (const token of [undefined, "", "nope", "x".repeat(500)]) {
    assert.equal((await refresh(token)).status, 401, String(token).slice(0, 20));
  }

  // A cookie that isn't valid percent-encoding must not throw either.
  assert.equal((await refresh("%E0%A4%A")).status, 401);
});

test("refresh and logout need the custom header, and a body token is ignored", async () => {
  const { refreshToken } = await login();

  assert.equal((await post("/auth/refresh", { token: refreshToken, csrf: false })).status, 403);
  assert.equal((await logout(refreshToken, false)).status, 403);

  // Nothing was consumed or revoked by the refused calls.
  assert.ok(refreshStore.rows.every((row) => row.revokedAt === null));

  // The old body field no longer works: only the cookie counts.
  assert.equal((await post("/auth/refresh", { body: { refreshToken } })).status, 401);
  assert.equal((await refresh(refreshToken)).status, 200);
});

test("with ALLOWED_ORIGINS set, other origins are refused on refresh and logout", async () => {
  process.env.ALLOWED_ORIGINS = "https://shop.example.com/, http://localhost:3000";
  const { refreshToken } = await login();

  for (const origin of ["https://evil.example", "null", "https://shop.example.com.evil.example"]) {
    assert.equal((await post("/auth/refresh", { token: refreshToken, origin })).status, 403, origin);
    assert.equal((await post("/auth/logout", { token: refreshToken, origin })).status, 403, origin);
  }

  // Nothing was consumed by the refused calls; listed origins (any case or trailing slash) and no Origin pass.
  assert.ok(refreshStore.rows.every((row) => row.revokedAt === null));
  const ok = await post("/auth/refresh", { token: refreshToken, origin: "https://SHOP.example.com/" });
  assert.equal(ok.status, 200);
  assert.ok(ok.refreshToken);
  assert.equal((await post("/auth/refresh", { token: ok.refreshToken, origin: "http://localhost:3000" })).status, 200);
});

test("logout revokes the session and clears the cookie; unknown tokens are harmless", async () => {
  const { refreshToken } = await login();

  const out = await logout(refreshToken);
  assert.equal(out.status, 204);
  assert.equal(out.refreshToken, "");
  assert.match(out.setCookie ?? "", /Expires=Thu, 01 Jan 1970/i);
  assert.equal((await refresh(refreshToken)).status, 401);

  assert.equal((await logout("garbage")).status, 204);
  assert.equal((await logout()).status, 204);
});

test("revokeAllForUser signs out every session except the one named", async () => {
  const laptop = (await login()).refreshToken;
  const phone = (await login()).refreshToken;

  await revokeAllForUser(theUser()._id, laptop);

  assert.equal((await refresh(phone)).status, 401);
  assert.equal((await refresh(laptop)).status, 200);
});

test("revokeAllForUser without a token signs out everything", async () => {
  const laptop = (await login()).refreshToken;
  const phone = (await login()).refreshToken;

  await revokeAllForUser(theUser()._id);

  assert.equal((await refresh(laptop)).status, 401);
  assert.equal((await refresh(phone)).status, 401);
});

test("revokeAllForUser ignores a token that belongs to someone else", async () => {
  const mine = (await login()).refreshToken;

  // A different user asks to keep *my* session alive: that must not spare it.
  await revokeAllForUser("000000000000000000000002", mine);
  assert.equal((await refresh(mine)).status, 200);

  await revokeAllForUser(theUser()._id, undefined);
  assert.ok(refreshStore.rows.every((row) => row.revokedAt !== null));
});
