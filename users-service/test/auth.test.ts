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

// An in-memory User model: only what the auth routes touch.
const users: FakeUser[] = [];

const User = {
  async create(data: { name: string; email: string; passwordHash: string }) {
    const email = data.email.trim().toLowerCase();

    if (users.some((user) => user.email === email)) {
      const error = new Error("duplicate key") as Error & { code: number };
      error.code = 11000;
      throw error;
    }

    const user: FakeUser = {
      _id: String(users.length + 1).padStart(24, "0"),
      name: data.name.trim(),
      email,
      passwordHash: data.passwordHash,
      role: "customer",
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    users.push(user);
    return user;
  },

  findOne(query: { email: string }) {
    const user = users.find((candidate) => candidate.email === query.email) ?? null;
    return { select: async () => user };
  },
};

mock.module(new URL("../models/user.model.js", import.meta.url).href, {
  namedExports: { User },
});

// Login now also stores a refresh token; keep that in memory too.
const refreshStore = createFakeRefreshModel();

mock.module(new URL("../models/refresh-token.model.js", import.meta.url).href, {
  namedExports: { RefreshToken: refreshStore.model },
});

const { hashPassword, verifyPassword } = await import("../services/password.js");
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

after(() => {
  server.close();
});

beforeEach(() => {
  users.length = 0;
  refreshStore.rows.length = 0;
});

async function post(path: string, body: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  };
}

function firstUser(): FakeUser {
  const [user] = users;
  assert.ok(user, "expected a registered user");
  return user;
}

const valid = { name: "Ada", email: "Ada@Example.com", password: "correct horse" };

test("password hashing: verifies the right password, rejects others, salts each hash", async () => {
  const one = await hashPassword("s3cret-pass");
  const two = await hashPassword("s3cret-pass");

  assert.notEqual(one, two);
  assert.equal(await verifyPassword("s3cret-pass", one), true);
  assert.equal(await verifyPassword("wrong-pass", one), false);
  assert.equal(await verifyPassword("s3cret-pass", "garbage"), false);
  assert.equal(await verifyPassword("s3cret-pass", undefined), false);
});

test("register: validates input", async () => {
  for (const body of [
    {},
    { ...valid, name: "" },
    { ...valid, email: "not-an-email" },
    { ...valid, password: "short" },
    { ...valid, password: "x".repeat(129) },
  ]) {
    assert.equal((await post("/auth/register", body)).status, 400);
  }
});

test("register: creates a customer and never returns the password hash", async () => {
  const response = await post("/auth/register", valid);

  assert.equal(response.status, 201);
  assert.equal(response.body.email, "ada@example.com");
  assert.equal(response.body.role, "customer");
  assert.equal("passwordHash" in response.body, false);
  assert.match(firstUser().passwordHash, /^[0-9a-f]+:[0-9a-f]+$/);
  assert.notEqual(firstUser().passwordHash, valid.password);
});

test("register: duplicate email is a 409", async () => {
  await post("/auth/register", valid);
  const again = await post("/auth/register", { ...valid, email: "ada@example.com" });

  assert.equal(again.status, 409);
});

test("login: issues an HS256 JWT carrying subject and role", async () => {
  await post("/auth/register", valid);
  const response = await post("/auth/login", {
    email: " ADA@example.com ",
    password: valid.password,
  });

  assert.equal(response.status, 200);

  const payload = jwt.verify(response.body.token as string, "test-secret", {
    algorithms: ["HS256"],
  }) as jwt.JwtPayload;

  assert.equal(payload.sub, firstUser()._id);
  assert.equal(payload.role, "customer");
  assert.ok((payload.exp ?? 0) > (payload.iat ?? 0));
  assert.equal("passwordHash" in response.body.user, false);
});

test("login: wrong password, unknown email and deactivated accounts all look the same", async () => {
  await post("/auth/register", valid);

  const wrongPassword = await post("/auth/login", {
    email: valid.email,
    password: "not the password",
  });
  const unknownEmail = await post("/auth/login", {
    email: "nobody@example.com",
    password: valid.password,
  });

  firstUser().isActive = false;
  const deactivated = await post("/auth/login", {
    email: valid.email,
    password: valid.password,
  });

  for (const response of [wrongPassword, unknownEmail, deactivated]) {
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { message: "Invalid credentials" });
  }
});
