import { config } from "../config";
import { request } from "./http";
import type { Paged, Product } from "./types";

const base = config.productsUrl;

export const productsApi = {
  list: (
    params: { q?: string; page?: number; limit?: number; includeInactive?: boolean },
    signal?: AbortSignal
  ) => request<Paged<Product>>(base, "/products", { query: params, signal }),

  get: (id: string, signal?: AbortSignal) =>
    request<Product>(base, `/products/${encodeURIComponent(id)}`, { signal }),

  // admin
  create: (body: { name: string; price: number; stockQuantity: number; imageUrl?: string }) =>
    request<Product>(base, "/products", { method: "POST", body }),

  update: (
    id: string,
    patch: { name?: string; price?: number; imageUrl?: string; isActive?: boolean }
  ) =>
    request<Product>(base, `/products/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),

  adjustStock: (id: string, delta: number) =>
    request<Product>(base, `/products/${encodeURIComponent(id)}/stock`, {
      method: "POST",
      body: { delta },
    }),

  deactivate: (id: string) =>
    request<void>(base, `/products/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
