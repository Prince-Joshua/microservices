import assert from "node:assert/strict";

/** Narrows away null/undefined, failing the test if the value is missing. */
export function must<T>(value: T | null | undefined, what = "a value"): T {
  assert.ok(value !== null && value !== undefined, `expected ${what}`);
  return value;
}
