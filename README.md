# Order system: four services

```
                      customer (JWT)                          Paystack
                            |                                    |  ^
         +------------------+------------------+                 |  | initialize / verify / refund
         |                  |                  |                 v  |
         v                  v                  v          +------------------+
 +---------------+  +----------------+  +------------------+  | payments-service |
 | users-service |  | orders-service |  | products-service |  | :4003            |
 | :4001         |  | :4000          |  | :4002            |  | Postgres         |
 | Mongo (users) |  | Postgres       |  | Mongo (products) |  +------------------+
 +---------------+  +----------------+  +------------------+     ^   |   ^
        ^                 |  |  ^               ^                 |   |   | webhook
        |                 |  |  |               |   customer pays |   |   | (signed)
        +-----------------+  |  +---------------+   on Paystack's +---+   +-- Paystack
        HTTP + x-internal-   |   "what became of    checkout page
        token                |    this reservation?"        Orders <-> Payments:
                             |                              start payment / "paid"
                             +------------------------------callback / refund
```

Each service has its own server, database and `package.json`. They share no
code and never read each other's databases. Users signs the JWT; Orders and
Products verify it with the same `JWT_SECRET`. Only **payments-service** holds
the Paystack secret key.

## Endpoints

Public means no token. **Customer** needs a JWT. **Admin** needs a JWT whose
`role` is `admin`. **Internal** needs the `x-internal-token` header and should
never be exposed publicly. **Webhook** is called by Paystack and authenticated
by its signature.

### users-service (:4001)

| Method | Path | Access | Purpose |
|---|---|---|---|
| POST | `/auth/register` | public | `{ name, email, password }` -> 201 customer |
| POST | `/auth/login` | public | `{ email, password }` -> `{ token, refreshToken, user }`. `token` is a short-lived JWT (`JWT_EXPIRES_IN`, 15 minutes) |
| POST | `/auth/refresh` | public | `{ refreshToken }` -> a new `{ token, refreshToken, user }`. Each refresh token works **once**; the old one is then dead |
| POST | `/auth/logout` | public | `{ refreshToken }` -> 204. Ends that session; harmless with an unknown token |
| GET | `/users/me` | customer | own profile |
| PATCH | `/users/me` | customer | `{ name }` |
| POST | `/users/me/password` | customer | `{ currentPassword, newPassword, refreshToken? }` -> 204. Signs out every other session; send the current `refreshToken` to stay signed in here |
| DELETE | `/users/me` | customer | deactivate own account -> 204 |
| GET | `/users` | admin | `?page&limit&email` |
| GET | `/users/:id` | admin | one user |
| PATCH | `/users/:id` | admin | `{ isActive?, role? }` (not on yourself) |
| GET | `/internal/users/:id` | internal | `{ id, isActive, email }` for Orders |

**Sessions.** A login returns a short-lived access token and a long-lived refresh token
(`REFRESH_TOKEN_TTL_DAYS`, 30 by default; a session never lasts past `REFRESH_MAX_SESSION_DAYS`, 90).
Refresh tokens are random, stored only as a SHA-256 hash, and **rotated on every use**. Presenting a token
that was already used (outside a 10-second grace window for two tabs refreshing at once) revokes the whole
session, since that means the token was copied. Signing out, changing the password (other sessions) and
deactivating an account revoke sessions on the server. The access token itself can't be revoked, which is
why it is short. A role change reaches the access token at the next refresh.

Create the first admin: set `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env`, then
`pnpm run create-admin`.

### products-service (:4002)

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/products` | public | `?q&page&limit` (admins: `&includeInactive=true`) |
| GET | `/products/:id` | public | one active product |
| POST | `/products` | admin | `{ name, price, stockQuantity? }` |
| PATCH | `/products/:id` | admin | `{ name?, price?, isActive? }` |
| POST | `/products/:id/stock` | admin | `{ delta }` add/remove stock; never below 0 |
| DELETE | `/products/:id` | admin | soft delete (deactivate) -> 204 |
| POST | `/internal/reservations` | internal | reserve stock, idempotent per `reservationId` |
| POST | `/internal/reservations/release` | internal | give reserved stock back, idempotent |
| POST | `/internal/reservations/finalize` | internal | order placed: drop marker, keep decrement |
| POST | `/internal/stock/return` | internal | cancelled order: put stock back, idempotent per `returnId` |

### orders-service (:4000)

| Method | Path | Access | Purpose |
|---|---|---|---|
| POST | `/orders` | customer | `{ items: [{ productId, quantity }] }`, **`Idempotency-Key` header required**. Returns the order **and a Paystack checkout link** |
| GET | `/orders` | customer / admin | own orders (admin: all, `&userId`) `?status&page&limit` |
| GET | `/orders/:id` | customer / admin | own order (admin: any) |
| POST | `/orders/:id/pay` | customer / admin | (re)issue the checkout link while the order awaits payment |
| POST | `/orders/:id/verify-payment` | customer / admin | "I just paid": check with Paystack now, return the updated order |
| POST | `/orders/:id/cancel` | customer / admin | cancel an unpaid or paid order; stock returns, a paid order is refunded |
| POST | `/orders/:id/fulfill` | admin | CONFIRMED (paid) -> FULFILLED (can't be cancelled after) |
| GET | `/internal/reservations/:id` | internal | order status for a reservation (for Products' reconciler) |
| POST | `/internal/orders/:id/payment-succeeded` | internal | Payments reports a verified payment: `{ accepted }` |

`POST /orders` responses: **201** created (status `AWAITING_PAYMENT`, with
`payment.authorizationUrl`), **200** replay of an existing order, **202** still
processing (`Retry-After: 5`), **404/409/422/...** rolled back (replayed for the
same key; use a new key to try again). If the payment link can't be created
right now the order still exists; `payment` is `null` and `POST /orders/:id/pay`
gets the link later.

### payments-service (:4003)

| Method | Path | Access | Purpose |
|---|---|---|---|
| POST | `/webhooks/paystack` | webhook | Paystack events, verified by `x-paystack-signature` |
| POST | `/internal/payments` | internal | `{ orderId, userId, email, amount, currency }` -> checkout session. Idempotent per order |
| POST | `/internal/payments/refund` | internal | `{ orderId, reason? }` -> `{ state: NOT_PAID \| DONE \| QUEUED \| FAILED }`. Idempotent |
| POST | `/internal/payments/verify` | internal | `{ orderId }` re-check the order's payments with Paystack now |

## Order lifecycle

```
          POST /orders           saga commits            paid (verified)           fulfill
(nothing) ----------> PENDING ---------------> AWAITING_PAYMENT ----------> CONFIRMED -------> FULFILLED
                         |                          |                           |
                         | rejected / too slow      | cancel, or the            | cancel
                         v                          | payment deadline passes   v
                       FAILED                       v                       CANCELLED
                (stock released)                 CANCELLED          (stock returned + payment refunded)
                                            (stock returned)
```

An order is created `AWAITING_PAYMENT` with its stock **held**. It becomes
`CONFIRMED` only when Payments reports money that Paystack itself verified.
Unpaid orders are cancelled after `PAYMENT_TTL_MS` (30 minutes by default) and
their stock goes back on sale.

## Paying: how it works

1. `POST /orders` runs the stock saga (below), then asks Payments for a checkout
   session. Payments writes the attempt to its database **first**, then calls
   Paystack's initialize with the order total in minor units (kobo for NGN),
   and returns `authorizationUrl`. Send the customer there.
2. The customer pays on Paystack. Paystack sends `charge.success` to
   `/webhooks/paystack` **and** redirects the customer to `PAYMENT_CALLBACK_URL`
   (your frontend), which should call `POST /orders/:id/verify-payment`.
3. Payments never trusts the webhook body or the redirect. It checks the
   signature (HMAC-SHA512 of the raw body), then **asks Paystack** to verify the
   transaction and compares amount and currency with what it charged.
4. Payments tells Orders (`payment-succeeded`). Orders moves the order
   `AWAITING_PAYMENT -> CONFIRMED` with a conditional update, and answers
   `accepted: true`.
5. If Orders answers `accepted: false` (the order was cancelled or expired, was
   already paid by another attempt, or the amount was wrong) **Payments
   refunds the customer automatically**.

What keeps money and orders consistent:

- **Paystack is the source of truth for "was it paid".** Verification happens
  server-side every time; a forged or stale webhook can't confirm an order.
- **No answer is never an answer.** If Orders can't be reached, the payment is
  recorded and Orders is told again later; it is *not* refunded. If Paystack
  can't be reached, nothing is decided and the check is retried.
- **Payment arriving after cancellation or expiry** is rejected by Orders and
  refunded by Payments, so a customer never pays for an order that no longer
  exists.
- **Two payment attempts for one order** (reloaded checkout, two tabs): the
  first confirmed wins; the other is refunded.
- **Refunds are safe to repeat.** Before creating a refund, Payments checks
  whether Paystack already has one for the transaction, so a lost response
  can't refund twice. Refunds that keep failing are flagged `FAILED` and logged
  as CRITICAL for manual handling.
- **A missed webhook doesn't matter.** The payments worker (every 30 s) re-checks
  old pending payments, re-notifies Orders and retries owed refunds; Paystack
  also retries failed webhooks itself.

## Stock saga (Orders <-> Products)

There is no transaction spanning Postgres and the MongoDBs, so stock uses a
**saga orchestrated by orders-service**, with its state saved in Postgres.

**Create:** (1) insert the order `PENDING / RUNNING` with the requested items and
a unique `reservationId` (`<userId>:<Idempotency-Key>`), before any other
service is touched; (2) reserve stock in Products, item by item, idempotent;
(3) commit items, total and `AWAITING_PAYMENT` in one Postgres transaction
(only if still `PENDING`); (4) tell Products to drop its reservation markers.
A rejection marks the order `FAILED / COMPENSATING` first, *then* releases
stock, so a commit that is secretly in flight can't be undone.

**Cancel** (`AWAITING_PAYMENT` or `CONFIRMED`): mark `CANCELLED / COMPENSATING`,
return stock (once per `cancel:<orderId>`) and, if the order was paid, request
the refund, then `DONE`. A fulfilled order can't be cancelled.

Every cross-service call is idempotent and every state change is a conditional
update (`... WHERE status = 'PENDING'`), so the request handler, a client retry
and the recovery worker can drive the same order at once. An unknown outcome
is never treated as a failure: the order is re-read, and only rolled back when
verifiably still `PENDING`.

**Workers.** orders-service (every 15 s) re-drives stalled sagas, retries
stock returns and refunds, and cancels unpaid orders past their deadline.
products-service (every minute) asks Orders what became of old reservation
markers: `PENDING` -> leave alone; `AWAITING_PAYMENT / CONFIRMED / FULFILLED /
CANCELLED` -> drop the marker; `FAILED / NOT_FOUND` -> release the stock;
**Orders unreachable -> do nothing**.

## Run it

```bash
docker compose up -d     # users-mongo, products-mongo, orders-postgres, payments-postgres

# in each service folder
cp .env.example .env     # same JWT_SECRET (users/orders/products) and INTERNAL_API_TOKEN (all four)
pnpm install

# first time: create the Postgres tables
(cd orders-service   && pnpm exec prisma migrate dev --name payments)
(cd payments-service && pnpm exec prisma migrate dev --name init)

# first time: sample data for development (see "Sample data" below)
(cd users-service    && pnpm run seed)
(cd products-service && pnpm run seed)

# then, one terminal per service
pnpm run dev              # development: tsx watch, no build step
# or, for a production-style run:
pnpm run build && pnpm start   # compiles to dist/ and runs node dist/server.js
```

Everything is TypeScript (strict). Requires **Node 22.3+** and **pnpm** (`corepack enable` gets you the right version). Each service is an independent pnpm project with its own lockfile, so it can be deployed on its own. From the root, `pnpm install:all`, `pnpm typecheck` and `pnpm test` run across all four. `pnpm install` runs
`prisma generate` for orders and payments, which gives you the typed client;
after that, `pnpm run typecheck` checks a service without emitting anything.

### Sample data

| Service | Command | What it does |
|---|---|---|
| users-service | `pnpm run seed` | Creates `admin@example.com` (password `admin-password-123`) and customers `ada@`, `grace@` and `alan@example.com` (password `password123`) |
| products-service | `pnpm run seed` | Creates 8 products, including a **sold-out** one (orders get 409) and an **inactive** one (orders get 404) so you can try the saga's rejection paths. Prints each product's id |
| orders / payments | none | Their tables are created by the Prisma migrations. Rows are produced by real orders and payments; hand-made rows would skip the reservation markers and payment references the workers rely on |

Both seeds are **safe to re-run**: users are matched by email and products by
name, so nothing is duplicated. Re-running users restores the documented
passwords and roles. Re-running products restores prices and active status but
**keeps current stock**, so orders placed while testing aren't undone; use
`pnpm run seed --reset-stock` to put stock back to the sample values.

Because the sample accounts have known passwords, the seeds **refuse to run**
when `NODE_ENV=production` or when `MONGO_URL` isn't a local database. For a
throwaway remote database (a shared staging copy, say) set
`SEED_ALLOW_REMOTE=true`. This override never applies in production.

`pnpm run create-admin` is separate: it makes one admin with a password *you*
choose, which is the right way to create the first admin anywhere real.

### Paystack setup

1. In the Paystack dashboard (test mode first), copy the **secret key**
   (`sk_test_...`) into `payments-service/.env` as `PAYSTACK_SECRET_KEY`.
2. Under *Settings -> API Keys & Webhooks*, set the **webhook URL** to
   `https://<your-public-host>/webhooks/paystack`. Locally, expose port 4003
   with a tunnel such as ngrok.
3. Set `PAYMENT_CALLBACK_URL` to the page in your frontend that Paystack should
   send customers back to. It receives `?reference=...`; have it call
   `POST /orders/:id/verify-payment`.
4. Use Paystack's [test cards](https://paystack.com/docs/payments/test-payments/)
   to try successful and declined payments.

Orders and Payments must agree on the currency (`PAYMENT_CURRENCY`, default
`NGN`) and amounts are always integers in the minor unit (kobo).

## Try it

Assumes you ran both seeds.

```bash
# log in as a seeded customer (and, if you like, the admin)
TOKEN=$(curl -s localhost:4001/auth/login -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"password123"}' | jq -r .token)
ADMIN_TOKEN=$(curl -s localhost:4001/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"admin-password-123"}' | jq -r .token)

# pick a product
curl -s localhost:4002/products | jq '.data[] | {id, name, price, stockQuantity}'

# place an order: the response carries payment.authorizationUrl. Open it and pay with a test card.
curl -s localhost:4000/orders -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H 'Idempotency-Key: order-0001-abcd' \
  -d '{"items":[{"productId":"<id>","quantity":2}]}'

# after paying (the webhook usually confirms it within seconds)
curl -s -X POST localhost:4000/orders/<orderId>/verify-payment -H "authorization: Bearer $TOKEN"

# cancel and get refunded
curl -s -X POST localhost:4000/orders/<orderId>/cancel -H "authorization: Bearer $TOKEN"
```

## Tests

`pnpm test` in each service (compiles with `tsc`, then runs the compiled tests
with Node's test runner; needs Node 22.3+ for its module mocks). They need no databases or network:

- **orders-service:** the stock saga through outages, a commit that dies
  mid-flight and concurrent drivers; the payment flow (confirm, replay, wrong
  amount, late payment, double payment); cancellation with and without refunds;
  unpaid-order expiry; the HTTP routes.
- **payments-service:** the payment lifecycle and refunds through Paystack and
  Orders outages (including a refund whose response is lost); the webhook
  (valid, forged, tampered and replayed requests); and the *real* Paystack
  client against a local stand-in server that checks the wire format.
- **products-service:** the reconciler's decision table, its auth/validation,
  and the seed script (guard, data, idempotency, stock handling).
- **users-service:** registration, login and the JWT, and the seed script
  (guard, data, idempotency, repairing a tampered account).

The services' databases and the real Paystack are faked, so the tests prove the
logic, not the live integrations. Before going live, run a full payment, a
cancellation refund and a webhook delivery against Paystack **test mode**.

## Not included

Partial refunds, multiple currencies in one deployment, receipts or emails,
and a Paystack webhook source-IP allowlist (the signature check is the
authentication; allowlisting the IPs Paystack publishes is cheap to add at your
proxy or firewall).

## Web app

`web/` is a React + TypeScript + Chakra UI storefront and admin console for these services.
See [`web/README.md`](web/README.md). Quick start: `pnpm run install:web && pnpm run web:dev` (http://localhost:3000).

## Deploying

`docker-compose.prod.yml` runs everything behind one nginx entry point (React app + `/api/*` routing, internal routes blocked). See [`deploy/README.md`](deploy/README.md).

`docker-compose.prod.yml` runs replicas of every service with health checks; every request carries an id you can follow across services with `deploy/trace.sh <id>`. The next step (events through a broker) is planned in [`deploy/EVENTS-PLAN.md`](deploy/EVENTS-PLAN.md).

## Deploying on free tiers (Render + Vercel + Supabase + Atlas)

`render.yaml` deploys the four services as **free Render web services**; `web/vercel.json` deploys the web app on
Vercel and forwards an allow-list of API paths to them. Databases are **MongoDB Atlas** (users, products) and
**Supabase Postgres** (orders, payments, one free project each; not Render Postgres). Step by step:
[`deploy/RENDER-VERCEL.md`](deploy/RENDER-VERCEL.md).

What the free tier means in practice:

- **Cold starts.** Free Render services sleep after 15 idle minutes and take up to a minute to wake, so the first
  request after a quiet spell is slow and a checkout that touches several services can take minutes. Inter-service
  timeouts are raised to 60 s, retrying a checkout is safe, and `deploy/warm-up.sh` wakes everything before a demo.
- **750 free instance hours a month, shared by all four services.** Don't keep them awake with pingers; nonstop they
  would be suspended after about a week.
- **No private network and no gateway.** Free web services can't receive private traffic, so all services are public and
  call each other over public URLs. `/internal/*` is protected only by the internal token (blocked through Vercel by the
  allow-list, not on the Render URLs themselves), and there is no login rate limit.
- **Workers only run while awake.** Saga recovery, the payment worker and the stock reconciler pause while a service sleeps.
- **Supabase pauses free projects after about a week of low activity**; resume it in the dashboard. Use the *session
  pooler* connection string (the direct one is IPv6-only on free).
- **Migrations and the first admin run from your computer**, not on Render.

The production design (public Nginx gateway, private services, always-on instances) is
[`deploy/render/render.paid.yaml`](deploy/render/render.paid.yaml).
