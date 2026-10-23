import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Paystack signs every webhook: the x-paystack-signature header is the
 * hex HMAC-SHA512 of the RAW request body, keyed with your secret key.
 * It must be computed over the exact bytes received, not re-serialized JSON.
 */
export function verifySignature(
  rawBody: unknown,
  header: unknown,
  secret: string | undefined
): boolean {
  if (!secret || !Buffer.isBuffer(rawBody) || typeof header !== "string") {
    return false;
  }

  const expected = createHmac("sha512", secret).update(rawBody).digest();

  let provided: Buffer;

  try {
    provided = Buffer.from(header, "hex");
  } catch {
    return false;
  }

  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
