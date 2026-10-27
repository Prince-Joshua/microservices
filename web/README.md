# Shopfront (web)

React + TypeScript storefront and admin console for the four services in this repo.
UI is **Chakra UI v3**; all styling decisions live in one file: [`src/theme.ts`](src/theme.ts)
(brand palette, fonts, radii, global styles, and the order-status colours/labels).

## Run

```bash
# services first (see the root README), then:
cd web
cp .env.example .env     # optional
pnpm install             # or npm install
pnpm dev                 # http://localhost:3000
```

Port 3000 matches `PAYMENT_CALLBACK_URL` in `payments-service/.env.example`, so Paystack
sends customers back to `/payment/callback`.

None of the services enable CORS, so the dev server proxies:

| Browser calls      | Forwarded to             |
|--------------------|--------------------------|
| `/api/users/*`     | `http://localhost:4001/*` |
| `/api/products/*`  | `http://localhost:4002/*` |
| `/api/orders/*`    | `http://localhost:4000/*` |

In production, expose the same prefixes from your reverse proxy, or set `VITE_*_URL` to absolute
URLs and add CORS to the services. The payments service is never called from the browser.

## What's in it

| Route | Who | Uses |
|---|---|---|
| `/` | everyone | `GET /products` (search, paging) |
| `/login`, `/register` | public | `POST /auth/login`, `/auth/register` |
| `/cart` | everyone (checkout needs sign-in) | `POST /orders` with an `Idempotency-Key` |
| `/orders`, `/orders/:id` | customer / admin | list, get, `/pay`, `/verify-payment`, `/cancel`, `/fulfill` (admin) |
| `/payment/callback` | customer | `POST /orders/:id/verify-payment`, polled until the webhook/verify settles |
| `/account` | customer | `GET/PATCH /users/me`, password change, deactivate |
| `/admin/products` | admin | create, edit, stock delta, deactivate / reactivate |
| `/admin/users` | admin | list, filter by email, role and active toggles |

## How it follows the API's rules

- **Idempotency:** the cart holds a UUID `Idempotency-Key` that changes whenever the cart changes. A network error or 5xx
  keeps the key so retrying is safe; a 4xx (rolled back) issues a fresh one.
- **202 from `POST /orders`:** the order page polls every 3 s while the status is `PENDING`.
- **Payment:** the redirect is never trusted. The callback page asks the orders service to verify with Paystack, and retries
  while the order is still `AWAITING_PAYMENT`.
- **Unpaid orders** show the 30-minute deadline; `POST /orders/:id/pay` re-issues the checkout link.
- **Admin guards:** admins can't change their own role/status (the API refuses it, so the UI disables it).
- **Staying signed in:** the access token is short-lived. It lives in memory only, never in storage. The long-lived refresh token is an `HttpOnly` cookie the page can't read; when the access token expires, is missing after a reload, or a call gets a 401, the app calls `/auth/refresh` (the browser sends the cookie) and repeats the call once, so people aren't kicked out every 15 minutes. Parallel calls share one refresh, and tabs take turns with a Web Lock. Only a refresh the server *refuses* (expired, signed out elsewhere, account deactivated) signs the user out with a toast; a network error or a sleeping server doesn't. Signing out also revokes the session and clears the cookie on the server, and signing in or out in one tab is followed by the others (via `BroadcastChannel`). `localStorage` holds only the signed-in user's profile, so the UI knows whom to show before the first refresh.
- Prices are formatted with `VITE_CURRENCY` (default `NGN`); orders use their own `currency`.

## Customising the look

Edit `src/theme.ts`: `tokens.colors.brand` is the palette behind every `colorPalette="brand"` button, link and badge;
`statusPalette` / `statusLabel` control the order badges.
