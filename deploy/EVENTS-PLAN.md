# Step 3 plan: events through a broker (not implemented yet)

Today every cross-service step is an HTTP call that is retried until it works. That is
already robust (idempotent steps, state columns that workers retry), so a broker is an
upgrade in coupling and fan-out, not a fix. It is also the one change that touches the
money path, so it should be built and tested with the real stack running.

## What changes

| Today (HTTP) | With events |
|---|---|
| payments -> orders `POST /internal/payments/...` after a payment succeeds | payments publishes `payment.succeeded` |
| orders answers accepted / rejected in the HTTP reply | orders publishes `order.payment_accepted` / `order.payment_rejected`; payments refunds on rejected |
| orders -> products stock return on cancel | orders publishes `order.cancelled`; products returns stock |
| orders -> payments refund on cancel | payments consumes `order.cancelled` |

Reserving stock during order creation stays synchronous: the customer is waiting for that answer.

## Pieces

1. **Broker:** RabbitMQ, one topic exchange `shop.events`, one durable queue per consuming service.
2. **Outbox table** in orders and payments (Postgres): the event row is written in the SAME transaction as
   the state change, so a crash can never change state without the event.
3. **Relay:** a loop that publishes unsent outbox rows, then marks them sent. It may publish twice after
   a crash (at-least-once), so consumers must tolerate duplicates.
4. **Idempotent consumers:** each handler is a conditional update (like today), or records the event id in an
   `inbox` table inside its own transaction and skips ids it has seen.
5. **Dead-letter queue** after N failed deliveries, plus an alert on its depth.
6. **Rollout:** publish events AND keep the HTTP calls behind a flag; compare for a week; switch consumers over;
   remove the HTTP path last. The existing workers stay as the safety net.

## Needs before it can be built

- A dependency (`amqplib`), which means updating each service's `pnpm-lock.yaml` (the Docker build uses `--frozen-lockfile`).
- RabbitMQ running, so the relay, redelivery and duplicate handling can be tested against a real broker.
- Test scenarios: broker down during a payment, duplicate delivery, crash between commit and publish, consumer crash mid-handling.
