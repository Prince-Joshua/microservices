/**
 * "24", "24.5" or "24.00" (a Postgres NUMERIC rendered as text) -> 2400
 * minor units, without ever passing through floating point.
 */
export function toMinorUnits(amount: { toString(): string } | string | number): number {
  const text = String(amount).trim();

  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`Not a money amount: ${text}`);
  }

  const [whole, fraction = ""] = text.split(".");
  const minor = Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));

  if (!Number.isSafeInteger(minor)) {
    throw new Error(`Amount too large: ${text}`);
  }

  return minor;
}
