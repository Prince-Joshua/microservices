export interface RemoteUser {
  id: string;
  isActive: boolean;
  role: "customer" | "admin";
}

/**
 * Asks the Users service about one account. Resolves to null when the account
 * doesn't exist; anything unexpected (network error, timeout, non-200,
 * malformed body) throws, so "could not check" is never mistaken for an answer.
 */
export async function getUser(userId: string): Promise<RemoteUser | null> {
  const baseUrl = process.env.USERS_SERVICE_URL;

  if (!baseUrl) {
    throw new Error("Missing USERS_SERVICE_URL");
  }

  const response = await fetch(
    `${baseUrl}/internal/users/${encodeURIComponent(userId)}`,
    {
      headers: { "x-internal-token": process.env.INTERNAL_API_TOKEN ?? "" },
      signal: AbortSignal.timeout(Number(process.env.HTTP_TIMEOUT_MS) || 3000),
    }
  );

  if (response.status === 404 || response.status === 400) {
    return null;
  }

  if (response.status !== 200) {
    throw new Error(`Users service returned ${response.status}`);
  }

  const body = (await response.json()) as {
    id?: unknown;
    isActive?: unknown;
    role?: unknown;
  } | null;

  if (
    typeof body?.id !== "string" ||
    typeof body.isActive !== "boolean" ||
    (body.role !== "customer" && body.role !== "admin")
  ) {
    throw new Error("Users service returned an unexpected body");
  }

  return { id: body.id, isActive: body.isActive, role: body.role };
}
