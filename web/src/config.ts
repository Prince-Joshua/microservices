const trim = (value: string) => value.replace(/\/+$/, "");

export const config = {
  usersUrl: trim(import.meta.env.VITE_USERS_URL || "/api/users"),
  productsUrl: trim(import.meta.env.VITE_PRODUCTS_URL || "/api/products"),
  ordersUrl: trim(import.meta.env.VITE_ORDERS_URL || "/api/orders"),
  currency: import.meta.env.VITE_CURRENCY || "NGN",
} as const;
