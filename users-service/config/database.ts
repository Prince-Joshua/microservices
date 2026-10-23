import mongoose from "mongoose";

export async function connectDatabase(): Promise<void> {
  const url = process.env.MONGO_URL;

  if (!url) {
    throw new Error("Missing MONGO_URL");
  }

  await mongoose.connect(url);
  console.log("Users MongoDB connected");
}
