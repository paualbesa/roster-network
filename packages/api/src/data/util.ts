import { inflateRawSync } from "node:zlib";
import type { DataFetchContext, Row } from "./types.js";

export const DATA_USER_AGENT = "RosterNetworkData/1.0 (+https://roster.network; data@roster.network)";
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export function createFetchContext(options: { fetch?: typeof fetch; now?: () => Date } = {}): DataFetchContext {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const request = async (url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> => {
    try {
      return await requestOnce(url, init);
    } catch (error) {
      // One polite retry for timeouts, 429, and 5xx. 4xx is final.
      if (error instanceof Error && /answered 4(?!29)\d\d/.test(error.message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return requestOnce(url, init);
    }
  };
  const requestOnce = async (url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> => {
    const { timeoutMs = 60_000, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set("user-agent", DATA_USER_AGENT);
    if (!headers.has("accept")) headers.set("accept", "application/json, text/csv, text/plain, */*");
    const response = await fetchImpl(url, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    if (!response.ok) {
      throw new Error(`${new URL(url).host} answered ${response.status.toString()}`);
    }
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > MAX_RESPONSE_BYTES) throw new Error(`${new URL(url).host} response is too large.`);
    return response;
  };
  return {
    fetchText: async (url, init) => (await request(url, init)).text(),
    fetchJson: async <T>(url: string, init?: RequestInit & { timeoutMs?: number }) => (await (await request(url, init)).json()) as T,
    fetchBytes: async (url, init) => new Uint8Array(await (await request(url, init)).arrayBuffer()),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: options.now ?? (() => new Date()),
  };
}

/** RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF. Returns objects keyed by the header row. */
export function parseCsv(text: string, delimiter = ","): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quoted) {
      if (char === '"') {
        if (body[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && body[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...data] = rows;
  if (!header) return [];
  const keys = header.map((key) => key.trim());
  return data.map((cells) => {
    const record: Record<string, string> = {};
    keys.forEach((key, column) => {
      record[key] = (cells[column] ?? "").trim();
    });
    return record;
  });
}

export function toCsv(rows: readonly Row[], columns: readonly string[]): string {
  const escape = (value: Row[string] | undefined): string => {
    if (value === null || value === undefined) return "";
    const textValue = String(value);
    return /[",\n\r]/.test(textValue) ? `"${textValue.replace(/"/g, '""')}"` : textValue;
  };
  const lines = [columns.map((column) => escape(column)).join(",")];
  for (const row of rows) lines.push(columns.map((column) => escape(row[column])).join(","));
  return `${lines.join("\n")}\n`;
}

export function numberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "N/A" || trimmed === "NaN" || trimmed === ".") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function textOrNull(value: unknown, max = 2000): string | null {
  if (typeof value !== "string") return typeof value === "number" ? String(value) : null;
  const cleaned = stripControl(value).replace(/\s+/g, " ").trim();
  return cleaned === "" ? null : cleaned.slice(0, max);
}

/** Remove C0 control characters without a control-character regex. */
export function stripControl(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    out += code < 32 && code !== 9 && code !== 10 && code !== 13 ? " " : value[index];
  }
  return out;
}

export function round(value: number | null, digits: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Keep the last row for each key, in first-seen order. */
export function dedupe(rows: readonly Row[], key: (row: Row) => string): Row[] {
  const byKey = new Map<string, Row>();
  for (const row of rows) byKey.set(key(row), row);
  return [...byKey.values()];
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

export function unzipEntry(archive: Uint8Array, name: string): Uint8Array {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let end = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 66_000); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error("ZIP end of central directory not found.");
  const entries = view.getUint16(end + 10, true);
  let pointer = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  for (let index = 0; index < entries; index += 1) {
    if (view.getUint32(pointer, true) !== 0x02014b50) throw new Error("Bad ZIP central directory.");
    const method = view.getUint16(pointer + 10, true);
    const compressed = view.getUint32(pointer + 20, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const localOffset = view.getUint32(pointer + 42, true);
    const entryName = decoder.decode(archive.subarray(pointer + 46, pointer + 46 + nameLength));
    if (entryName === name) {
      const localName = view.getUint16(localOffset + 26, true);
      const localExtra = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localName + localExtra;
      const data = archive.subarray(start, start + compressed);
      if (method === 0) return data;
      if (method === 8) return new Uint8Array(inflateRawSync(data));
      throw new Error(`Unsupported ZIP method ${method.toString()}.`);
    }
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP entry ${name} not found.`);
}

/** Flatten a JSON-stat 2.0 dataset into rows keyed by dimension ids plus `value`. */
export function jsonStatRows(dataset: {
  id: string[];
  size: number[];
  value: Record<string, number> | (number | null)[];
  dimension: Record<string, { category: { index: Record<string, number> | string[]; label?: Record<string, string> } }>;
}): Record<string, string | number>[] {
  const dims = dataset.id.map((id) => {
    const category = dataset.dimension[id]?.category;
    const index = category?.index ?? {};
    const codes = Array.isArray(index)
      ? index
      : Object.entries(index)
          .sort((left, right) => left[1] - right[1])
          .map(([code]) => code);
    return { id, codes, labels: category?.label ?? {} };
  });
  const rows: Record<string, string | number>[] = [];
  const values = dataset.value;
  const entries: [number, number][] = Array.isArray(values)
    ? values.flatMap((value, position) => (typeof value === "number" ? [[position, value] as [number, number]] : []))
    : Object.entries(values).map(([position, value]) => [Number(position), value]);
  for (const [position, value] of entries) {
    let rest = position;
    const row: Record<string, string | number> = {};
    for (let dim = dims.length - 1; dim >= 0; dim -= 1) {
      const size = dataset.size[dim] ?? 1;
      const at = rest % size;
      rest = Math.floor(rest / size);
      const info = dims[dim];
      if (!info) continue;
      const code = info.codes[at] ?? String(at);
      row[info.id] = code;
      const label = info.labels[code];
      if (label && label !== code) row[`${info.id}_label`] = label;
    }
    row.value = value;
    rows.push(row);
  }
  return rows;
}

/** Lowercase, strip accents and punctuation; for case-insensitive lookups. */
export function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function str(input: Record<string, unknown>, key: string, max = 200): string {
  const value = input[key];
  return typeof value === "string" ? value.trim().slice(0, max) : typeof value === "number" ? String(value) : "";
}

export function intIn(input: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = input[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function xmlDecode(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function atomEntries(xml: string): string[] {
  return [...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/g)].map((match) => match[0]);
}

export function xmlTag(fragment: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(fragment);
  if (!match?.[1]) return null;
  return textOrNull(xmlDecode(match[1]));
}

export function xmlTags(fragment: string, tag: string): string[] {
  return [...fragment.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))]
    .map((match) => textOrNull(xmlDecode(match[1] ?? "")))
    .filter((value): value is string => value !== null);
}

/** Value of `attr` on the first `<tag ...>` matching an optional attribute filter. */
export function xmlAttr(fragment: string, tag: string, attr: string, where?: [string, string]): string | null {
  for (const match of fragment.matchAll(new RegExp(`<${tag}\\s([^>]*)/?>`, "g"))) {
    const attrs = match[1] ?? "";
    if (where && !new RegExp(`${where[0]}="${where[1]}"`).test(attrs)) continue;
    const value = new RegExp(`${attr}="([^"]*)"`).exec(attrs);
    if (value?.[1] !== undefined) return xmlDecode(value[1]);
  }
  return null;
}
