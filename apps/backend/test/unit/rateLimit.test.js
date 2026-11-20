import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clientIp } from "../../src/lib/rateLimit.js";

function fromSocket(remoteAddress) {
  return clientIp({ req: { socket: { remoteAddress } }, trustProxy: false });
}

function forwarded(value, trustProxy = true) {
  const request = new Request("http://localhost/graphql", { headers: { "x-forwarded-for": value } });
  return clientIp({ request, req: { socket: { remoteAddress: "10.0.0.1" } }, trustProxy });
}

describe("clientIp", () => {
  it("keeps IPv4 per address, including IPv4-mapped IPv6", () => {
    assert.equal(fromSocket("192.0.2.1"), "192.0.2.1");
    assert.equal(fromSocket("192.0.2.2"), "192.0.2.2");
    assert.equal(fromSocket("::ffff:192.0.2.1"), "192.0.2.1");
  });

  it("buckets IPv6 by its /64 prefix in one canonical form", () => {
    const cases = [
      ["2001:db8:0:1::1", "2001:db8:0:1::/64"],
      ["2001:db8:0:1:ffff:ffff:ffff:ffff", "2001:db8:0:1::/64"],
      ["2001:0DB8:0000:0001:aaaa:bbbb:cccc:dddd", "2001:db8:0:1::/64"],
      ["2001:db8:0:2::1", "2001:db8:0:2::/64"],
      ["2001:db8::1", "2001:db8:0:0::/64"],
      ["2001:db8:1:2:3::", "2001:db8:1:2::/64"],
      ["fe80::1%eth0", "fe80:0:0:0::/64"],
      ["64:ff9b::192.0.2.1", "64:ff9b:0:0::/64"],
      ["1:2:3:4:5:6:1.2.3.4", "1:2:3:4::/64"],
      ["::1", "0:0:0:0::/64"],
    ];

    for (const [address, bucket] of cases) {
      assert.equal(fromSocket(address), bucket, address);
    }
  });

  it("applies the same bucketing to a trusted X-Forwarded-For entry", () => {
    assert.equal(forwarded("198.51.100.7, 2001:db8:0:1::abcd"), "2001:db8:0:1::/64");
    assert.equal(forwarded("2001:db8:0:1::abcd", false), "10.0.0.1");
    assert.equal(forwarded("not an ip"), "10.0.0.1");
  });

  it("uses one shared bucket when no address is known", () => {
    assert.equal(clientIp({ trustProxy: false }), "unknown");
  });
});
