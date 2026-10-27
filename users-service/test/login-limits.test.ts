import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";

import { createFakeRefreshModel } from "./helpers/refresh-store.js";

process.env.JWT_SECRET = "test-secret";
// Small limits so the tests stay quick. Set before the routes are imported.
process.env.RATE_LIMIT_LOGIN_IP_MAX = "50";
process.env.RATE_LIMIT_LOGIN_FAILS_MAX = "3";
process.env.RATE_LIMIT_REFRESH_MAX = "4";
process.env.RATE_LIMIT_REGISTER_MAX = "2";

const { hashPassword } = await import("../services/password.js");
const goodHash = await hashPassword("correct-horse");

const makeUser = (n: number, name: string) => ({
  _id: String(n).padStart(24, "0"),
  name,
  email: `${name.toLowerCase()}@example.com`,
  passwordHash: goodHash,
  role: "customer" as const,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const accounts = [makeUser(1, "Ann"), makeUser(2, "Bob")];
const user = accounts[0];

const User = {
  async create(data: { email: string }) {
    return { ...user, email: data.email };
  },
  findOne(query: { email: string }) {
    const found = accounts.find((a) => a.email === query.email) ?? null;
    return { select: async () => found };
  },
  async findById() {
    return user;
  },
};

mock.module(new URL("../models/user.model.js", import.meta.url).href, {
  namedExports: { User },
});

const refreshStore = createFakeRefreshModel();

mock.module(new URL("../models/refresh-token.model.js", import.meta.url).href, {
  namedExports: { RefreshToken: refreshStore.model },
});

const { default: authRoutes } = await import("../routes/auth.routes.js");

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

after(() => server.close());

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("repeated wrong passwords lock the account, even for the right password", async () => {
  const email = "ann@example.com";

  for (let i = 0; i < 3; i++) {
    assert.equal((await post("/auth/login", { email, password: "nope-nope" })).status, 401);
  }

  const locked = await post("/auth/login", { email, password: "correct-horse" });
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get("retry-after")) > 0);
  assert.match(((await locked.json()) as { message: string }).message, /Try again in/);
});

test("the lock covers emails that don't exist the same way (no account enumeration)", async () => {
  const email = "ghost@example.com";

  for (let i = 0; i < 3; i++) {
    assert.equal((await post("/auth/login", { email, password: "whatever1" })).status, 401);
  }

  assert.equal((await post("/auth/login", { email, password: "whatever1" })).status, 429);
});

test("a successful login resets the failure count", async () => {
  const email = "bob@example.com";
  const wrong = () => post("/auth/login", { email, password: "nope-nope" });

  assert.equal((await wrong()).status, 401);
  assert.equal((await wrong()).status, 401);
  assert.equal((await post("/auth/login", { email, password: "correct-horse" })).status, 200);

  // Without the reset the next wrong guess would be the 3rd and the one after would be locked.
  assert.equal((await wrong()).status, 401);
  assert.equal((await wrong()).status, 401);
  assert.equal((await wrong()).status, 401);
  assert.equal((await wrong()).status, 429);
});

test("refresh is limited per address", async () => {
  const statuses: number[] = [];

  for (let i = 0; i < 6; i++) {
    statuses.push((await post("/auth/refresh", { refreshToken: "nope" })).status);
  }

  assert.deepEqual(statuses, [401, 401, 401, 401, 429, 429]);
});

test("registration is limited per address", async () => {
  const body = (n: number) => ({
    name: "New",
    email: `new${n}@example.com`,
    password: "long-enough-1",
  });

  assert.equal((await post("/auth/register", body(1))).status, 201);
  assert.equal((await post("/auth/register", body(2))).status, 201);
  assert.equal((await post("/auth/register", body(3))).status, 429);
});
