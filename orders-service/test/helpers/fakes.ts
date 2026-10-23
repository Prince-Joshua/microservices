import { randomUUID } from "node:crypto";
import type { MockTracker } from "node:test";

import type { OrderWithItems } from "../../services/order-saga.js";

import { OrderError } from "../../errors.js";

/**
 * In-memory stand-ins for Postgres and the other services, so the saga and
 * the routes can be exercised through failures without any infrastructure.
 * They imitate only the behaviour the code relies on.
 */

type Row = Record<string, any>;
type Where = Record<string, unknown>;

function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      const condition = expected as { lt?: any; in?: unknown[]; not?: unknown };

      // Like SQL, a NULL never satisfies a comparison.
      if ("lt" in expected) {
        return row[key] != null && row[key] < condition.lt;
      }

      if ("in" in expected) {
        return (condition.in as unknown[]).includes(row[key]);
      }

      if ("not" in expected) {
        return row[key] !== condition.not;
      }

      return false;
    }

    return row[key] === expected;
  });
}

export class FakePrisma {
  rows: Row[] = [];
  items: Row[] = [];
  nextItemId = 1n; // BigInt, like the real autoincrement column
  commitThenThrow = false; // commit succeeds, but the caller sees an error
  failLoads = false; // reads fail, as if the database were unreachable
  order;
  orderItem;

  constructor() {
    const self = this;

    this.order = {
      async create({ data }: { data: Row }) {
        const now = new Date();

        const row = {
          id: randomUUID(),
          reservationId: null,
          totalAmount: "0.00",
          currency: "NGN",
          status: "PENDING",
          paymentDueAt: null,
          paymentReference: null,
          paidAt: null,
          cancelReason: null,
          sagaState: "DONE",
          requestedItems: null,
          failureStatus: null,
          failureReason: null,
          cancelledAt: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };

        if (
          row.reservationId &&
          self.rows.some((other) => other.reservationId === row.reservationId)
        ) {
          const error = new Error("Unique constraint failed") as Error & { code: string };
          error.code = "P2002";
          throw error;
        }

        self.rows.push(row);
        return self.view(row);
      },

      async findUnique({ where }: { where: Where }) {
        if (self.failLoads) {
          throw new Error("database unreachable");
        }

        const row = self.rows.find((candidate) => matches(candidate, where));
        return row ? self.view(row) : null;
      },

      async findMany({
        where = {},
        take,
        skip = 0,
      }: { where?: Where; take?: number; skip?: number } = {}) {
        if (self.failLoads) {
          throw new Error("database unreachable");
        }

        return self.rows
          .filter((row) => matches(row, where))
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(skip, take === undefined ? undefined : skip + take)
          .map((row) => self.view(row));
      },

      async count({ where = {} }: { where?: Where } = {}) {
        return self.rows.filter((row) => matches(row, where)).length;
      },

      async updateMany({ where, data }: { where: Where; data: Row }) {
        let count = 0;

        for (const row of self.rows) {
          if (matches(row, where)) {
            Object.assign(row, data, { updatedAt: new Date() });
            count += 1;
          }
        }

        return { count };
      },
    };

    this.orderItem = {
      async createMany({ data }: { data: Row[] }) {
        for (const item of data) {
          self.items.push({ id: self.nextItemId++, ...item });
        }
      },
    };
  }

  /** The stored row for an order ID; fails the test if missing. */
  row(id: string): Row {
    const row = this.rows.find((candidate) => candidate.id === id);

    if (!row) {
      throw new Error(`no order row ${id}`);
    }

    return row;
  }

  view(row: Row): OrderWithItems {
    return {
      ...structuredClone(row),
      items: this.items
        .filter((item) => item.orderId === row.id)
        .map((item) => ({ ...item })),
    } as unknown as OrderWithItems;
  }

  async $transaction<T>(fn: (tx: FakePrisma) => Promise<T>): Promise<T> {
    const snapshot = {
      rows: structuredClone(this.rows),
      items: structuredClone(this.items),
    };

    let result: T;

    try {
      result = await fn(this);
    } catch (error) {
      // A failed transaction leaves nothing behind.
      this.rows = snapshot.rows;
      this.items = snapshot.items;
      throw error;
    }

    if (this.commitThenThrow) {
      throw new Error("connection reset after commit");
    }

    return result;
  }
}

interface FakeProduct {
  name: string;
  price: number;
  stock: number;
  active: boolean;
  reservations: Map<string, number>;
  returns: Set<string>;
}

export class FakeProducts {
  catalog = new Map<string, FakeProduct>();
  down = false; // whole service unreachable
  unreachableFor = new Set<string>(); // reserve fails (503) for these products
  failRelease = false;
  failReturn = false;

  add(
    productId: string,
    {
      name = "Widget",
      price = 10,
      stock = 100,
      active = true,
    }: { name?: string; price?: number; stock?: number; active?: boolean } = {}
  ): void {
    this.catalog.set(productId, {
      name,
      price,
      stock,
      active,
      reservations: new Map(),
      returns: new Set(),
    });
  }

  private product(productId: string): FakeProduct {
    const product = this.catalog.get(productId);

    if (!product) {
      throw new Error(`unknown product ${productId}`);
    }

    return product;
  }

  stock(productId: string): number {
    return this.product(productId).stock;
  }

  markers(productId: string): number {
    return this.product(productId).reservations.size;
  }

  unavailable() {
    return new OrderError("Products service is unavailable", 503);
  }

  async reserve(productId: string, quantity: number, reservationId: string) {
    if (this.down || this.unreachableFor.has(productId)) {
      throw this.unavailable();
    }

    const product = this.catalog.get(productId);

    if (!product || !product.active) {
      throw new OrderError(`Product ${productId} was not found or is inactive`, 404);
    }

    if (!product.reservations.has(reservationId)) {
      if (product.stock < quantity) {
        throw new OrderError(`Insufficient stock for product ${productId}`, 409);
      }

      product.stock -= quantity;
      product.reservations.set(reservationId, quantity);
    }

    return { productId, name: product.name, price: product.price };
  }

  async release(productId: string, quantity: number, reservationId: string) {
    if (this.down || this.failRelease) {
      throw new Error("Products service is unavailable");
    }

    const product = this.catalog.get(productId);

    if (product?.reservations.get(reservationId) === quantity) {
      product.stock += quantity;
      product.reservations.delete(reservationId);
      return true;
    }

    return false;
  }

  async finalize(productId: string, reservationId: string) {
    if (this.down) {
      throw new Error("Products service is unavailable");
    }

    this.catalog.get(productId)?.reservations.delete(reservationId);
  }

  async returnStock(productId: string, quantity: number, returnId: string) {
    if (this.down || this.failReturn) {
      throw new Error("Products service is unavailable");
    }

    const product = this.product(productId);

    if (product.returns.has(returnId)) {
      return false;
    }

    product.stock += quantity;
    product.returns.add(returnId);
    return true;
  }
}

export class FakeUsers {
  map = new Map<string, { id: string; isActive: boolean; email: string }>();
  down = false;

  add(userId: string, { isActive = true }: { isActive?: boolean } = {}): void {
    this.map.set(userId, { id: userId, isActive, email: `${userId}@example.com` });
  }

  async getUser(userId: string) {
    if (this.down) {
      throw new OrderError("Users service is unavailable", 503);
    }

    return this.map.get(userId) ?? null;
  }
}

interface InitializeArgs {
  orderId: string;
  userId: string;
  email: string;
  amount: number;
  currency: string;
}

export class FakePayments {
  down = false;
  failRefund = false;
  initialized: InitializeArgs[] = [];
  refunds: { orderId: string; reason: string | undefined }[] = []; // one per order
  verified: string[] = [];
  onVerify: ((orderId: string) => Promise<{ status: string }>) | null = null;

  async initializePayment(args: InitializeArgs) {
    if (this.down) {
      throw new OrderError("Payments service is unavailable", 503);
    }

    this.initialized.push(args);

    return {
      status: "PENDING",
      payment: {
        reference: `ref-${args.orderId}`,
        authorizationUrl: `https://checkout.example/${args.orderId}`,
        accessCode: "access-code",
        amount: args.amount,
        currency: args.currency,
      },
    };
  }

  async requestRefund(orderId: string, reason?: string) {
    if (this.down || this.failRefund) {
      throw new Error("Payments service is unavailable");
    }

    if (!this.refunds.some((refund) => refund.orderId === orderId)) {
      this.refunds.push({ orderId, reason });
    }

    return "QUEUED";
  }

  async verifyPayment(orderId: string) {
    if (this.down) {
      throw new OrderError("Payments service is unavailable", 503);
    }

    this.verified.push(orderId);

    return this.onVerify ? this.onVerify(orderId) : { status: "PENDING" };
  }
}

/**
 * Replaces the real Prisma client and the HTTP clients with fakes.
 * Must run before the modules under test are imported.
 */
export function installMocks(mock: MockTracker) {
  const prisma = new FakePrisma();
  const products = new FakeProducts();
  const users = new FakeUsers();
  const payments = new FakePayments();

  const url = (path: string) => new URL(path, import.meta.url).href;

  mock.module(url("../../config/prisma.js"), {
    namedExports: { prisma },
  });

  mock.module(url("../../clients/products.client.js"), {
    namedExports: {
      reserve: (...args: Parameters<FakeProducts["reserve"]>) => products.reserve(...args),
      release: (...args: Parameters<FakeProducts["release"]>) => products.release(...args),
      finalize: (...args: Parameters<FakeProducts["finalize"]>) => products.finalize(...args),
      returnStock: (...args: Parameters<FakeProducts["returnStock"]>) => products.returnStock(...args),
    },
  });

  mock.module(url("../../clients/users.client.js"), {
    namedExports: { getUser: (userId: string) => users.getUser(userId) },
  });

  mock.module(url("../../clients/payments.client.js"), {
    namedExports: {
      initializePayment: (args: InitializeArgs) => payments.initializePayment(args),
      requestRefund: (orderId: string, reason?: string) => payments.requestRefund(orderId, reason),
      verifyPayment: (orderId: string) => payments.verifyPayment(orderId),
    },
  });

  return { prisma, products, users, payments };
}
