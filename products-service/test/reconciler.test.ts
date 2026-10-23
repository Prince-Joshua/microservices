import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// The reconciler decides whether to keep or return stock, so its decision
// table is tested directly, with the database and Orders service faked.

const OLD = new Date(Date.now() - 60 * 60 * 1000); // an hour ago
const FRESH = new Date();

interface FakeReservation {
  reservationId: string;
  quantity: number;
  createdAt?: Date;
}

let docs: { _id: string; reservations: FakeReservation[] }[] = [];
let statuses: Record<string, string | Error> = {};
let queried: string[] = [];
let calls: [string, string, number?][] = [];

const Product = {
  find() {
    return {
      select() {
        return this;
      },
      lean() {
        return this;
      },
      cursor() {
        return (async function* () {
          for (const doc of docs) {
            yield doc;
          }
        })();
      },
    };
  },
  async updateMany() {
    return {};
  },
};

const url = (path: string) => new URL(path, import.meta.url).href;

mock.module(url("../models/product.model.js"), { namedExports: { Product } });

mock.module(url("../clients/orders.client.js"), {
  namedExports: {
    getReservationStatus: async (reservationId: string) => {
      queried.push(reservationId);
      const answer = statuses[reservationId];

      if (answer instanceof Error) {
        throw answer;
      }

      return answer;
    },
  },
});

mock.module(url("../services/stock-reservations.js"), {
  namedExports: {
    releaseStock: async (_productId: string, quantity: number, reservationId: string) => {
      calls.push(["release", reservationId, quantity]);
      return true;
    },
    finalizeStockReservation: async (_productId: string, reservationId: string) => {
      calls.push(["finalize", reservationId]);
    },
  },
});

const { reconcileReservations } = await import("../jobs/reservation-reconciler.js");

beforeEach(() => {
  docs = [];
  statuses = {};
  queried = [];
  calls = [];
});

const reservation = (
  reservationId: string,
  createdAt: Date | null = OLD
): FakeReservation => ({
  reservationId,
  quantity: 2,
  ...(createdAt ? { createdAt } : {}),
});

test("decision table: keep, skip, release or leave alone, per order status", async () => {
  docs = [
    {
      _id: "p1",
      reservations: [
        reservation("r-pending"),
        reservation("r-awaiting"),
        reservation("r-confirmed"),
        reservation("r-fulfilled"),
        reservation("r-cancelled"),
        reservation("r-failed"),
        reservation("r-notfound"),
        reservation("r-unreachable"),
        reservation("r-fresh", FRESH),
        reservation("r-legacy", null), // written before createdAt existed
      ],
    },
  ];

  statuses = {
    "r-pending": "PENDING",
    "r-awaiting": "AWAITING_PAYMENT",
    "r-confirmed": "CONFIRMED",
    "r-fulfilled": "FULFILLED",
    "r-cancelled": "CANCELLED",
    "r-failed": "FAILED",
    "r-notfound": "NOT_FOUND",
    "r-unreachable": new Error("Orders service returned 503"),
    "r-legacy": "CONFIRMED",
  };

  const originalError = console.error;
  console.error = () => {};
  const stats = await reconcileReservations({ olderThanMs: 10 * 60 * 1000 });
  console.error = originalError;

  const finalized = calls.filter(([kind]) => kind === "finalize").map(([, id]) => id).sort();
  const released = calls.filter(([kind]) => kind === "release").map(([, id]) => id).sort();

  assert.deepEqual(finalized, [
    "r-awaiting", // the order exists and is waiting for payment: keep the decrement
    "r-cancelled",
    "r-confirmed",
    "r-fulfilled",
    "r-legacy",
  ]);
  assert.deepEqual(released, ["r-failed", "r-notfound"]);
  assert.deepEqual(stats, { finalized: 5, released: 2, skipped: 1, errors: 1 });

  assert.equal(queried.includes("r-fresh"), false, "recent reservations aren't even checked");
  assert.equal(
    calls.some(([, id]) => id === "r-unreachable" || id === "r-pending"),
    false,
    "an unreachable Orders service or a running saga means: touch nothing"
  );
});
