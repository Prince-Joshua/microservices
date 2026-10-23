import "dotenv/config";
import mongoose from "mongoose";

import { User } from "../models/user.model.js";
import { hashPassword } from "../services/password.js";

const { MONGO_URL, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME = "Admin" } =
  process.env;

if (!MONGO_URL || !ADMIN_EMAIL || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
  console.error(
    "Set MONGO_URL, ADMIN_EMAIL and ADMIN_PASSWORD (8+ characters) first."
  );
  process.exit(1);
}

await mongoose.connect(MONGO_URL);

const user = await User.findOneAndUpdate(
  { email: ADMIN_EMAIL.trim().toLowerCase() },
  {
    $set: {
      name: ADMIN_NAME,
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: "admin",
      isActive: true,
    },
  },
  { upsert: true, new: true, setDefaultsOnInsert: true }
);

console.log(`Admin ready: ${user.email} (id ${user._id})`);

await mongoose.disconnect();
