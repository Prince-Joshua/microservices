-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "RefundState" AS ENUM ('NONE', 'OWED', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "orderId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "authorizationUrl" TEXT,
    "accessCode" TEXT,
    "paystackId" BIGINT,
    "paidAt" TIMESTAMPTZ(6),
    "notifiedAt" TIMESTAMPTZ(6),
    "orderAccepted" BOOLEAN,
    "rejectReason" TEXT,
    "refundState" "RefundState" NOT NULL DEFAULT 'NONE',
    "refundReason" TEXT,
    "refundAttempts" INTEGER NOT NULL DEFAULT 0,
    "refundedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_reference_key" ON "payments"("reference");

-- CreateIndex
CREATE INDEX "payments_orderId_idx" ON "payments"("orderId");

-- CreateIndex
CREATE INDEX "payments_status_updatedAt_idx" ON "payments"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "payments_status_notifiedAt_idx" ON "payments"("status", "notifiedAt");

-- CreateIndex
CREATE INDEX "payments_refundState_updatedAt_idx" ON "payments"("refundState", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "payments_orderId_attempt_key" ON "payments"("orderId", "attempt");
