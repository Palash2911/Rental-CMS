import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Bounded so a slow storage call cannot hold up a request or a job for long. With these
// SDK versions (@smithy/node-http-handler) requestTimeout only logs a warning unless
// throwOnRequestTimeout is set.
const CONNECTION_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;

// The SDK's default (WHEN_SUPPORTED) adds a checksum of the empty presign-time body to
// presigned PUT URLs, which makes every real upload fail. Checksums are sent only when an
// operation requires one (DeleteObjects does: Content-MD5 or a flexible checksum).
const CHECKSUM_MODE = "WHEN_REQUIRED";

// Without signableHeaders the presigner leaves content-type out of the signature
// (s3-request-presigner adds it to unsignableHeaders). Signing both locks the upload to the
// requested type and exact byte size: any other value fails with 403 SignatureDoesNotMatch.
const UPLOAD_SIGNED_HEADERS = Object.freeze(["content-type", "content-length"]);

const HTTP_NOT_FOUND = 404;

/** Most keys a single DeleteObjects call accepts (S3 and R2). */
export const DELETE_BATCH_SIZE = 1000;

/** Creates the S3-compatible client from the provider-neutral config.s3 group. */
export function createStorageClient({ endpoint, region, accessKeyId, secretAccessKey }) {
  return new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: MAX_ATTEMPTS,
    requestChecksumCalculation: CHECKSUM_MODE,
    responseChecksumValidation: CHECKSUM_MODE,
    requestHandler: {
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    },
  });
}

// Keys end in "<uuid>.<ext>" (receiptFiles.js), which is already safe inside a quoted
// filename; anything else falls back to a fixed name.
const SAFE_FILENAME = /^[0-9a-z-]+\.[a-z]{3,4}$/;
const FALLBACK_FILENAME = "receipt";

function downloadDisposition(key) {
  const filename = key.split("/").at(-1);
  return `attachment; filename="${SAFE_FILENAME.test(filename) ? filename : FALLBACK_FILENAME}"`;
}

function isNotFound(error) {
  return error?.$metadata?.httpStatusCode === HTTP_NOT_FOUND;
}

/**
 * The storage calls receipts and the jobs need, injected through the context like the
 * Stripe gateway, so tests pass a fake and never reach the network. Keys are bucket-relative.
 */
export function createStorageGateway(client, { bucket }) {
  return Object.freeze({
    /** A presigned PUT locked to `contentType` and exactly `sizeBytes`. */
    presignUpload({ key, contentType, sizeBytes, expiresInSeconds }) {
      return getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ContentType: contentType,
          ContentLength: sizeBytes,
        }),
        { expiresIn: expiresInSeconds, signableHeaders: new Set(UPLOAD_SIGNED_HEADERS) },
      );
    },

    // Signed response-content-disposition: the browser saves the file instead of rendering
    // it, so an uploaded PDF or image never opens inline from the storage origin.
    presignDownload({ key, expiresInSeconds }) {
      return getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentDisposition: downloadDisposition(key) }),
        { expiresIn: expiresInSeconds },
      );
    },

    /** `{ contentType, sizeBytes }` of the stored object, or null when there is none. */
    async headObject(key) {
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { contentType: head.ContentType ?? null, sizeBytes: head.ContentLength ?? null };
      } catch (error) {
        if (isNotFound(error)) {
          return null;
        }

        throw error;
      }
    },

    /** Lists one page of keys under `prefix`: `{ keys, nextToken }` (nextToken null at the end). */
    async listKeys({ prefix, continuationToken = null }) {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: DELETE_BATCH_SIZE,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      );

      return {
        keys: (page.Contents ?? []).map((object) => object.Key),
        nextToken: page.IsTruncated ? page.NextContinuationToken : null,
      };
    },

    /**
     * Deletes up to DELETE_BATCH_SIZE keys. A missing key counts as deleted. Throws when the
     * call fails or any key could not be deleted, so callers retry the whole batch.
     */
    async deleteObjects(keys) {
      if (keys.length === 0) {
        return;
      }

      if (keys.length > DELETE_BATCH_SIZE) {
        throw new RangeError(`deleteObjects takes at most ${DELETE_BATCH_SIZE} keys.`);
      }

      const result = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((key) => ({ Key: key })), Quiet: true },
        }),
      );

      if (result.Errors?.length) {
        throw new Error(`Storage refused to delete ${result.Errors.length} of ${keys.length} objects.`);
      }
    },
  });
}
