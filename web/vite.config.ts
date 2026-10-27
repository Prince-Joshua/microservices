import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// None of the four services enable CORS, so in development (and `vite preview`)
// the browser talks to this dev server and it forwards each prefix to its
// service:  /api/users/auth/login  ->  http://localhost:4001/auth/login
// For a real deployment, put the same prefixes behind your reverse proxy (or
// set the VITE_*_URL variables to absolute URLs and enable CORS on the services).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  const targets: Record<string, string> = {
    users: env.USERS_PROXY_TARGET || "http://localhost:4001",
    products: env.PRODUCTS_PROXY_TARGET || "http://localhost:4002",
    orders: env.ORDERS_PROXY_TARGET || "http://localhost:4000",
  };

  const proxy = Object.fromEntries(
    Object.entries(targets).map(([name, target]) => [
      `/api/${name}`,
      {
        target,
        changeOrigin: true,
        rewrite: (path: string) => path.replace(new RegExp(`^/api/${name}`), ""),
      },
    ])
  );

  return {
    plugins: [react()],
    // 3000 matches PAYMENT_CALLBACK_URL in payments-service/.env.example
    server: { port: 3000, proxy },
    preview: { port: 3000, proxy },
  };
});
