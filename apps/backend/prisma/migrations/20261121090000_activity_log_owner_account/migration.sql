-- DropIndex
DROP INDEX "ActivityLog_performedByUserId_idx";

-- AlterTable
ALTER TABLE "ActivityLog" ADD COLUMN     "ownerAccountId" TEXT;

-- Backfill ownerAccountId where the entry's account can still be resolved. Runs before the
-- indexes and the foreign key are created, so the updates do not maintain them row by row.
-- Each statement only fills rows still NULL, so earlier (more direct) sources win.

UPDATE "ActivityLog" a SET "ownerAccountId" = o."id"
FROM "OwnerAccount" o
WHERE a."entityType" = 'OwnerAccount' AND a."ownerAccountId" IS NULL AND o."id" = a."entityId";

UPDATE "ActivityLog" a SET "ownerAccountId" = h."ownerAccountId"
FROM "House" h
WHERE a."entityType" = 'House' AND a."ownerAccountId" IS NULL AND h."id" = a."entityId";

UPDATE "ActivityLog" a SET "ownerAccountId" = h."ownerAccountId"
FROM "Invitation" i JOIN "House" h ON h."id" = i."houseId"
WHERE a."entityType" = 'Invitation' AND a."ownerAccountId" IS NULL AND i."id" = a."entityId";

UPDATE "ActivityLog" a SET "ownerAccountId" = h."ownerAccountId"
FROM "TenantAssignment" t JOIN "House" h ON h."id" = t."houseId"
WHERE a."entityType" = 'TenantAssignment' AND a."ownerAccountId" IS NULL AND t."id" = a."entityId";

UPDATE "ActivityLog" a SET "ownerAccountId" = h."ownerAccountId"
FROM "Receipt" r
JOIN "TenantAssignment" t ON t."id" = r."tenantAssignmentId"
JOIN "House" h ON h."id" = t."houseId"
WHERE a."entityType" = 'Receipt' AND a."ownerAccountId" IS NULL AND r."id" = a."entityId";

UPDATE "ActivityLog" a SET "ownerAccountId" = h."ownerAccountId"
FROM "Issue" i JOIN "House" h ON h."id" = i."houseId"
WHERE a."entityType" = 'Issue' AND a."ownerAccountId" IS NULL AND i."id" = a."entityId";

UPDATE "ActivityLog" a SET "ownerAccountId" = h."ownerAccountId"
FROM "LeaveRequest" l JOIN "House" h ON h."id" = l."houseId"
WHERE a."entityType" = 'LeaveRequest' AND a."ownerAccountId" IS NULL AND l."id" = a."entityId";

UPDATE "ActivityLog" a SET "ownerAccountId" = m."ownerAccountId"
FROM "MemberInvitation" m
WHERE a."entityType" = 'MemberInvitation' AND a."ownerAccountId" IS NULL AND m."id" = a."entityId";

UPDATE "ActivityLog" a SET "ownerAccountId" = m."ownerAccountId"
FROM "OwnerAccountMember" m
WHERE a."entityType" = 'OwnerAccountMember' AND a."ownerAccountId" IS NULL AND m."id" = a."entityId";

UPDATE "ActivityLog" a SET "ownerAccountId" = s."ownerAccountId"
FROM "Subscription" s
WHERE a."entityType" = 'Subscription' AND a."ownerAccountId" IS NULL AND s."id" = a."entityId";

-- CUSTOMER_EMAIL_SYNC_FAILED is logged on Subscription with the owner account id as entityId.
UPDATE "ActivityLog" a SET "ownerAccountId" = o."id"
FROM "OwnerAccount" o
WHERE a."entityType" = 'Subscription' AND a."ownerAccountId" IS NULL AND o."id" = a."entityId";

-- A TenantProfile is created by accepting an invitation; the entry belongs to that account.
UPDATE "ActivityLog" a SET "ownerAccountId" = h."ownerAccountId"
FROM "Invitation" i JOIN "House" h ON h."id" = i."houseId"
WHERE a."entityType" = 'TenantProfile' AND a."ownerAccountId" IS NULL
  AND i."id" = a."metadata" ->> 'invitationId';

-- Entities that no longer exist (removed members, data of deleted accounts): fall back to
-- metadata.ownerAccountId when it names an existing account.
UPDATE "ActivityLog" a SET "ownerAccountId" = o."id"
FROM "OwnerAccount" o
WHERE a."ownerAccountId" IS NULL AND o."id" = a."metadata" ->> 'ownerAccountId';

-- CreateIndex
CREATE INDEX "ActivityLog_ownerAccountId_createdAt_id_idx" ON "ActivityLog"("ownerAccountId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "ActivityLog_ownerAccountId_entityType_createdAt_id_idx" ON "ActivityLog"("ownerAccountId", "entityType", "createdAt", "id");

-- CreateIndex
CREATE INDEX "ActivityLog_createdAt_id_idx" ON "ActivityLog"("createdAt", "id");

-- CreateIndex
CREATE INDEX "ActivityLog_performedByUserId_createdAt_id_idx" ON "ActivityLog"("performedByUserId", "createdAt", "id");

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_ownerAccountId_fkey" FOREIGN KEY ("ownerAccountId") REFERENCES "OwnerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
