import { config } from "../config";

export function formatMoney(
  amount: number | string,
  currency: string = config.currency
): string {
  const value = typeof amount === "string" ? Number(amount) : amount;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

export function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export const shortId = (id: string) => id.slice(0, 8);

/** True when the amount has at most two decimals (the products API rejects anything finer). */
export const isWholeCents = (value: number) =>
  Number.isFinite(value) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
