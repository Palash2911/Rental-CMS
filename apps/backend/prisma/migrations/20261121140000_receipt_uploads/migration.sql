-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN     "receiptUploadId" TEXT;

-- CreateTable
CREATE TABLE "ReceiptUpload" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "ownerAccountId" TEXT NOT NULL,
    "tenantAssignmentId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "attachedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "discardedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceiptUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_receiptUploadId_key" ON "Receipt"("receiptUploadId");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptUpload_key_key" ON "ReceiptUpload"("key");

-- CreateIndex
CREATE INDEX "ReceiptUpload_ownerAccountId_idx" ON "ReceiptUpload"("ownerAccountId");

-- CreateIndex
CREATE INDEX "ReceiptUpload_tenantAssignmentId_idx" ON "ReceiptUpload"("tenantAssignmentId");

-- CreateIndex
CREATE INDEX "ReceiptUpload_requestedByUserId_idx" ON "ReceiptUpload"("requestedByUserId");

-- CreateIndex
CREATE INDEX "ReceiptUpload_attachedAt_createdAt_idx" ON "ReceiptUpload"("attachedAt", "createdAt");

-- CreateIndex
CREATE INDEX "ReceiptUpload_attachedAt_verifiedAt_createdAt_idx" ON "ReceiptUpload"("attachedAt", "verifiedAt", "createdAt");

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_receiptUploadId_fkey" FOREIGN KEY ("receiptUploadId") REFERENCES "ReceiptUpload"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptUpload" ADD CONSTRAINT "ReceiptUpload_ownerAccountId_fkey" FOREIGN KEY ("ownerAccountId") REFERENCES "OwnerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptUpload" ADD CONSTRAINT "ReceiptUpload_tenantAssignmentId_fkey" FOREIGN KEY ("tenantAssignmentId") REFERENCES "TenantAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptUpload" ADD CONSTRAINT "ReceiptUpload_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
