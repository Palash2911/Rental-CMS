/*
  Warnings:

  - You are about to drop the column `deletionScheduledAt` on the `TenantAssignment` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "TenantAssignment" DROP COLUMN "deletionScheduledAt";

-- CreateIndex
CREATE INDEX "ActivityLog_entityType_entityId_createdAt_idx" ON "ActivityLog"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_performedByUserId_idx" ON "ActivityLog"("performedByUserId");

-- CreateIndex
CREATE INDEX "LeaveRequest_tenantAssignmentId_idx" ON "LeaveRequest"("tenantAssignmentId");

-- CreateIndex
CREATE INDEX "OwnerAccount_status_createdAt_id_idx" ON "OwnerAccount"("status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "OwnerAccount_deletionScheduledAt_idx" ON "OwnerAccount"("deletionScheduledAt");

-- CreateIndex
CREATE INDEX "OwnerAccountMember_ownerAccountId_idx" ON "OwnerAccountMember"("ownerAccountId");
