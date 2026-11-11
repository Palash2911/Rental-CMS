/*
  Warnings:

  - Added the required column `houseId` to the `Issue` table without a default value. This is not possible if the table is not empty.
  - Added the required column `amountCents` to the `Receipt` table without a default value. This is not possible if the table is not empty.
  - Added the required column `paidAt` to the `Receipt` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Issue" ADD COLUMN     "houseId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN     "amountCents" INTEGER NOT NULL,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'AUD',
ADD COLUMN     "note" TEXT,
ADD COLUMN     "paidAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "fileUrl" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Issue_tenantAssignmentId_createdAt_id_idx" ON "Issue"("tenantAssignmentId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Issue_tenantAssignmentId_status_createdAt_id_idx" ON "Issue"("tenantAssignmentId", "status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Issue_houseId_createdAt_id_idx" ON "Issue"("houseId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Issue_houseId_status_createdAt_id_idx" ON "Issue"("houseId", "status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Receipt_tenantAssignmentId_uploadedAt_id_idx" ON "Receipt"("tenantAssignmentId", "uploadedAt", "id");

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_houseId_fkey" FOREIGN KEY ("houseId") REFERENCES "House"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
