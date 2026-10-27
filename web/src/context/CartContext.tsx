import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Product } from "../api/types";

export interface CartLine {
  productId: string;
  name: string;
  price: number;
  /** Optional: carts saved before images existed don't have it. */
  imageUrl?: string;
  /** Stock when the item was added; used as an upper bound in the UI (the server has the final say). */
  maxQuantity: number;
  quantity: number;
}

interface CartState {
  lines: CartLine[];
  /** Idempotency-Key for the next checkout. Changes whenever the cart does. */
  checkoutKey: string;
}

interface CartValue {
  lines: CartLine[];
  count: number;
  total: number;
  checkoutKey: string;
  add: (product: Product, quantity?: number) => void;
  setQuantity: (productId: string, quantity: number) => void;
  remove: (productId: string) => void;
  clear: () => void;
  /** Start a fresh key (after the server rolled an attempt back). */
  resetKey: () => void;
}

const CART_KEY = "shop.cart";

// 36 chars of hex and '-': matches the orders-service Idempotency-Key pattern.
const newKey = () => crypto.randomUUID();

function load(): CartState {
  try {
    const raw = localStorage.getItem(CART_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as CartState;
      if (Array.isArray(parsed.lines) && typeof parsed.checkoutKey === "string") return parsed;
    }
  } catch {
    /* ignore */
  }
  return { lines: [], checkoutKey: newKey() };
}

const CartContext = createContext<CartValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CartState>(load);

  useEffect(() => {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [state]);

  // Every edit changes the key: a key may only ever be used with one set of items.
  const edit = useCallback((fn: (lines: CartLine[]) => CartLine[]) => {
    setState((s) => ({ lines: fn(s.lines), checkoutKey: newKey() }));
  }, []);

  const add = useCallback<CartValue["add"]>(
    (product, quantity = 1) =>
      edit((lines) => {
        const existing = lines.find((l) => l.productId === product.id);
        if (existing) {
          return lines.map((l) =>
            l.productId === product.id
              ? {
                  ...l,
                  price: product.price,
                  imageUrl: product.imageUrl,
                  maxQuantity: product.stockQuantity,
                  quantity: Math.min(l.quantity + quantity, product.stockQuantity),
                }
              : l
          );
        }
        return [
          ...lines,
          {
            productId: product.id,
            name: product.name,
            price: product.price,
            imageUrl: product.imageUrl,
            maxQuantity: product.stockQuantity,
            quantity: Math.min(quantity, product.stockQuantity),
          },
        ];
      }),
    [edit]
  );

  const setQuantity = useCallback<CartValue["setQuantity"]>(
    (productId, quantity) =>
      edit((lines) =>
        lines.map((l) =>
          l.productId === productId
            ? { ...l, quantity: Math.max(1, Math.min(Math.floor(quantity) || 1, l.maxQuantity)) }
            : l
        )
      ),
    [edit]
  );

  const remove = useCallback(
    (productId: string) => edit((lines) => lines.filter((l) => l.productId !== productId)),
    [edit]
  );
  const clear = useCallback(() => edit(() => []), [edit]);
  const resetKey = useCallback(() => setState((s) => ({ ...s, checkoutKey: newKey() })), []);

  const value = useMemo<CartValue>(
    () => ({
      lines: state.lines,
      count: state.lines.reduce((n, l) => n + l.quantity, 0),
      total: state.lines.reduce((sum, l) => sum + l.price * l.quantity, 0),
      checkoutKey: state.checkoutKey,
      add,
      setQuantity,
      remove,
      clear,
      resetKey,
    }),
    [state, add, setQuantity, remove, clear, resetKey]
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used inside <CartProvider>");
  return ctx;
}
