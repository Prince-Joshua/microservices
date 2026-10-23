import mongoose from "mongoose";

export async function connectDatabase(): Promise<void> {
  if (!process.env.MONGO_URL) {
    throw new Error("Missing MONGO_URL");
  }

  await mongoose.connect(process.env.MONGO_URL);
  console.log("Products MongoDB connected");
}
