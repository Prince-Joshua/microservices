import { OrderError } from "../errors.js";
import { request } from "./http.js";

/**
 * Returns { id, isActive, email }, or null when the user doesn't exist
 * (or the ID isn't one the Users service recognizes).
 */
export interface RemoteUser {
  id: string;
  isActive: boolean;
  email?: string;
}

export async function getUser(userId: string): Promise<RemoteUser | null> {
  const { status, data } = await request(
    "Users service",
    `${process.env.USERS_SERVICE_URL}/internal/users/${encodeURIComponent(userId)}`
  );

  if (status === 200 && typeof data?.isActive === "boolean") {
    return data;
  }

  if (status === 404 || status === 400) {
    return null;
  }

  throw new OrderError("Unexpected response from Users service", 502);
}
