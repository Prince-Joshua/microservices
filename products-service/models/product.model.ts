import mongoose, { type HydratedDocument } from "mongoose";

export interface IReservation {
  reservationId: string;
  quantity: number;
  /** Absent only on reservations written before the field existed. */
  createdAt?: Date;
}

export interface IStockReturn {
  returnId: string;
  quantity: number;
  createdAt: Date;
}

export interface IProduct {
  name: string;
  price: number;
  stockQuantity: number;
  isActive: boolean;
  reservations: IReservation[];
  stockReturns: IStockReturn[];
  createdAt: Date;
  updatedAt: Date;
}

export type ProductDocument = HydratedDocument<IProduct>;

const reservationSchema = new mongoose.Schema<IReservation>(
  {
    reservationId: {
      type: String,
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    // Lets the reconciler find reservations whose order never committed.
    createdAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  { _id: false }
);

// Ledger of stock handed back after a confirmed order was cancelled.
// A returnId is applied at most once, so retried cancellations can't
// add the same stock twice. The reconciler prunes old entries.
const stockReturnSchema = new mongoose.Schema<IStockReturn>(
  {
    returnId: {
      type: String,
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    createdAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  { _id: false }
);

const productSchema = new mongoose.Schema<IProduct>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    stockQuantity: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    reservations: {
      type: [reservationSchema],
      default: [],
    },
    stockReturns: {
      type: [stockReturnSchema],
      default: [],
    },
  },
  { timestamps: true }
);

// Multikey indexes: keep the reservation/return lookups from scanning
// every product.
productSchema.index({ "reservations.reservationId": 1 });
productSchema.index({ "stockReturns.returnId": 1 });
productSchema.index({ name: 1 });

export const Product = mongoose.model<IProduct>("Product", productSchema);
