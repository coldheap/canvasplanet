import { describe, expect, it, beforeAll } from "vitest";
import { asnFilePresent, ipv4ToInt, isFlagged, isLoaded, loadAsnDatabase, lookupAsn, stats } from "../asn.js";

describe("ipv4ToInt", () => {
  it("converts dotted quads", () => {
    expect(ipv4ToInt("0.0.0.0")).toBe(0);
    expect(ipv4ToInt("1.2.3.4")).toBe(16909060);
    expect(ipv4ToInt("255.255.255.255")).toBe(4294967295);
    expect(ipv4ToInt("8.8.8.8")).toBe(134744072);
  });

  it("unwraps IPv4-mapped IPv6, which is what a dual-stack listener reports", () => {
    expect(ipv4ToInt("::ffff:1.2.3.4")).toBe(16909060);
  });

  it("rejects anything that is not IPv4", () => {
    expect(ipv4ToInt("2001:db8::1")).toBeNull();
    expect(ipv4ToInt("1.2.3")).toBeNull();
    expect(ipv4ToInt("1.2.3.256")).toBeNull();
    expect(ipv4ToInt("hello")).toBeNull();
    expect(ipv4ToInt("1.2.3.-1")).toBeNull();
  });
});

describe("flagged network list", () => {
  it("knows the major clouds", () => {
    expect(isFlagged(16509)).toBe(true); // AWS
    expect(isFlagged(14061)).toBe(true); // DigitalOcean
    expect(isFlagged(24940)).toBe(true); // Hetzner
  });

  it("does not flag an arbitrary consumer ASN", () => {
    expect(isFlagged(3320)).toBe(false); // Deutsche Telekom
    expect(isFlagged(5607)).toBe(false); // Sky UK
  });
});

// The dataset is fetched by `pnpm geo:fetch` and is not in git, so these
// only run where it is present. Skipping beats failing CI over a missing
// 20 MB download.
describe.skipIf(!asnFilePresent())("lookupAsn against the real dataset", () => {
  beforeAll(async () => {
    await loadAsnDatabase();
  }, 60_000);

  it("loads a large number of ranges", () => {
    expect(isLoaded()).toBe(true);
    expect(stats().ranges).toBeGreaterThan(100_000);
  });

  it("resolves well-known addresses to the right networks", async () => {
    // Google public DNS -> AS15169, which is on the flagged list.
    const google = await lookupAsn("8.8.8.8");
    expect(google?.number).toBe(15169);
    expect(google?.flagged).toBe(true);

    // Cloudflare public DNS -> AS13335.
    const cf = await lookupAsn("1.1.1.1");
    expect(cf?.number).toBe(13335);
  });

  it("flags a datacenter address and leaves private ranges alone", async () => {
    const aws = await lookupAsn("52.94.236.248"); // AWS
    expect(aws?.flagged).toBe(true);

    // RFC1918 is not announced, so it should simply not resolve.
    expect(await lookupAsn("192.168.1.1")).toBeNull();
    expect(await lookupAsn("10.0.0.1")).toBeNull();
  });

  it("returns null for IPv6 rather than guessing", async () => {
    // A documented gap: the dataset is v4 only, so v6 clients are unflagged
    // rather than wrongly flagged.
    expect(await lookupAsn("2001:4860:4860::8888")).toBeNull();
  });

  it("is fast enough for the request path", async () => {
    const started = performance.now();
    for (let i = 0; i < 2000; i++) {
      await lookupAsn(`${(i % 223) + 1}.${i % 251}.${i % 241}.${i % 199}`);
    }
    const perLookup = (performance.now() - started) / 2000;
    // Binary search over ~500k ranges; anything near a millisecond means the
    // structure is wrong.
    expect(perLookup).toBeLessThan(0.1);
  });
});
