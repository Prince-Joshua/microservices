import "dotenv/config";
import mongoose from "mongoose";

import { User } from "../models/user.model.js";
import { hashPassword } from "../services/password.js";
import { assertSafeToSeed, seedUsers, type UserUpserter } from "./seed-lib.js";

try {
  assertSafeToSeed();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

try {
  await mongoose.connect(String(process.env.MONGO_URL), {
    serverSelectionTimeoutMS: 5000,
  });

  // Build the unique email index first so a duplicate can't slip in.
  await User.init();

  // The model satisfies UserUpserter at runtime; Mongoose's overloaded
  // signatures are too broad for TypeScript to see that.
  const users = await seedUsers({
    User: User as unknown as UserUpserter,
    hashPassword,
  });

  console.log(`Seeded ${users.length} users (safe to re-run):\n`);
  console.table(users);
  console.log(
    "\nThese passwords are for development only. Log in at POST /auth/login."
  );
} catch (error) {
  console.error("Seeding failed:", (error as Error).message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
