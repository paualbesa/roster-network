import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

/**
 * Outbound HTTP for seller imports and proxied calls. Every request:
 * - https only (http only when a test opts in), no credentials in the URL,
 * - ports 443, 8443 or ≥1024,
 * - DNS answers checked at connect time (no rebinding): private, loopback,
 *   link-local, CGNAT, multicast and reserved ranges are refused,
 * - capped size, total time and redirects (each redirect re-checked).
 */
export interface SafeFetchOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  url: string;
  elapsedMs: number;
}

export type SafeFetcher = (url: string, options?: SafeFetchOptions) => Promise<SafeResponse>;

export class EgressError extends Error {
  constructor(
    readonly code: "invalid_url" | "blocked_destination" | "timeout" | "too_large" | "network" | "too_many_redirects",
    message: string,
  ) {
    super(message);
    this.name = "EgressError";
  }
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const USER_AGENT = "RosterNetwork/1.0 (+https://roster.network; seller-proxy)";
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa", ".corp"];

interface Cidr {
  base: bigint;
  bits: number;
  width: 32 | 128;
}

const BLOCKED_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
].map((cidr) => parseCidr(cidr, 32));

const BLOCKED_V6 = [
  "::/128",
  "::1/128",
  "::ffff:0:0/96",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/32",
  "2001:db8::/32",
  "2002::/16",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
].map((cidr) => parseCidr(cidr, 128));

function parseCidr(cidr: string, width: 32 | 128): Cidr {
  const [address = "", bits = "0"] = cidr.split("/");
  return { base: width === 32 ? v4ToBigInt(address) : v6ToBigInt(address), bits: Number(bits), width };
}

function v4ToBigInt(address: string): bigint {
  return address.split(".").reduce((value, part) => (value << 8n) + BigInt(Number(part) & 255), 0n);
}

function v6ToBigInt(address: string): bigint {
  let text = address.toLowerCase();
  // Trailing dotted quad (::ffff:1.2.3.4).
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1]) {
    const v4 = v4ToBigInt(dotted[1]);
    text = `${text.slice(0, -dotted[1].length)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - headParts.length - tailParts.length;
  const parts = [...headParts, ...Array<string>(Math.max(0, fill)).fill("0"), ...tailParts];
  return parts.reduce((value, part) => (value << 16n) + BigInt(parseInt(part || "0", 16) & 0xffff), 0n);
}

function inCidr(value: bigint, cidr: Cidr): boolean {
  const shift = BigInt(cidr.width - cidr.bits);
  return value >> shift === cidr.base >> shift;
}

/** True for any address a seller endpoint must never resolve to. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = v4ToBigInt(address);
    return BLOCKED_V4.some((cidr) => inCidr(value, cidr)) || address === "255.255.255.255";
  }
  if (family === 6) {
    const value = v6ToBigInt(address);
    // IPv4-mapped / NAT64: judge the embedded IPv4 address as well.
    const mapped = value >> 32n === 0xffffn || value >> 32n === 0x64ff9b0000000000000000n;
    if (mapped) {
      const v4 = Number(value & 0xffffffffn);
      const dotted = [24, 16, 8, 0].map((shift) => ((v4 >>> shift) & 255).toString()).join(".");
      if (isBlockedAddress(dotted)) return true;
    }
    return BLOCKED_V6.some((cidr) => inCidr(value, cidr));
  }
  return true;
}

/** Parse and vet a URL before any network use. Throws EgressError. */
export function assertSafeUrl(raw: string, options: { allowHttp?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new EgressError("invalid_url", "URL is not valid.");
  }
  if (url.protocol !== "https:" && !(options.allowHttp && url.protocol === "http:")) {
    throw new EgressError("invalid_url", "Only https:// URLs are accepted.");
  }
  if (url.username || url.password) throw new EgressError("invalid_url", "URLs with credentials are not accepted.");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!options.allowHttp && port !== 443 && port !== 8443 && port < 1024) {
    throw new EgressError("invalid_url", "Use port 443, 8443, or a port at or above 1024.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) || !host.includes(".") && isIP(host) === 0) {
    throw new EgressError("blocked_destination", "That host is not reachable from Roster.");
  }
  if (isIP(host) !== 0 && isBlockedAddress(host) && !options.allowHttp) {
    throw new EgressError("blocked_destination", "Private, loopback, and reserved addresses are blocked.");
  }
  if (raw.length > 2048) throw new EgressError("invalid_url", "URL is too long.");
  return url;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** dns.lookup replacement used at connect time: refuses blocked answers. */
function guardedLookup(hostname: string, options: { all?: boolean } | number | undefined, callback: LookupCallback): void {
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) {
      callback(error, "");
      return;
    }
    const list = addresses;
    if (list.length === 0 || list.some((entry) => isBlockedAddress(entry.address))) {
      const blocked = new Error(`Blocked destination for ${hostname}.`) as NodeJS.ErrnoException;
      blocked.code = "EBLOCKED";
      callback(blocked, "");
      return;
    }
    const wantsAll = typeof options === "object" && options?.all === true;
    if (wantsAll) callback(null, list);
    else callback(null, list[0]!.address, list[0]!.family);
  });
}

export function createSafeFetcher(options: { allowHttp?: boolean } = {}): SafeFetcher {
  return async (rawUrl, request = {}) => {
    const started = Date.now();
    const timeoutMs = Math.min(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60_000);
    const maxBytes = Math.min(request.maxBytes ?? DEFAULT_MAX_BYTES, 8 * 1024 * 1024);
    let url = assertSafeUrl(rawUrl, options);
    let method = request.method ?? "GET";
    let body = request.body;
    for (let hop = 0; hop <= (request.maxRedirects ?? 2); hop += 1) {
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) throw new EgressError("timeout", "The endpoint did not answer in time.");
      const response = await once(url, { method, headers: request.headers ?? {}, body, timeoutMs: remaining, maxBytes });
      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
        url = assertSafeUrl(new URL(response.headers.location, url).toString(), options);
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      return { ...response, url: url.toString(), elapsedMs: Date.now() - started };
    }
    throw new EgressError("too_many_redirects", "The endpoint redirected too many times.");
  };
}

function once(
  url: URL,
  request: { method: string; headers: Record<string, string>; body: string | undefined; timeoutMs: number; maxBytes: number },
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      "accept-encoding": "gzip, deflate, br",
      ...request.headers,
    };
    if (request.body !== undefined) headers["content-length"] = Buffer.byteLength(request.body).toString();
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers,
        lookup: guardedLookup as never,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > request.maxBytes) {
            req.destroy(new EgressError("too_large", "The endpoint response is too large."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          clearTimeout(timer);
          try {
            const raw = Buffer.concat(chunks);
            const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
            const limit = { maxOutputLength: request.maxBytes };
            const decoded =
              encoding === "gzip" ? gunzipSync(raw, limit) : encoding === "deflate" ? inflateSync(raw, limit) : encoding === "br" ? brotliDecompressSync(raw, limit) : raw;
            const flat: Record<string, string> = {};
            for (const [key, value] of Object.entries(res.headers)) {
              if (value !== undefined) flat[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
            }
            resolve({ status: res.statusCode ?? 0, headers: flat, body: decoded.toString("utf8") });
          } catch {
            reject(new EgressError("too_large", "The endpoint response could not be decoded within the size limit."));
          }
        });
        res.on("error", (error) => reject(asEgress(error)));
      },
    );
    const timer = setTimeout(() => req.destroy(new EgressError("timeout", "The endpoint did not answer in time.")), request.timeoutMs);
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(asEgress(error));
    });
    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
}

function asEgress(error: unknown): EgressError {
  if (error instanceof EgressError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EBLOCKED") return new EgressError("blocked_destination", "Private, loopback, and reserved addresses are blocked.");
  return new EgressError("network", `Could not reach the endpoint${code ? ` (${code})` : ""}.`);
}
