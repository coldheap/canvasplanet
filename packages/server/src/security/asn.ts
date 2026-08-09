/**
 * Anti-bot layer 2 — datacenter and VPN ASN gating.
 *
 * A flagged ASN is NOT blocked. It gets: Turnstile forced even on the first
 * paint, and half the IP budget (60/hr instead of 120/hr). That kills cheap
 * cloud fan-out — the shape most scripted attacks actually take — without
 * hard-blocking the many legitimate users behind a commercial VPN.
 *
 * Residential proxies still get through. That is a known, accepted gap for
 * v1 and the reason the revert tooling exists (PLAN.md §8).
 *
 * The database is `data/asn-ipv4-num.csv` from @ip-location-db (CC0), loaded
 * once at boot into typed arrays and binary-searched. It must never make a
 * network call on the request path: session creation happens on every cold
 * visit, and an outbound lookup there would be both a latency floor and a
 * dependency that can take the whole site down.
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { DATA_DIR } from "../geo/source.js";

export const ASN_FILE = "asn-ipv4-num.csv";

export interface AsnInfo {
  number: number;
  name: string;
  flagged: boolean;
}

/**
 * Hosting, cloud and VPN ASNs.
 *
 * Deliberately conservative and explicit rather than keyword-matched on the
 * AS name: "Hosting" appears in the name of plenty of consumer ISPs, and a
 * false positive here means a real user gets a permanent Turnstile and half
 * the pixel budget for no reason.
 */
const FLAGGED_ASNS = new Map<number, string>([
  [16509, "Amazon AWS"],
  [14618, "Amazon AWS"],
  [8987, "Amazon AWS"],
  [15169, "Google Cloud"],
  [396982, "Google Cloud"],
  [19527, "Google Cloud"],
  [8075, "Microsoft Azure"],
  [8068, "Microsoft Azure"],
  [14061, "DigitalOcean"],
  [63949, "Akamai / Linode"],
  [20473, "Vultr / Choopa"],
  [16276, "OVH"],
  [24940, "Hetzner"],
  [51167, "Contabo"],
  [9009, "M247"],
  [60068, "Datacamp / CDN77"],
  [212238, "Datacamp"],
  [136907, "Huawei Cloud"],
  [45102, "Alibaba Cloud"],
  [37963, "Alibaba Cloud"],
  [132203, "Tencent Cloud"],
  [45090, "Tencent Cloud"],
  [35916, "Multacom"],
  [40676, "Psychz"],
  [26347, "DreamHost"],
  [30633, "Leaseweb"],
  [60781, "Leaseweb"],
  [396356, "Latitude.sh"],
  [23470, "ReliableSite"],
  [62904, "Eonix"],
  [53667, "FranTech / BuyVM"],
  [206092, "IPXO"],
  [209242, "Cloudflare WARP"],
  [13335, "Cloudflare"],
]);

// Sorted, parallel arrays. ~500k ranges: 4 MB + 4 MB + 2 MB resident.
let starts: Uint32Array = new Uint32Array(0);
let ends: Uint32Array = new Uint32Array(0);
let asns: Int32Array = new Int32Array(0);
let loaded = false;
let rangeCount = 0;

export function isLoaded(): boolean {
  return loaded;
}

export function asnFilePresent(): boolean {
  return existsSync(join(DATA_DIR, ASN_FILE));
}

/**
 * Parse the CSV into typed arrays.
 *
 * Streamed line by line rather than read whole: the file is ~20 MB of text
 * and holding it plus the parsed structure at once is wasteful for something
 * that runs at boot on a small VPS.
 */
export async function loadAsnDatabase(): Promise<void> {
  const path = join(DATA_DIR, ASN_FILE);
  if (!existsSync(path)) {
    console.warn(`[asn] ${ASN_FILE} missing — ASN gating disabled (run \`pnpm geo:fetch\`)`);
    return;
  }

  // Grow geometrically; the exact row count is not known up front.
  let cap = 1 << 19;
  let s = new Uint32Array(cap);
  let e = new Uint32Array(cap);
  let a = new Int32Array(cap);
  let n = 0;

  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    // start,end,asn,name — the name may itself contain commas, so only the
    // first three fields are parsed and the rest of the line is ignored.
    const c1 = line.indexOf(",");
    if (c1 < 0) continue;
    const c2 = line.indexOf(",", c1 + 1);
    if (c2 < 0) continue;
    const c3 = line.indexOf(",", c2 + 1);

    const start = Number(line.slice(0, c1));
    const end = Number(line.slice(c1 + 1, c2));
    const asn = Number(line.slice(c2 + 1, c3 < 0 ? undefined : c3));
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(asn)) continue;

    if (n === cap) {
      cap *= 2;
      const s2 = new Uint32Array(cap);
      s2.set(s);
      s = s2;
      const e2 = new Uint32Array(cap);
      e2.set(e);
      e = e2;
      const a2 = new Int32Array(cap);
      a2.set(a);
      a = a2;
    }
    s[n] = start >>> 0;
    e[n] = end >>> 0;
    a[n] = asn;
    n++;
  }

  starts = s.subarray(0, n);
  ends = e.subarray(0, n);
  asns = a.subarray(0, n);
  rangeCount = n;
  loaded = true;

  const flagged = [...FLAGGED_ASNS.keys()].filter((k) => k > 0).length;
  console.log(`[asn] loaded ${n.toLocaleString()} ranges, ${flagged} flagged networks`);
}

/** Dotted-quad to uint32. Returns null for anything that is not IPv4. */
export function ipv4ToInt(ip: string): number | null {
  // Strip an IPv4-mapped IPv6 prefix (::ffff:1.2.3.4), which is what a
  // dual-stack listener reports for an IPv4 client.
  const bare = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const parts = bare.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    out = out * 256 + v;
  }
  return out >>> 0;
}

/**
 * Which ASN owns this address.
 *
 * IPv6 is not covered — the dataset here is v4 only, so a v6 client is
 * simply unflagged rather than wrongly flagged. That is a real gap: an
 * attacker on native IPv6 skips this layer entirely, which is why it is
 * layer 2 of four and not the whole defence.
 */
export async function lookupAsn(ip: string): Promise<AsnInfo | null> {
  if (!loaded) return null;
  const value = ipv4ToInt(ip);
  if (value === null) return null;

  // Binary search for the last range whose start is <= value.
  let lo = 0;
  let hi = rangeCount - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid]! <= value) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0 || ends[found]! < value) return null;

  const number = asns[found]!;
  const flaggedName = FLAGGED_ASNS.get(number);
  return {
    number,
    name: flaggedName ?? `AS${number}`,
    flagged: flaggedName !== undefined,
  };
}

export function isFlagged(asn: number): boolean {
  return FLAGGED_ASNS.has(asn);
}

export function flaggedName(asn: number): string | undefined {
  return FLAGGED_ASNS.get(asn);
}

export function stats() {
  return { loaded, ranges: rangeCount, flaggedNetworks: FLAGGED_ASNS.size };
}
