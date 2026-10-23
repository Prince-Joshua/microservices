import { Product, type ProductDocument } from "../models/product.model.js";

export class ReservationError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Atomically decrements stock and records the reservation.
 * Safe to call again with the same reservationId.
 */
export async function reserveStock(
  productId: string,
  quantity: number,
  reservationId: string
): Promise<ProductDocument> {
  const product = await Product.findOneAndUpdate(
    {
      _id: productId,
      isActive: true,
      stockQuantity: { $gte: quantity },
      "reservations.reservationId": { $ne: reservationId },
    },
    {
      $inc: { stockQuantity: -quantity },
      $push: {
        reservations: {
          reservationId,
          quantity,
          createdAt: new Date(),
        },
      },
    },
    { new: true, runValidators: true }
  );

  if (product) {
    return product;
  }

  // If an earlier attempt succeeded but its response was lost,
  // recognize the existing reservation rather than reserving twice.
  const existing = await Product.findOne({
    _id: productId,
    reservations: {
      $elemMatch: { reservationId, quantity },
    },
  });

  if (existing) {
    return existing;
  }

  const productExists = await Product.exists({
    _id: productId,
    isActive: true,
  });

  if (!productExists) {
    throw new ReservationError(
      `Product ${productId} was not found or is inactive`,
      404
    );
  }

  throw new ReservationError(
    `Insufficient stock for product ${productId}`,
    409
  );
}

/**
 * Restores stock only if this reservation still exists.
 * Repeated calls won't restore the same reservation twice.
 */
export async function releaseStock(
  productId: string,
  quantity: number,
  reservationId: string
): Promise<boolean> {
  const result = await Product.updateOne(
    {
      _id: productId,
      reservations: {
        $elemMatch: { reservationId, quantity },
      },
    },
    {
      $inc: { stockQuantity: quantity },
      $pull: {
        reservations: { reservationId },
      },
    }
  );

  // A missing reservation means it has already been released,
  // or it was never successfully created.
  return result.modifiedCount === 1;
}

/**
 * Removes reservation bookkeeping after the order commits.
 * Stock is NOT restored because the sale is now recorded.
 */
export async function finalizeStockReservation(
  productId: unknown,
  reservationId: string
): Promise<void> {
  await Product.updateOne(
    {
      _id: productId,
      "reservations.reservationId": reservationId,
    },
    {
      $pull: {
        reservations: { reservationId },
      },
    }
  );
}

/**
 * Hands stock back after a confirmed order is cancelled.
 * Applied at most once per returnId: true when this call returned the
 * stock, false when that returnId was already applied.
 */
export async function returnStock(
  productId: string,
  quantity: number,
  returnId: string
): Promise<boolean> {
  const result = await Product.updateOne(
    {
      _id: productId,
      "stockReturns.returnId": { $ne: returnId },
    },
    {
      $inc: { stockQuantity: quantity },
      $push: {
        stockReturns: { returnId, quantity, createdAt: new Date() },
      },
    }
  );

  if (result.modifiedCount === 1) {
    return true;
  }

  const alreadyApplied = await Product.exists({
    _id: productId,
    "stockReturns.returnId": returnId,
  });

  if (alreadyApplied) {
    return false;
  }

  throw new ReservationError(`Product ${productId} was not found`, 404);
}
