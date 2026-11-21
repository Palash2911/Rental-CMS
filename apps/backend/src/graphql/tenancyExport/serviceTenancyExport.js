import { ISSUE_SELECT, toPublicIssue } from "../issues/serviceIssues.js";
import {
  LEAVE_REQUEST_SELECT,
  toPublicLeaveRequest,
} from "../leaveRequest/serviceLeaveRequest.js";
import { RECEIPT_SELECT, toPublicReceipt } from "../receipts/serviceReceipts.js";
import { toCalendarDate } from "../tenantAssignment/serviceTenantAssignment.js";

const SORT_DIRECTION = "asc";
const CHRONOLOGICAL = Object.freeze([{ createdAt: SORT_DIRECTION }, { id: SORT_DIRECTION }]);

function optionalCalendarDate(date) {
  return date ? toCalendarDate(date) : null;
}

function toExportAssignment(row) {
  return {
    id: row.id,
    houseId: row.houseId,
    houseName: row.house.name,
    status: row.status,
    leaseStartDate: toCalendarDate(row.leaseStartDate),
    leaseEndDate: optionalCalendarDate(row.leaseEndDate),
    plannedExitDate: optionalCalendarDate(row.plannedExitDate),
    actualExitDate: row.actualExitDate ? row.actualExitDate.toISOString() : null,
  };
}

/**
 * Returns one assignment with every receipt, issue and leave request on it, oldest first,
 * for the tenant to turn into a CSV or PDF. Not paginated: the lists are bounded by one
 * lease, and the query is in the sensitive rate-limit bucket.
 */
export async function exportTenancy(context, { tenantAssignmentId }) {
  const row = await context.prisma.tenantAssignment.findUnique({
    where: { id: tenantAssignmentId },
    select: {
      id: true,
      houseId: true,
      status: true,
      leaseStartDate: true,
      leaseEndDate: true,
      plannedExitDate: true,
      actualExitDate: true,
      house: { select: { name: true } },
      receipts: { select: RECEIPT_SELECT, orderBy: CHRONOLOGICAL },
      issues: { select: ISSUE_SELECT, orderBy: CHRONOLOGICAL },
      leaveRequests: { select: LEAVE_REQUEST_SELECT, orderBy: CHRONOLOGICAL },
    },
  });

  return {
    assignment: toExportAssignment(row),
    receipts: row.receipts.map(toPublicReceipt),
    issues: row.issues.map(toPublicIssue),
    leaveRequests: row.leaveRequests.map(toPublicLeaveRequest),
    generatedAt: new Date().toISOString(),
  };
}
