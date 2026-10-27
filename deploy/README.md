# Deploying behind nginx

```
 browser ──► nginx (gateway :80/:443) ─┬─ /            React app (static)
                                       ├─ /api/users/*     ► users:4001
                                       ├─ /api/products/*  ► products:4002
                                       ├─ /api/orders/*    ► orders:4000
                                       ├─ /webhooks/paystack ► payments:4003
                                       └─ */internal/*     ► 404 (blocked)
```

## Docker (recommended)

```bash
cp .env.example .env        # set the secrets (openssl rand -hex 32)
docker compose -f docker-compose.prod.yml up -d --build

# first time, and whenever an upgrade adds migrations: create/update the tables BEFORE starting the services
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d orders-postgres payments-postgres
docker compose -f docker-compose.prod.yml run --rm --no-deps orders   pnpm exec prisma migrate deploy
docker compose -f docker-compose.prod.yml run --rm --no-deps payments pnpm exec prisma migrate deploy

docker compose -f docker-compose.prod.yml up -d

# first admin (use your own password)
docker compose -f docker-compose.prod.yml run --rm \
  -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD='a-long-password' users pnpm run create-admin
```

Only the gateway publishes a port. Services and databases are reachable
only on the private compose network. Open http://localhost.

## Replicas

Each service runs `REPLICAS` copies (default 2, set in `.env`); nginx re-resolves Docker DNS every
5 seconds and round-robins across them. Scale live with
`docker compose -f docker-compose.prod.yml up -d --scale orders=4` (or change `REPLICAS`).

Why this is safe: every state change is a conditional update, the background jobs (saga recovery,
payment worker, stock reconciler) may run on every copy, and refunds take a short lease so two copies
never refund the same payment (`payments-service` `processRefund`, covered by a test).
Containers are only sent traffic once `/health` answers (the services listen after their database
connects) and stop gracefully on SIGTERM (20 s grace).

## Following one request across services

nginx stamps every request with an id, passes it to the services as `X-Request-Id`, and every service
puts it on each log line and on its calls to the other services. All logs are JSON, one object per line.
The id comes back in the `X-Request-Id` response header; the web app shows it as `ref: ...` on server errors.

```bash
deploy/trace.sh <request-id>          # gateway + all services, in time order
SINCE=1h deploy/trace.sh <request-id>
```

Background passes run under ids like `job-saga-recovery-1a2b3c4d`. Health checks and query strings are never logged.
`docker compose logs` is the central log for now; the JSON format works unchanged with Loki, Elasticsearch, etc.

## HTTPS and Paystack

Paystack live webhooks need HTTPS. Put TLS in front of the gateway:
- simplest: run Caddy or a cloud load balancer in front of port 80, or
- on a plain server, use `deploy/nginx.host.conf` and `sudo certbot --nginx`.

Then set `PUBLIC_URL=https://your-domain`, and in the Paystack dashboard set the
webhook to `https://your-domain/webhooks/paystack`.

## Without Docker

Use `deploy/nginx.host.conf` (upstreams on 127.0.0.1) and copy `web/dist` to `/var/www/shop`.

## Notes

- `*/internal/*` is blocked at nginx; those routes must never be public.
- Login/register are rate-limited to 10 requests/min per IP (`limit_req_zone`).
- If nginx sits behind another proxy, the services see that proxy's IP unless you forward the real one.
- `web/` has no lockfile yet; run `pnpm install` in `web/` once and commit `pnpm-lock.yaml` for reproducible builds.

## Practice: split a service

`docker-compose.split.yml` splits products into catalog, inventory and reconciler sharing one database, with an internal nginx router. See [`SPLIT-PRODUCTS.md`](SPLIT-PRODUCTS.md).
