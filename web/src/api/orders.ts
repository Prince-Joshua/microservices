import { config } from "../config";
import { request, requestRaw } from "./http";
import type {
  CreateOrderBody,
  Order,
  OrderEnvelope,
  OrderStatus,
  Paged,
  PayEnvelope,
} from "./types";

const base = config.ordersUrl;
const id = encodeURIComponent;

export const ordersApi = {
  /**
   * 201 created, 200 replay of an existing order, 202 still processing.
   * Anything else (404/409/422/...) is thrown as an ApiError.
   * The Idempotency-Key makes retries safe: reuse it until the request has an answer.
   */
  create: (items: { productId: string; quantity: number }[], idempotencyKey: string) =>
    requestRaw<CreateOrderBody>(base, "/orders", {
      method: "POST",
      body: { items },
      headers: { "Idempotency-Key": idempotencyKey },
    }),

  list: (
    params: { status?: OrderStatus | ""; userId?: string; page?: number; limit?: number },
    signal?: AbortSignal
  ) => request<Paged<Order>>(base, "/orders", { query: params, signal }),

  get: async (orderId: string, signal?: AbortSignal) =>
    (await request<{ order: Order }>(base, `/orders/${id(orderId)}`, { signal })).order,

  /** (Re)issues the checkout link while the order is awaiting payment. */
  pay: (orderId: string) =>
    request<PayEnvelope>(base, `/orders/${id(orderId)}/pay`, { method: "POST" }),

  /** "I just paid": checks with Paystack now and returns the updated order. */
  verifyPayment: async (orderId: string) =>
    (await request<OrderEnvelope>(base, `/orders/${id(orderId)}/verify-payment`, { method: "POST" }))
      .order,

  cancel: async (orderId: string) =>
    (await request<OrderEnvelope>(base, `/orders/${id(orderId)}/cancel`, { method: "POST" })).order,

  // admin
  fulfill: async (orderId: string) =>
    (await request<OrderEnvelope>(base, `/orders/${id(orderId)}/fulfill`, { method: "POST" })).order,
};
