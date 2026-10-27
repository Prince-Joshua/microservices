import { PaystackError } from "../errors.js";

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const secret = process.env.PAYSTACK_SECRET_KEY;

  if (!secret) {
    throw new PaystackError("PAYSTACK_SECRET_KEY is not configured");
  }

  const baseUrl = process.env.PAYSTACK_BASE_URL || "https://api.paystack.co";

  let response: Response;

  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(Number(process.env.HTTP_TIMEOUT_MS) || 8000),
    });
  } catch (cause) {
    throw new PaystackError(
      `Paystack unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        transient: true,
      },
    );
  }

  let json = null as {
    status?: unknown;
    message?: unknown;
    data?: unknown;
  } | null;

  try {
    json = (await response.json()) as typeof json;
  } catch {
    // non-JSON body; handled below
  }

  if (response.status >= 500 || response.status === 429) {
    throw new PaystackError(`Paystack returned ${response.status}`, {
      transient: true,
      httpStatus: response.status,
    });
  }

  if (!response.ok || json?.status !== true) {
    throw new PaystackError(
      typeof json?.message === "string"
        ? json.message
        : `Paystack returned ${response.status}`,
      { httpStatus: response.status },
    );
  }

  return json.data;
}

export interface InitializeInput {
  email: string;
  amount: number;
  currency: string;
  reference: string;
  callbackUrl?: string | undefined;
  metadata?: Record<string, unknown>;
}

export interface CheckoutSession {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

/** -> { authorizationUrl, accessCode, reference } */
export async function initializeTransaction({
  email,
  amount,
  currency,
  reference,
  callbackUrl,
  metadata,
}: InitializeInput): Promise<CheckoutSession> {
  const data = await call("POST", "/transaction/initialize", {
    email,
    amount: String(amount),
    currency,
    reference,
    ...(callbackUrl ? { callback_url: callbackUrl } : {}),
    metadata: JSON.stringify(metadata ?? {}),
  });

  if (
    typeof data?.authorization_url !== "string" ||
    typeof data?.access_code !== "string"
  ) {
    throw new PaystackError("Unexpected response from Paystack initialize");
  }

  return {
    authorizationUrl: data.authorization_url,
    accessCode: data.access_code,
    reference: data.reference ?? reference,
  };
}

/**
 * -> the transaction: { id, status, amount, currency, reference, ... }
 * `status` is Paystack's own: "success", "failed", "abandoned", "pending",
 * "ongoing", "processing", "queued" or "reversed".
 */
export interface PaystackTransaction {
  id: number;
  status: string;
  amount: number;
  currency: string;
  reference: string;
}

export async function verifyTransaction(
  reference: string,
): Promise<PaystackTransaction> {
  const data = await call(
    "GET",
    `/transaction/verify/${encodeURIComponent(reference)}`,
  );

  if (typeof data?.status !== "string") {
    throw new PaystackError("Unexpected response from Paystack verify");
  }

  return data;
}

/** Refund the full amount of a transaction (by reference or numeric id). */
export async function createRefund({
  transaction,
  merchantNote,
  customerNote,
}: {
  transaction: string | number;
  merchantNote?: string;
  customerNote?: string;
}): Promise<unknown> {
  return call("POST", "/refund", {
    transaction: String(transaction),
    ...(merchantNote ? { merchant_note: merchantNote } : {}),
    ...(customerNote ? { customer_note: customerNote } : {}),
  });
}

/** Existing refunds for a transaction, by its numeric Paystack id. */
export async function listRefunds(
  transactionId: string | number,
): Promise<{ status: string }[]> {
  const data = await call(
    "GET",
    `/refund?transaction=${encodeURIComponent(transactionId)}`,
  );

  return Array.isArray(data) ? data : [];
}
