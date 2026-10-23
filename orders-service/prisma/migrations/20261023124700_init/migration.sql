-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'AWAITING_PAYMENT', 'CONFIRMED', 'FULFILLED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "SagaState" AS ENUM ('RUNNING', 'COMPENSATING', 'DONE');

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "reservationId" TEXT,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "paymentDueAt" TIMESTAMPTZ(6),
    "paymentReference" TEXT,
    "paidAt" TIMESTAMPTZ(6),
    "cancelReason" TEXT,
    "sagaState" "SagaState" NOT NULL DEFAULT 'DONE',
    "requestedItems" JSONB,
    "failureStatus" INTEGER,
    "failureReason" TEXT,
    "cancelledAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" BIGSERIAL NOT NULL,
    "orderId" UUID NOT NULL,
    "productId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_reservationId_key" ON "orders"("reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_paymentReference_key" ON "orders"("paymentReference");

-- CreateIndex
CREATE INDEX "orders_userId_createdAt_idx" ON "orders"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "orders_status_sagaState_updatedAt_idx" ON "orders"("status", "sagaState", "updatedAt");

-- CreateIndex
CREATE INDEX "orders_status_paymentDueAt_idx" ON "orders"("status", "paymentDueAt");

-- CreateIndex
CREATE INDEX "order_items_orderId_idx" ON "order_items"("orderId");

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
