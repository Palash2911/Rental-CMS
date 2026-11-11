/*
  Warnings:

  - A unique constraint covering the columns `[tenantProfileId,houseId]` on the table `TenantAssignment` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED');

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "houseId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "invitedByUserId" TEXT NOT NULL,
    "leaseStartDate" TIMESTAMP(3) NOT NULL,
    "leaseEndDate" TIMESTAMP(3),
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "acceptedAssignmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_acceptedAssignmentId_key" ON "Invitation"("acceptedAssignmentId");

-- CreateIndex
CREATE INDEX "Invitation_houseId_createdAt_id_idx" ON "Invitation"("houseId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Invitation_houseId_status_createdAt_id_idx" ON "Invitation"("houseId", "status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Invitation_email_createdAt_id_idx" ON "Invitation"("email", "createdAt", "id") WHERE ("status" = 'PENDING');

-- CreateIndex
CREATE INDEX "Invitation_invitedByUserId_idx" ON "Invitation"("invitedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_houseId_email_key" ON "Invitation"("houseId", "email") WHERE ("status" = 'PENDING');

-- CreateIndex
CREATE INDEX "House_ownerAccountId_createdAt_id_idx" ON "House"("ownerAccountId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "TenantAssignment_houseId_createdAt_id_idx" ON "TenantAssignment"("houseId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "TenantAssignment_tenantProfileId_createdAt_id_idx" ON "TenantAssignment"("tenantProfileId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TenantAssignment_tenantProfileId_houseId_key" ON "TenantAssignment"("tenantProfileId", "houseId") WHERE ("status" != 'EXITED');

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_houseId_fkey" FOREIGN KEY ("houseId") REFERENCES "House"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_acceptedAssignmentId_fkey" FOREIGN KEY ("acceptedAssignmentId") REFERENCES "TenantAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
