// Frontend routes the emails link to. The frontend is not designed yet, so these are the
// backend's proposal; change them here once its routes exist.
export const FRONTEND_PATHS = Object.freeze({
  INVITATIONS: "invitations",
  MEMBER_INVITATIONS: "member-invitations",
  HOUSES: "houses",
  LEAVE_REQUESTS: "leave-requests",
  TENANCIES: "tenancies",
  ACCOUNTS: "accounts",
  BILLING: "billing",
});

/** "Hi Name," or "Hi," when the user has no name. */
export function greeting(name) {
  return name ? `Hi ${name},` : "Hi,";
}
