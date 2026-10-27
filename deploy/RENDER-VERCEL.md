# Deploy on free tiers: Render + Vercel + Supabase + Atlas

```
 browser ─► Vercel  (React app + an allow-list of /api rewrites)
              │
              ├─ /api/users/*     ─► Render free web service  shopfront-users     ─► MongoDB Atlas
              ├─ /api/products/*  ─► Render free web service  shopfront-products  ─► MongoDB Atlas
              └─ /api/orders/*    ─► Render free web service  shopfront-orders     ─► Supabase project #1
                                         │  public URLs, token-protected /internal/*
 Paystack webhook ─────────────────► Render free web service  shopfront-payments   ─► Supabase project #2
```

No gateway on the free tier: free Render web services cannot receive private-network traffic and private
services have no free plan, so all four services are public and call each other over their public URLs.
`web/vercel.json` only forwards the paths the web app uses (`/auth`, `/users`, `/products`, `/orders`), so
`/internal/*` cannot be reached *through Vercel*; it can still be reached on the Render URLs themselves.

## What to expect on the free tier (read this first)

| Limit | What you will notice | What we did about it |
|---|---|---|
| Render free services sleep after 15 idle minutes and take up to a minute to wake | The first request after a quiet period is slow. A checkout touches orders, users, products and payments, so on a fully cold system the waits can add up to minutes. | `HTTP_TIMEOUT_MS=60000` between services (code defaults are 3 s / 8 s). Retrying a checkout is safe: the idempotency key is kept. Run `deploy/warm-up.sh` before demos. |
| 750 free instance hours per month, shared by all four services | Keeping all four awake nonstop (about 2,900 hours a month) would get them suspended after roughly a week. Sleeping saves hours. | Do not use keep-alive pingers on this plan. |
| Free services can restart at any time | An in-flight request can fail. | Idempotent steps, retries and the recovery workers handle it. |
| Background workers only run while the service is awake | A half-finished order or an owed refund is only picked up when something wakes the service. | The customer's payment-callback page and any request wake the services; `warm-up.sh` too. |
| Services are on public URLs | Anyone who finds a service URL can call `/internal/*`; only `INTERNAL_API_TOKEN` stops them. | The token is a generated 256-bit value. Never log or share it. The paid blueprint closes this properly. |
| No gateway | No login rate limit, no request id stamped at the edge (each service makes its own and forwards it). | Paid blueprint restores both. |
| Paystack webhook can hit a sleeping payments service | The first delivery may be slow or fail; Paystack retries undelivered webhooks later (see its docs for the schedule). | Customers are covered meanwhile by the verify call on the callback page; the worker catches the rest. |
| Supabase free projects pause after about a week of low activity | Orders or payments start failing with connection errors until you press **Resume project** (restorable for 90 days). | Open the project or run a query weekly, or upgrade. |
| Supabase direct connections are IPv6-only on free | Prisma times out connecting. | Use the **Session pooler** string (below). |
| No shell and no pre-deploy command assumed on free | Migrations and the first admin cannot be run on Render. | Run them from your computer (steps 1 and 2). |

## Before you start
- Repo on GitHub (or GitLab/Bitbucket) with `render.yaml` at its root.
- **MongoDB Atlas** free cluster with two databases' worth of connection strings: `.../users` and `.../products`.
  Network Access: allow Render. Free services share Render's outbound IP ranges (see their docs), or use `0.0.0.0/0` while practising.
- **Supabase**: create **two** free projects, `shopfront-orders` and `shopfront-payments`. The free plan allows two active
  projects, which keeps one database per service. In each project: **Connect → Session pooler**, copy the string
  (`postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`), put your password in,
  URL-encode any special characters in it, and add `?connection_limit=5` (free pools are small).
  Do not use the transaction pooler (port 6543) for Prisma migrations, and the direct string will not connect from Render.
- A Paystack account with **test** keys (`sk_test_...`).

## Steps
1. **Create the tables** (from your computer, once, and again whenever a service adds a migration):
   ```bash
   cd orders-service   && pnpm install && POSTGRES_URL='<orders session-pooler string>'   pnpm exec prisma migrate deploy
   cd ../payments-service && pnpm install && POSTGRES_URL='<payments session-pooler string>' pnpm exec prisma migrate deploy
   ```
2. **Create the first admin** (from your computer):
   ```bash
   cd users-service && pnpm install
   MONGO_URL='<Atlas users string>' ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-password' pnpm run create-admin
   ```
3. **Render → New → Blueprint**, pick the repo. Enter the values it asks for: `MONGO_URL` (users), `MONGO_URL` (products),
   `POSTGRES_URL` (orders), `POSTGRES_URL` (payments), `PAYSTACK_SECRET_KEY`, and `PAYMENT_CALLBACK_URL`
   (use `https://placeholder.example/payment/callback` for now).
4. When the four services are live, open each `<url>/health` (the first can take a minute). Copy the URLs.
   **Edit `web/vercel.json`**: replace the three placeholders (`shopfront-users`, `-products`, `-orders` `.onrender.com`)
   with your real URLs (Render adds a suffix if a name is taken). Commit and push.
5. **Vercel → Add New → Project**, pick the repo, **Root Directory = `web`**, deploy. Copy the Vercel domain.
6. **shopfront-payments → Environment**: set `PAYMENT_CALLBACK_URL=https://<vercel-domain>/payment/callback`. It redeploys.
7. **Paystack dashboard → Settings → API Keys & Webhooks**: webhook = `https://<payments-url>/webhooks/paystack`.
8. Warm everything up, then test: `deploy/warm-up.sh <users-url> <products-url> <orders-url> <payments-url>`.
   Sign in as the admin, add a product, then register a customer and buy it with a Paystack test card.

If Render rejects the service-address wiring (the `*_HOST` variables) or a service cannot find another one: in that
service's settings clear the **Docker Command** and set the `*_SERVICE_URL` variables by hand
(orders: `USERS_`, `PRODUCTS_`, `PAYMENTS_SERVICE_URL`; products and payments: `ORDERS_SERVICE_URL`), full `https://...` URLs.

## Moving up from free
`deploy/render/render.paid.yaml` is the production design: a public Nginx gateway plus four **private** services
(no public URLs, `/internal/*` blocked, login rate-limited, one request id from the edge), with always-on instances
and automatic migrations. Choose that file's path when creating the Blueprint. It still expects Supabase and Atlas
for the databases, and it needs paid instances.

## Not tested
I could not run Render, Vercel, Supabase or Docker. Run `render blueprints validate`, and expect a fix or two on the
first deploy; the Render logs will say which. The `fromService ... PUBLIC_HOST` wiring between services is the part
most worth watching.

**Session cookie.** The refresh token is an `HttpOnly; Secure; SameSite=Strict` cookie with `Path=/api/users`, which
works because the browser only ever talks to the Vercel domain. After the first deploy, sign in and check in the
browser's dev tools (Application > Cookies) that `refresh_token` is set, then reload the page: you should stay signed
in. If the cookie is missing, the rewrite isn't passing `Set-Cookie` through.
