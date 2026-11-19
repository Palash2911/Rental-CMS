/*
  Warnings:

  - A unique constraint covering the columns `[ownerAccountId]` on the table `OwnerAccountMember` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "OwnerAccountMember_ownerAccountId_idx";

-- CreateTable
CREATE TABLE "MemberInvitation" (
    "id" TEXT NOT NULL,
    "ownerAccountId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "invitedByUserId" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemberInvitation_ownerAccountId_createdAt_id_idx" ON "MemberInvitation"("ownerAccountId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "MemberInvitation_ownerAccountId_status_createdAt_id_idx" ON "MemberInvitation"("ownerAccountId", "status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "MemberInvitation_email_createdAt_id_idx" ON "MemberInvitation"("email", "createdAt", "id") WHERE ("status" = 'PENDING');

-- CreateIndex
CREATE INDEX "MemberInvitation_invitedByUserId_idx" ON "MemberInvitation"("invitedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberInvitation_ownerAccountId_email_key" ON "MemberInvitation"("ownerAccountId", "email") WHERE ("status" = 'PENDING');

-- CreateIndex
CREATE INDEX "OwnerAccountMember_ownerAccountId_createdAt_id_idx" ON "OwnerAccountMember"("ownerAccountId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OwnerAccountMember_ownerAccountId_key" ON "OwnerAccountMember"("ownerAccountId") WHERE ("role" = 'PRIMARY');

-- AddForeignKey
ALTER TABLE "MemberInvitation" ADD CONSTRAINT "MemberInvitation_ownerAccountId_fkey" FOREIGN KEY ("ownerAccountId") REFERENCES "OwnerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberInvitation" ADD CONSTRAINT "MemberInvitation_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
