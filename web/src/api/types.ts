export type Role = "customer" | "admin";

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface Paged<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
}

export interface Product {
  id: string;
  name: string;
  price: number;
  stockQuantity: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type OrderStatus =
  | "PENDING"
  | "AWAITING_PAYMENT"
  | "CONFIRMED"
  | "FULFILLED"
  | "CANCELLED"
  | "FAILED";

export const ORDER_STATUSES: OrderStatus[] = [
  "PENDING",
  "AWAITING_PAYMENT",
  "CONFIRMED",
  "FULFILLED",
  "CANCELLED",
  "FAILED",
];

export interface OrderItem {
  id: string;
  orderId: string;
  productId: string;
  productName: string;
  quantity: number;
  /** Decimal serialised as a string, e.g. "19.99" */
  unitPrice: string;
}

export interface Order {
  id: string;
  userId: string;
  /** Decimal serialised as a string, e.g. "39.98" */
  totalAmount: string;
  currency: string;
  status: OrderStatus;
  paymentDueAt: string | null;
  paymentReference: string | null;
  paidAt: string | null;
  cancelReason: string | null;
  failureReason?: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  items: OrderItem[];
}

export interface PaymentInfo {
  reference: string;
  status?: string;
  authorizationUrl?: string | null;
  accessCode?: string | null;
  /** minor units (kobo) */
  amount?: number;
  currency?: string;
}

export interface CreateOrderBody {
  message: string;
  order?: Order;
  payment?: PaymentInfo | null;
  paymentNote?: string;
}

export interface OrderEnvelope {
  message?: string;
  order: Order;
}

export interface PayEnvelope {
  message?: string;
  order: Order;
  payment?: PaymentInfo;
}
