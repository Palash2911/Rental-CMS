-- CreateEnum
CREATE TYPE "DeletionReason" AS ENUM ('OWNER_REQUEST', 'ADMIN_REQUEST', 'BILLING_GRACE');

-- AlterTable
ALTER TABLE "OwnerAccount" ADD COLUMN     "deletionReason" "DeletionReason";

-- CreateIndex
CREATE INDEX "Invitation_expiresAt_idx" ON "Invitation"("expiresAt") WHERE ("status" = 'PENDING');

-- CreateIndex
CREATE INDEX "MemberInvitation_expiresAt_idx" ON "MemberInvitation"("expiresAt") WHERE ("status" = 'PENDING');
