#!/usr/bin/env node
// Prints everything that happened for one request id, across all services, in time order.
//   docker compose -f docker-compose.prod.yml logs --no-color --no-log-prefix | node deploy/trace.mjs <id>
// (deploy/trace.sh does exactly that.) Non-JSON lines (databases) are ignored.
import { createInterface } from "node:readline";

const id = process.argv[2];

if (!id) {
  console.error("usage: node deploy/trace.mjs <request-id>");
  process.exit(2);
}

const rows = [];

for await (const raw of createInterface({ input: process.stdin })) {
  let entry;

  try {
    entry = JSON.parse(raw);
  } catch {
    continue;
  }

  if (entry && entry.requestId === id) rows.push(entry);
}

rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

if (rows.length === 0) {
  console.error(`no log lines found for ${id}`);
  process.exit(1);
}

for (const e of rows) {
  const http = e.method ? `${e.method} ${e.path} -> ${e.status}${e.ms !== undefined ? ` (${e.ms}ms)` : e.sec !== undefined ? ` (${Math.round(e.sec * 1000)}ms)` : ""}` : "";
  const text = e.msg === "request" ? http : [e.msg, http].filter(Boolean).join(" ");
  console.log(`${e.ts}  ${String(e.service).padEnd(9)} ${String(e.level).padEnd(5)} ${text}`);
}
