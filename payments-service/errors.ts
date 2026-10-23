/** A request this service rejects, with the HTTP status to return. */
export class PaymentError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * A failed call to Paystack. `transient` means "outcome unknown or worth
 * retrying" (network error, timeout, 5xx, 429); anything else is a
 * definite answer from Paystack.
 */
export class PaystackError extends Error {
  readonly transient: boolean;
  readonly httpStatus: number | undefined;

  constructor(
    message: string,
    { transient = false, httpStatus }: { transient?: boolean; httpStatus?: number } = {}
  ) {
    super(message);
    this.transient = transient;
    this.httpStatus = httpStatus;
  }
}
