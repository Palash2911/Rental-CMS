import { z } from "zod";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

const MAX_CURSOR_LENGTH = 512;
const MAX_CURSOR_ID_LENGTH = 128;
const CURSOR_ENCODING = "base64url";
const SORT_DIRECTION = "desc";
const INVALID_CURSOR_MESSAGE = "Invalid pagination cursor.";

const cursorPayloadSchema = z.object({
  c: z.iso.datetime(),
  i: z.string().min(1).max(MAX_CURSOR_ID_LENGTH),
});

function decodeCursor(value) {
  let payload;

  try {
    payload = JSON.parse(Buffer.from(value, CURSOR_ENCODING).toString("utf8"));
  } catch {
    return null;
  }

  const result = cursorPayloadSchema.safeParse(payload);

  if (!result.success) {
    return null;
  }

  return { createdAt: new Date(result.data.c), id: result.data.i };
}

function encodeCursor(row) {
  const payload = { c: row.createdAt.toISOString(), i: row.id };
  return Buffer.from(JSON.stringify(payload)).toString(CURSOR_ENCODING);
}

/** Zod fields for `first` and `after`; spread into a domain schema's z.object(). */
export const paginationFields = Object.freeze({
  first: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .nullish()
    .transform((value) => value ?? DEFAULT_PAGE_SIZE),
  after: z
    .string()
    .max(MAX_CURSOR_LENGTH)
    .refine((value) => decodeCursor(value) !== null, INVALID_CURSOR_MESSAGE)
    .transform(decodeCursor)
    .nullish(),
});

/**
 * Returns `{ where, orderBy, take }` for a keyset page ordered by createdAt, then id, newest first.
 * The caller combines `where` with its own filter using AND and must select `createdAt` and `id`.
 */
export function buildPageQuery({ first, after }) {
  const where = after
    ? {
        OR: [
          { createdAt: { lt: after.createdAt } },
          { createdAt: after.createdAt, id: { lt: after.id } },
        ],
      }
    : {};

  return {
    where,
    orderBy: [{ createdAt: SORT_DIRECTION }, { id: SORT_DIRECTION }],
    take: first + 1,
  };
}

/** Builds `{ items, pageInfo: { nextCursor, hasNextPage } }` from rows fetched with buildPageQuery. */
export function toPage(rows, first, toItem) {
  const hasNextPage = rows.length > first;
  const pageRows = hasNextPage ? rows.slice(0, first) : rows;
  const nextCursor = hasNextPage ? encodeCursor(pageRows.at(-1)) : null;

  return {
    items: pageRows.map(toItem),
    pageInfo: { nextCursor, hasNextPage },
  };
}
