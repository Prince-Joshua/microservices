/**
 * Tells the Orders service that a payment succeeded.
 *
 * Resolves to { accepted: true } or { accepted: false, reason }. A
 * rejection means "this money doesn't belong to a live order": the order
 * was cancelled or expired, was already paid by another attempt, or the
 * amount was wrong. The caller refunds in that case.
 *
 * Anything unexpected (network error, timeout, non-200, bad body) THROWS,
 * so "couldn't ask" is never mistaken for an answer and the customer is
 * never refunded for an order that was in fact confirmed.
 */
export interface PaymentSucceededInput {
  orderId: string;
  reference: string;
  amount: number;
  currency: string;
}

export interface PaymentSucceededAnswer {
  accepted: boolean;
  reason?: string | undefined;
}

export async function notifyPaymentSucceeded({
  orderId,
  reference,
  amount,
  currency,
}: PaymentSucceededInput): Promise<PaymentSucceededAnswer> {
  const baseUrl = process.env.ORDERS_SERVICE_URL;

  if (!baseUrl) {
    throw new Error("Missing ORDERS_SERVICE_URL");
  }

  const response = await fetch(
    `${baseUrl}/internal/orders/${encodeURIComponent(orderId)}/payment-succeeded`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-token": process.env.INTERNAL_API_TOKEN ?? "",
      },
      body: JSON.stringify({ reference, amount, currency }),
      signal: AbortSignal.timeout(Number(process.env.HTTP_TIMEOUT_MS) || 8000),
    }
  );

  if (response.status !== 200) {
    throw new Error(`Orders service returned ${response.status}`);
  }

  const body = (await response.json()) as { accepted?: unknown; reason?: unknown } | null;

  if (typeof body?.accepted !== "boolean") {
    throw new Error("Orders service returned an unexpected body");
  }

  return {
    accepted: body.accepted,
    reason: typeof body.reason === "string" ? body.reason : undefined,
  };
}
