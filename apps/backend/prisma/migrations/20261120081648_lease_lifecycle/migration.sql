/*
  Warnings:

  - You are about to drop the column `approved` on the `LeaveRequest` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[tenantAssignmentId]` on the table `LeaveRequest` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `houseId` to the `LeaveRequest` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `LeaveRequest` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "LeaveRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- DropIndex
DROP INDEX "LeaveRequest_tenantAssignmentId_idx";

-- AlterTable
ALTER TABLE "LeaveRequest" DROP COLUMN "approved",
ADD COLUMN     "houseId" TEXT NOT NULL,
ADD COLUMN     "respondedAt" TIMESTAMP(3),
ADD COLUMN     "respondedByUserId" TEXT,
ADD COLUMN     "status" "LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "reason" DROP NOT NULL;

-- AlterTable
ALTER TABLE "TenantAssignment" ADD COLUMN     "plannedExitDate" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "LeaveRequest_tenantAssignmentId_createdAt_id_idx" ON "LeaveRequest"("tenantAssignmentId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "LeaveRequest_tenantAssignmentId_status_createdAt_id_idx" ON "LeaveRequest"("tenantAssignmentId", "status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "LeaveRequest_houseId_createdAt_id_idx" ON "LeaveRequest"("houseId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "LeaveRequest_houseId_status_createdAt_id_idx" ON "LeaveRequest"("houseId", "status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "LeaveRequest_respondedByUserId_idx" ON "LeaveRequest"("respondedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveRequest_tenantAssignmentId_key" ON "LeaveRequest"("tenantAssignmentId") WHERE ("status" = 'PENDING');

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_houseId_fkey" FOREIGN KEY ("houseId") REFERENCES "House"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_respondedByUserId_fkey" FOREIGN KEY ("respondedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
