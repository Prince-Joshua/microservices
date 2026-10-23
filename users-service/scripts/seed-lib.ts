import type { UserRole } from "../models/user.model.js";

/**
 * Sample data for local development and testing.
 *
 * These accounts have KNOWN passwords, so seeding must never reach a real
 * database. assertSafeToSeed() enforces that; seed.ts calls it first.
 */

export const ADMIN_PASSWORD = "admin-password-123";
export const CUSTOMER_PASSWORD = "password123";

export interface SeedUser {
  name: string;
  email: string;
  password: string;
  role: UserRole;
}

export const SEED_USERS: readonly SeedUser[] = [
  {
    name: "Admin",
    email: "admin@example.com",
    password: ADMIN_PASSWORD,
    role: "admin",
  },
  {
    name: "Ada Lovelace",
    email: "ada@example.com",
    password: CUSTOMER_PASSWORD,
    role: "customer",
  },
  {
    name: "Grace Hopper",
    email: "grace@example.com",
    password: CUSTOMER_PASSWORD,
    role: "customer",
  },
  {
    name: "Alan Turing",
    email: "alan@example.com",
    password: CUSTOMER_PASSWORD,
    role: "customer",
  },
];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface SeedEnv {
  NODE_ENV?: string | undefined;
  MONGO_URL?: string | undefined;
  SEED_ALLOW_REMOTE?: string | undefined;
}

/**
 * Throws unless it is clearly safe to write sample accounts:
 *   - never when NODE_ENV=production
 *   - only against a local database, unless SEED_ALLOW_REMOTE=true
 */
export function assertSafeToSeed(env: SeedEnv = process.env): void {
  if (env.NODE_ENV === "production") {
    throw new Error("Refusing to seed: NODE_ENV is production.");
  }

  if (!env.MONGO_URL) {
    throw new Error("Missing MONGO_URL.");
  }

  let host: string | null = null;

  try {
    host = new URL(env.MONGO_URL).hostname;
  } catch {
    // multi-host or unparseable connection strings count as remote
  }

  if (
    (host === null || !LOCAL_HOSTS.has(host)) &&
    env.SEED_ALLOW_REMOTE !== "true"
  ) {
    throw new Error(
      `Refusing to seed a non-local database (${host ?? "unrecognised host"}). ` +
        "Sample accounts have known passwords. Set SEED_ALLOW_REMOTE=true only if this is a throwaway database."
    );
  }
}

/** The one Mongoose model method the seed needs. */
export interface UserUpserter {
  findOneAndUpdate(
    filter: { email: string },
    update: {
      $set: {
        name: string;
        passwordHash: string;
        role: UserRole;
        isActive: boolean;
      };
    },
    options: { upsert: true; new: true; setDefaultsOnInsert: true }
  ): PromiseLike<{ _id: unknown } | null>;
}

export interface SeededUser {
  id: string;
  email: string;
  role: UserRole;
  password: string;
}

/**
 * Create or refresh every sample user. Safe to run repeatedly: users are
 * matched by email, so nothing is duplicated, and passwords/roles are
 * reset to the documented values.
 */
export async function seedUsers({
  User,
  hashPassword,
}: {
  User: UserUpserter;
  hashPassword: (password: string) => Promise<string>;
}): Promise<SeededUser[]> {
  const results: SeededUser[] = [];

  for (const user of SEED_USERS) {
    const doc = await User.findOneAndUpdate(
      { email: user.email },
      {
        $set: {
          name: user.name,
          passwordHash: await hashPassword(user.password),
          role: user.role,
          isActive: true,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    if (!doc) {
      throw new Error(`Upsert returned nothing for ${user.email}`);
    }

    results.push({
      id: String(doc._id),
      email: user.email,
      role: user.role,
      password: user.password,
    });
  }

  return results;
}
