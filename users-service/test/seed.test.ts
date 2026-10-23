import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SEED_USERS,
  assertSafeToSeed,
  seedUsers,
  type UserUpserter,
} from "../scripts/seed-lib.js";
import { hashPassword, verifyPassword } from "../services/password.js";

interface FakeUserDoc {
  _id: string;
  email: string;
  name?: string;
  passwordHash?: string;
  role?: string;
  isActive?: boolean;
}

// Just enough of a Mongoose model for an upsert-by-email.
function fakeUserModel(): UserUpserter & { docs: FakeUserDoc[] } {
  const docs: FakeUserDoc[] = [];

  return {
    docs,
    async findOneAndUpdate(filter, update, options) {
      assert.equal(options.upsert, true);
      assert.deepEqual(Object.keys(filter), ["email"], "matched by email only");

      let doc = docs.find((candidate) => candidate.email === filter.email);

      if (!doc) {
        doc = { _id: `id-${docs.length + 1}`, email: filter.email };
        docs.push(doc);
      }

      Object.assign(doc, update.$set);
      return doc;
    },
  };
}

function docFor(User: { docs: FakeUserDoc[] }, email: string): FakeUserDoc {
  const doc = User.docs.find((candidate) => candidate.email === email);
  assert.ok(doc, `expected a seeded user for ${email}`);
  return doc;
}

test("guard: refuses production, remote databases and a missing URL", () => {
  const local = "mongodb://localhost:27017/users";

  assert.doesNotThrow(() => assertSafeToSeed({ MONGO_URL: local }));
  assert.doesNotThrow(() => assertSafeToSeed({ MONGO_URL: "mongodb://127.0.0.1:27017/users" }));

  assert.throws(() => assertSafeToSeed({ MONGO_URL: local, NODE_ENV: "production" }), /production/);
  assert.throws(() => assertSafeToSeed({}), /MONGO_URL/);
  assert.throws(
    () => assertSafeToSeed({ MONGO_URL: "mongodb+srv://user:pw@cluster0.abcde.mongodb.net/users" }),
    /non-local/
  );
  assert.throws(
    () => assertSafeToSeed({ MONGO_URL: "mongodb://db1.example.com:27017,db2.example.com:27017/users" }),
    /non-local|unrecognised/
  );
});

test("guard: a remote throwaway database needs an explicit opt-in, but production never passes", () => {
  const remote = "mongodb://db.staging.example.com:27017/users";

  assert.doesNotThrow(() => assertSafeToSeed({ MONGO_URL: remote, SEED_ALLOW_REMOTE: "true" }));
  assert.throws(
    () => assertSafeToSeed({ MONGO_URL: remote, SEED_ALLOW_REMOTE: "true", NODE_ENV: "production" }),
    /production/
  );
  assert.throws(() => assertSafeToSeed({ MONGO_URL: remote, SEED_ALLOW_REMOTE: "yes" }), /non-local/);
});

test("data: valid, unique emails, passwords the API will accept, exactly one kind of admin", () => {
  assert.equal(new Set(SEED_USERS.map((user) => user.email)).size, SEED_USERS.length);

  for (const user of SEED_USERS) {
    assert.match(user.email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    assert.equal(user.email, user.email.toLowerCase());
    assert.ok(user.password.length >= 8 && user.password.length <= 128, user.email);
    assert.ok(["admin", "customer"].includes(user.role));
  }

  assert.ok(SEED_USERS.some((user) => user.role === "admin"));
  assert.ok(SEED_USERS.some((user) => user.role === "customer"));
});

test("seeding creates every user with a password that really verifies, and is idempotent", async () => {
  const User = fakeUserModel();

  const first = await seedUsers({ User, hashPassword });
  assert.equal(first.length, SEED_USERS.length);
  assert.equal(User.docs.length, SEED_USERS.length);

  for (const seeded of SEED_USERS) {
    const doc = docFor(User, seeded.email);

    assert.equal(doc.role, seeded.role);
    assert.equal(doc.isActive, true);
    assert.notEqual(doc.passwordHash, seeded.password, "stored hashed, not in plain text");
    assert.equal(await verifyPassword(seeded.password, doc.passwordHash), true);
  }

  // A second run changes nothing but the (re-salted) hashes.
  const ids = User.docs.map((doc) => doc._id);
  await seedUsers({ User, hashPassword });

  assert.equal(User.docs.length, SEED_USERS.length, "no duplicates");
  assert.deepEqual(User.docs.map((doc) => doc._id), ids);
});

test("re-seeding repairs a tampered account (demoted admin, deactivated, changed password)", async () => {
  const User = fakeUserModel();
  await seedUsers({ User, hashPassword });

  const admin = docFor(User, "admin@example.com");
  Object.assign(admin, { role: "customer", isActive: false, passwordHash: "x:y" });

  await seedUsers({ User, hashPassword });

  assert.equal(admin.role, "admin");
  assert.equal(admin.isActive, true);
  assert.equal(await verifyPassword("admin-password-123", admin.passwordHash), true);
});
