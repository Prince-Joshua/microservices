/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_USERS_URL?: string;
  readonly VITE_PRODUCTS_URL?: string;
  readonly VITE_ORDERS_URL?: string;
  readonly VITE_CURRENCY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
