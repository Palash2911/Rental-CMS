import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createStorageClient,
  createStorageGateway,
  DELETE_BATCH_SIZE,
} from "../../src/storage/gateway.js";

// Presigning is local signing with static credentials: no request leaves the process.
const CONFIG = Object.freeze({
  endpoint: "https://account-id.r2.cloudflarestorage.com",
  region: "auto",
  accessKeyId: "test-access-key-id",
  secretAccessKey: "test-secret-access-key",
  bucket: "rental-cms-test",
});

const KEY = "receipts/cacct0001/cassign001/0f8fad5b-d9cb-469f-a165-70867728950e.pdf";

function gateway() {
  return createStorageGateway(createStorageClient(CONFIG), { bucket: CONFIG.bucket });
}

function signedHeaders(url) {
  return new URL(url).searchParams.get("X-Amz-SignedHeaders").split(";");
}

describe("storage gateway presigning", () => {
  it("signs content-type and content-length into the upload URL, so neither can change", async () => {
    const url = await gateway().presignUpload({
      key: KEY,
      contentType: "application/pdf",
      sizeBytes: 12_345,
      expiresInSeconds: 600,
    });
    const parsed = new URL(url);

    assert.deepEqual(signedHeaders(url).sort(), ["content-length", "content-type", "host"]);
    assert.equal(parsed.searchParams.get("X-Amz-Expires"), "600");
    assert.ok(parsed.pathname.endsWith(KEY));
  });

  it("puts no checksum into the upload URL, which would make every real upload fail", async () => {
    const url = await gateway().presignUpload({ key: KEY, contentType: "image/png", sizeBytes: 1, expiresInSeconds: 600 });
    const names = [...new URL(url).searchParams.keys()].map((name) => name.toLowerCase());

    assert.deepEqual(names.filter((name) => name.includes("checksum")), []);
  });

  it("signs a download URL for the requested lifetime", async () => {
    const url = await gateway().presignDownload({ key: KEY, expiresInSeconds: 300 });

    assert.equal(new URL(url).searchParams.get("X-Amz-Expires"), "300");
    assert.deepEqual(signedHeaders(url), ["host"]);
  });

  it("signs a download as an attachment named after the key, so it never opens inline", async () => {
    const url = await gateway().presignDownload({ key: KEY, expiresInSeconds: 300 });
    const odd = await gateway().presignDownload({ key: 'receipts/a/b/evil"name.pdf', expiresInSeconds: 300 });

    assert.equal(
      new URL(url).searchParams.get("response-content-disposition"),
      'attachment; filename="0f8fad5b-d9cb-469f-a165-70867728950e.pdf"',
    );
    assert.equal(new URL(odd).searchParams.get("response-content-disposition"), 'attachment; filename="receipt"');
  });
});

describe("storage gateway deleteObjects", () => {
  it("does nothing for an empty batch and refuses one over the batch limit, before any request", async () => {
    await gateway().deleteObjects([]);
    await assert.rejects(
      gateway().deleteObjects(Array.from({ length: DELETE_BATCH_SIZE + 1 }, (_, index) => `k${index}`)),
      RangeError,
    );
  });
});
