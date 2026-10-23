export type ReservationStatus =
  | "NOT_FOUND"
  | "PENDING"
  | "AWAITING_PAYMENT"
  | "CONFIRMED"
  | "FULFILLED"
  | "CANCELLED"
  | "FAILED";

const KNOWN_STATUSES = new Set<string>([
  "NOT_FOUND",
  "PENDING",
  "AWAITING_PAYMENT",
  "CONFIRMED",
  "FULFILLED",
  "CANCELLED",
  "FAILED",
]);

/**
 * Asks the Orders service what became of a reservation. Resolves to the
 * order's status, or "NOT_FOUND" when no order carries that reservation.
 *
 * Anything unexpected (network error, timeout, non-200, unknown status)
 * throws, so the caller can never mistake "could not check" for an
 * answer and release stock for a sale that actually happened.
 */
export async function getReservationStatus(
  reservationId: string
): Promise<ReservationStatus> {
  const baseUrl = process.env.ORDERS_SERVICE_URL;

  if (!baseUrl) {
    throw new Error("Missing ORDERS_SERVICE_URL");
  }

  const response = await fetch(
    `${baseUrl}/internal/reservations/${encodeURIComponent(reservationId)}`,
    {
      headers: { "x-internal-token": process.env.INTERNAL_API_TOKEN ?? "" },
      signal: AbortSignal.timeout(
        Number(process.env.HTTP_TIMEOUT_MS) || 3000
      ),
    }
  );

  if (response.status !== 200) {
    throw new Error(`Orders service returned ${response.status}`);
  }

  const body: unknown = await response.json();
  const status = (body as { status?: unknown } | null)?.status;

  if (typeof status !== "string" || !KNOWN_STATUSES.has(status)) {
    throw new Error("Orders service returned an unexpected body");
  }

  return status as ReservationStatus;
}
