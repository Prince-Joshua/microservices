# Practice: split one service into three, sharing one database

`products-service` is cut into three programs that run as separate containers but read and write the
**same** MongoDB database. The code is still one project (one `Product` model); only the entry points differ.

```
                         ┌──────────────────────────────────────────────┐
 browser ─► gateway ───► │ products-router (nginx, alias "products")    │
 orders  ─────────────►  │   /internal/*  ──► products-inventory  x2    │──┐
                         │   everything else ► products-catalog   x2    │  ├─► products-mongo
                         └──────────────────────────────────────────────┘  │   (ONE shared database)
                              products-reconciler x1  (background job) ────┘
```

| Part | Entry point | Serves | Secrets it gets |
|---|---|---|---|
| catalog | `servers/catalog.ts` | `/products` (shop + admin) | `JWT_SECRET`, `INTERNAL_API_TOKEN`, `USERS_SERVICE_URL` |
| inventory | `servers/inventory.ts` | `/internal/*` (stock for orders) | `INTERNAL_API_TOKEN` |
| reconciler | `servers/reconciler.ts` | background repair job | `INTERNAL_API_TOKEN`, `ORDERS_SERVICE_URL` |

The router answers on `products:4002` (a network alias), so the gateway and the Orders service need no changes.

## Run it

```bash
# same .env and migrations as the normal stack; then:
docker compose -f docker-compose.prod.yml -f docker-compose.split.yml up -d --build
docker compose -f docker-compose.prod.yml -f docker-compose.split.yml ps
```
Needs Docker Compose 2.24+. Back to one service: `docker compose -f docker-compose.prod.yml up -d --remove-orphans`.
Without Docker, run each part with `pnpm dev:catalog`, `pnpm dev:inventory`, `pnpm dev:reconciler` (different ports), and put nginx in front.

## Things to try

1. **Failure isolation.** `docker compose ... stop products-inventory`. Browsing and admin keep working;
   placing an order fails cleanly at the stock step. Start it again and orders recover.
2. **Scale one part.** Checkout is the busy path: `up -d --scale products-inventory=4`. The catalog stays at 2.
3. **Follow a checkout.** Place an order, copy the `ref` / `X-Request-Id`, run `deploy/trace.sh <id>`:
   you'll see gateway → orders → products-router → products-inventory in order.
4. **Least privilege.** `docker compose ... exec products-catalog env | grep INTERNAL` prints nothing: a bug or breach
   in the public part can't call the internal routes.
5. **Kill the reconciler** and watch nothing break right away; stuck reservations just aren't repaired until it returns.

## What sharing a database costs (the real lesson)

- **One schema, three owners.** Change the `Product` model and all three parts must be deployed together, or an old
  part may misread new documents. This is why separate services normally own separate data.
- **Hidden coupling.** `catalog` can change stock directly (admin adjust) while `inventory` reserves it. They only
  stay correct because both use atomic Mongo updates on the same document.
- **One database is still one bottleneck and one point of failure,** however many servers sit in front of it.
- **What you gain:** independent scaling, separate failure domains, and separate secrets, without moving any data.

## Next step if you want to go further

Give inventory its own collection or database (it owns stock numbers) and have catalog ask it, or receive
`stock.changed` events (see `EVENTS-PLAN.md`). That is the move from "split deployables" to real microservices.
