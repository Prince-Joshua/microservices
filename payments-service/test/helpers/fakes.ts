import { randomUUID } from "node:crypto";
import type { MockTracker } from "node:test";

import type { Payment } from "@prisma/client";

import { PaystackError } from "../../errors.js";

/**
 * In-memory stand-ins for Postgres, Paystack and the Orders service, so
 * the payment lifecycle can be exercised through failures without any
 * infrastructure. They imitate only the behaviour the code relies on.
 */

type Where = Record<string, unknown>;

function matches(row: Record<string, unknown>, where: Where = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      const condition = expected as { lt?: unknown; in?: unknown[]; not?: unknown };

      // Like SQL, a NULL never satisfies a comparison.
      if ("lt" in expected) {
        return row[key] != null && (row[key] as Date) < (condition.lt as Date);
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
  rows: Payment[] = [];
  payment;

  constructor() {
    const self = this;

    this.payment = {
      async create({ data }: { data: Partial<Payment> & Pick<Payment, "orderId" | "attempt" | "reference"> }): Promise<Payment> {
        const now = new Date();

        const row = {
          id: randomUUID(),
          status: "PENDING",
          authorizationUrl: null,
          accessCode: null,
          paystackId: null,
          paidAt: null,
          notifiedAt: null,
          orderAccepted: null,
          rejectReason: null,
          refundState: "NONE",
          refundReason: null,
          refundAttempts: 0,
          refundedAt: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        } as Payment;

        const duplicate = self.rows.some(
          (other) =>
            other.reference === row.reference ||
            (other.orderId === row.orderId && other.attempt === row.attempt)
        );

        if (duplicate) {
          const error = new Error("Unique constraint failed") as Error & { code: string };
          error.code = "P2002";
          throw error;
        }

        self.rows.push(row);
        return { ...row };
      },

      async findUnique({ where }: { where: Where }): Promise<Payment | null> {
        const row = self.rows.find((candidate) => matches({ ...candidate }, where));
        return row ? { ...row } : null;
      },

      async findMany({ where = {}, take }: { where?: Where; take?: number } = {}): Promise<Payment[]> {
        return self.rows
          .filter((row) => matches({ ...row }, where))
          .slice(0, take)
          .map((row) => ({ ...row }));
      },

      async updateMany({ where, data }: { where: Where; data: Partial<Payment> }) {
        let count = 0;

        for (const row of self.rows) {
          if (matches({ ...row }, where)) {
            Object.assign(row, { updatedAt: new Date() }, data);
            count += 1;
          }
        }

        return { count };
      },
    };
  }

  /** The stored row for a reference; fails the test if it doesn't exist. */
  get(reference: string): Payment {
    const row = this.rows.find((candidate) => candidate.reference === reference);

    if (!row) {
      throw new Error(`no payment row for ${reference}`);
    }

    return row;
  }
}

interface FakeTransaction {
  id: number;
  status: string;
  amount: number;
  currency: string;
  reference: string;
}

interface FakeRefund {
  transactionId: number;
  transaction: string;
  amount: number;
  status: string;
}

interface InitArgs {
  email: string;
  amount: number;
  currency: string;
  reference: string;
  callbackUrl?: string | undefined;
  metadata?: Record<string, unknown>;
}

export class FakePaystack {
  transactions = new Map<string, FakeTransaction>(); // by reference
  refunds: FakeRefund[] = []; // created refunds
  nextId = 1000;
  failInit = false;
  failVerify = false;
  failRefund = false;
  refundThenThrow = false; // refund is created, but the caller sees an error
  initCalls: InitArgs[] = [];

  constructor() {
    this.reset();
  }

  reset(): void {
    this.transactions = new Map();
    this.refunds = [];
    this.nextId = 1000;
    this.failInit = false;
    this.failVerify = false;
    this.failRefund = false;
    this.refundThenThrow = false;
    this.initCalls = [];
  }

  private transaction(reference: string): FakeTransaction {
    const found = this.transactions.get(reference);

    if (!found) {
      throw new Error(`unknown transaction ${reference}`);
    }

    return found;
  }

  // The customer completes checkout.
  pay(reference: string, overrides: Partial<FakeTransaction> = {}): void {
    Object.assign(this.transaction(reference), { status: "success" }, overrides);
  }

  async initializeTransaction(args: InitArgs) {
    this.initCalls.push(args);

    if (this.failInit) {
      throw new PaystackError("Paystack unreachable", { transient: true });
    }

    this.transactions.set(args.reference, {
      id: this.nextId++,
      status: "abandoned",
      amount: args.amount,
      currency: args.currency,
      reference: args.reference,
    });

    return {
      authorizationUrl: `https://checkout.paystack.test/${args.reference}`,
      accessCode: `ac-${args.reference}`,
      reference: args.reference,
    };
  }

  async verifyTransaction(reference: string) {
    if (this.failVerify) {
      throw new PaystackError("Paystack unreachable", { transient: true });
    }

    const transaction = this.transactions.get(reference);

    if (!transaction) {
      throw new PaystackError("Transaction reference not found", {
        httpStatus: 400,
      });
    }

    return { ...transaction };
  }

  async listRefunds(transactionId: string | number) {
    return this.refunds.filter((refund) => refund.transactionId === Number(transactionId));
  }

  async createRefund({ transaction }: { transaction: string }) {
    if (this.failRefund) {
      throw new PaystackError("Paystack unreachable", { transient: true });
    }

    const original = this.transaction(transaction);

    this.refunds.push({
      transactionId: original.id,
      transaction,
      amount: original.amount,
      status: "pending",
    });

    if (this.refundThenThrow) {
      this.refundThenThrow = false;
      throw new PaystackError("Paystack unreachable", { transient: true });
    }

    return { status: "pending" };
  }
}

export class FakeOrders {
  down = false;
  answer: { accepted: boolean; reason?: string } = { accepted: true };
  calls: unknown[] = [];

  async notifyPaymentSucceeded(args: unknown) {
    this.calls.push(args);

    if (this.down) {
      throw new Error("Orders service returned 503");
    }

    return { ...this.answer };
  }
}

/**
 * Replaces Postgres and the HTTP clients with fakes.
 * Must run before the modules under test are imported.
 */
export function installMocks(mock: MockTracker) {
  const prisma = new FakePrisma();
  const paystack = new FakePaystack();
  const orders = new FakeOrders();

  const url = (path: string) => new URL(path, import.meta.url).href;

  mock.module(url("../../config/prisma.js"), {
    namedExports: { prisma },
  });

  mock.module(url("../../clients/paystack.js"), {
    namedExports: {
      initializeTransaction: (args: InitArgs) => paystack.initializeTransaction(args),
      verifyTransaction: (reference: string) => paystack.verifyTransaction(reference),
      createRefund: (args: { transaction: string }) => paystack.createRefund(args),
      listRefunds: (id: string | number) => paystack.listRefunds(id),
    },
  });

  mock.module(url("../../clients/orders.client.js"), {
    namedExports: {
      notifyPaymentSucceeded: (args: unknown) => orders.notifyPaymentSucceeded(args),
    },
  });

  return { prisma, paystack, orders };
}
