import type { FastifyRequest } from "fastify";
import { env } from "../env.js";

/**
 * Country inferred from the client IP by Cloudflare.
 *
 * The header is accepted under the same trust boundary as CF-Connecting-IP:
 * only when the deployment says a proxy that overwrites Cloudflare headers
 * is in front. Otherwise a direct client could award placements to any
 * country by forging one request header.
 */
export function clientCountryIso(req: FastifyRequest): string | null {
  if (!env.trustCfConnectingIp) return null;
  return normalizeCountryHeader(req.headers["cf-ipcountry"]);
}

export function normalizeCountryHeader(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  const iso = value.trim().toUpperCase();
  // Cloudflare uses XX when the country is unknown and T1 for Tor traffic.
  return /^[A-Z]{2}$/.test(iso) && iso !== "XX" && iso !== "T1" ? iso : null;
}
