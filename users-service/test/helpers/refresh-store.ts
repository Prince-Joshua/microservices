/**
 * An in-memory stand-in for the RefreshToken model. It understands only the
 * query shapes the refresh-token service uses: equality (including null),
 * { $gt: Date } and { $ne: value }.
 */
export interface FakeRefreshRow {
  userId: string;
  familyId: string;
  tokenHash: string;
  sessionStartedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

type Filter = Record<string, unknown>;
type Update = { $set: Record<string, unknown> };

function matches(row: FakeRefreshRow, filter: Filter): boolean {
  const record = row as unknown as Record<string, unknown>;

  return Object.entries(filter).every(([key, condition]) => {
    const value = record[key];

    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      const op = condition as { $gt?: Date; $ne?: unknown };

      if (op.$gt !== undefined) {
        return value instanceof Date && value.getTime() > op.$gt.getTime();
      }

      if ("$ne" in op) {
        return value !== op.$ne;
      }
    }

    return value === condition;
  });
}

export function createFakeRefreshModel() {
  const rows: FakeRefreshRow[] = [];

  const model = {
    async create(data: Omit<FakeRefreshRow, "createdAt">) {
      const row = { ...data, createdAt: new Date() };
      rows.push(row);
      return row;
    },

    async findOne(filter: Filter) {
      return rows.find((row) => matches(row, filter)) ?? null;
    },

    /** Like Mongoose's default: applies the update, returns the document as it was. */
    async findOneAndUpdate(filter: Filter, update: Update) {
      const row = rows.find((candidate) => matches(candidate, filter));

      if (!row) {
        return null;
      }

      const before = { ...row };
      Object.assign(row, update.$set);
      return before;
    },

    async updateMany(filter: Filter, update: Update) {
      let modifiedCount = 0;

      for (const row of rows) {
        if (matches(row, filter)) {
          Object.assign(row, update.$set);
          modifiedCount += 1;
        }
      }

      return { modifiedCount };
    },
  };

  return { model, rows };
}
