
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
