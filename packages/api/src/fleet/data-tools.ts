import { bool, clip, int, isRecord, num, numbers, oneOf, records, round, s, strings, text, type FleetTool, type Json } from "./kit.js";

const SAMPLE_CSV = "Name , Email,Country\nAnna Puig, ANNA@EXAMPLE.COM ,ES\nAnna Puig,anna@example.com,ES\n  Joan Mas ,joan@example.com, es \n,,\n";

export function parseCsv(source: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (rows.length >= 5000) return rows;
    } else field += char;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function toCsv(rows: readonly (readonly string[])[], delimiter = ","): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const guarded = /^[=+@\t\r]|^-(?!\d)/.test(cell) ? `'${cell}` : cell;
          return /[",\n\r]/.test(guarded) || guarded.includes(delimiter) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
        })
        .join(delimiter),
    )
    .join("\n");
}

function delimiterOf(input: Json): string {
  const value = text(input, "delimiter", ",");
  return value === "\t" || value === ";" || value === "|" ? value : ",";
}

function headerKey(value: string, index: number): string {
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return key || `column_${(index + 1).toString()}`;
}

function inferType(values: readonly string[]): "integer" | "number" | "boolean" | "date" | "email" | "string" | "empty" {
  const present = values.filter((value) => value.trim() !== "");
  if (present.length === 0) return "empty";
  if (present.every((value) => /^-?\d+$/.test(value.trim()))) return "integer";
  if (present.every((value) => /^-?\d+(?:[.,]\d+)?$/.test(value.trim()))) return "number";
  if (present.every((value) => /^(true|false|yes|no)$/i.test(value.trim()))) return "boolean";
  if (present.every((value) => !Number.isNaN(Date.parse(value.trim())) && /\d{4}/.test(value))) return "date";
  if (present.every((value) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(value.trim()))) return "email";
  return "string";
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return (sorted[low] ?? 0) + ((sorted[high] ?? 0) - (sorted[low] ?? 0)) * (rank - low);
}

function describe(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const count = sorted.length;
  const mean = count === 0 ? 0 : sorted.reduce((sum, value) => sum + value, 0) / count;
  const variance = count < 2 ? 0 : sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1);
  return {
    count,
    min: round(sorted[0] ?? 0, 6),
    max: round(sorted[count - 1] ?? 0, 6),
    mean: round(mean, 6),
    median: round(percentile(sorted, 50), 6),
    stdDev: round(Math.sqrt(variance), 6),
    p25: round(percentile(sorted, 25), 6),
    p75: round(percentile(sorted, 75), 6),
    p95: round(percentile(sorted, 95), 6),
    sum: round(sorted.reduce((sum, value) => sum + value, 0), 6),
  };
}

const statsShape = {
  count: s.int(0),
  min: s.num(),
  max: s.num(),
  mean: s.num(),
  median: s.num(),
  stdDev: s.num(0),
  p25: s.num(),
  p75: s.num(),
  p95: s.num(),
  sum: s.num(),
};

const scalar = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

export const dataTools: FleetTool[] = [
  {
    name: "CSV cleaner",
    slug: "csv_clean",
    category: "data",
    description:
      "Clean messy CSV files: trim whitespace, normalize header names to snake_case, lowercase emails, drop empty rows and " +
      "remove duplicate rows. Data cleaning and spreadsheet hygiene before import into a CRM, database or BI tool.",
    tags: ["csv", "data-cleaning", "spreadsheet", "dedupe", "etl"],
    priceUsdc: "0.02",
    p95Ms: 500,
    p50Ms: 120,
    input: { csv: s.str(200_000, 1), delimiter: s.str(1), dedupe: s.bool() },
    required: ["csv"],
    example: { csv: SAMPLE_CSV, dedupe: true },
    output: s.obj({
      csv: s.str(200_000),
      rowsIn: s.int(0),
      rowsOut: s.int(0),
      duplicatesRemoved: s.int(0),
      emptyRemoved: s.int(0),
      headers: s.arr(s.str(64), 40),
    }),
    run(input) {
      const delimiter = delimiterOf(input);
      const rows = parseCsv(String(input.csv ?? "").slice(0, 200_000), delimiter);
      const [header = [], ...body] = rows;
      const headers = header.slice(0, 40).map((cell, index) => headerKey(cell, index));
      const dedupe = bool(input, "dedupe", true);
      let emptyRemoved = 0;
      let duplicatesRemoved = 0;
      const seen = new Set<string>();
      const cleaned: string[][] = [];
      for (const row of body) {
        const cells = headers.map((name, index) => {
          const value = (row[index] ?? "").trim().replace(/\s+/g, " ");
          return name.includes("email") || /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(value) ? value.toLowerCase() : value;
        });
        if (cells.every((cell) => cell === "")) {
          emptyRemoved += 1;
          continue;
        }
        const key = cells.join("\u0001").toLowerCase();
        if (dedupe && seen.has(key)) {
          duplicatesRemoved += 1;
          continue;
        }
        seen.add(key);
        cleaned.push(cells);
      }
      return {
        csv: clip(toCsv([headers, ...cleaned], delimiter), 200_000),
        rowsIn: body.length,
        rowsOut: cleaned.length,
        duplicatesRemoved,
        emptyRemoved,
        headers: headers.map((name) => clip(name, 64)),
      };
    },
  },
  {
    name: "CSV to JSON converter",
    slug: "csv_to_json",
    category: "data",
    description:
      "Convert CSV or TSV text into JSON records keyed by the header row, with numbers and booleans typed. For API payloads, " +
      "NoSQL imports, spreadsheet-to-app workflows and data pipelines.",
    tags: ["csv", "json", "convert", "etl", "data"],
    priceUsdc: "0.01",
    p95Ms: 400,
    p50Ms: 80,
    input: { csv: s.str(200_000, 1), delimiter: s.str(1), typed: s.bool() },
    required: ["csv"],
    example: { csv: "sku,qty,price,active\nA-1,3,9.99,true\nB-2,10,4.50,false", typed: true },
    output: s.obj({ json: s.str(400_000), rows: s.int(0), columns: s.arr(s.str(64), 40) }),
    run(input) {
      const rows = parseCsv(String(input.csv ?? "").slice(0, 200_000), delimiterOf(input));
      const [header = [], ...body] = rows;
      const headers = header.slice(0, 40).map((cell, index) => headerKey(cell, index));
      const typed = bool(input, "typed", true);
      const records = body
        .filter((row) => row.some((cell) => cell.trim() !== ""))
        .map((row) => {
          const record: Record<string, unknown> = {};
          headers.forEach((name, index) => {
            const raw = (row[index] ?? "").trim();
            if (!typed) record[name] = raw;
            else if (/^-?\d+(?:\.\d+)?$/.test(raw)) record[name] = Number(raw);
            else if (/^(true|false)$/i.test(raw)) record[name] = raw.toLowerCase() === "true";
            else if (raw === "") record[name] = null;
            else record[name] = raw;
          });
          return record;
        });
      return { json: clip(JSON.stringify(records), 400_000), rows: records.length, columns: headers.map((name) => clip(name, 64)) };
    },
  },
  {
    name: "JSON to CSV converter",
    slug: "json_to_csv",
    category: "data",
    description:
      "Flatten an array of JSON objects into a CSV table with a unified header (nested objects become dot.notation " +
      "columns). Export API results to Excel, Google Sheets or a data warehouse. Formula injection is neutralized.",
    tags: ["json", "csv", "convert", "export", "spreadsheet"],
    priceUsdc: "0.01",
    p95Ms: 400,
    p50Ms: 80,
    input: { records: s.arr({ type: "object" }, 5000, 1), delimiter: s.str(1) },
    required: ["records"],
    example: { records: [{ id: 1, user: { name: "Anna", country: "ES" } }, { id: 2, user: { name: "Joan" }, tags: ["vip"] }] },
    output: s.obj({ csv: s.str(400_000), rows: s.int(0), columns: s.arr(s.str(128), 200) }),
    run(input) {
      const list = records(input, "records", 5000).map((record) => flatten(record));
      const columns: string[] = [];
      for (const record of list) for (const key of Object.keys(record)) if (!columns.includes(key) && columns.length < 200) columns.push(key);
      const rows = list.map((record) => columns.map((column) => scalar(record[column])));
      return {
        csv: clip(toCsv([columns, ...rows], delimiterOf(input)), 400_000),
        rows: rows.length,
        columns: columns.map((column) => clip(column, 128)),
      };
    },
  },
  {
    name: "CSV column profiler",
    slug: "csv_profile",
    category: "data",
    description:
      "Profile a CSV dataset: per-column inferred type (integer, number, date, email, boolean, string), null count, unique " +
      "values, sample values and numeric min/max/mean. Data quality checks and exploratory data analysis (EDA).",
    tags: ["csv", "data-quality", "profiling", "eda", "analytics"],
    priceUsdc: "0.02",
    p95Ms: 500,
    p50Ms: 120,
    input: { csv: s.str(200_000, 1), delimiter: s.str(1) },
    required: ["csv"],
    example: { csv: "id,signup,email,plan,mrr\n1,2026-01-03,a@x.io,pro,49\n2,2026-02-11,b@y.io,free,0\n3,,c@z.io,pro,49" },
    output: s.obj({
      rows: s.int(0),
      columns: s.arr(
        s.obj({
          name: s.str(64),
          type: s.enm(["integer", "number", "boolean", "date", "email", "string", "empty"]),
          nulls: s.int(0),
          unique: s.int(0),
          samples: s.arr(s.str(100), 3),
          min: s.num(),
          max: s.num(),
          mean: s.num(),
        }),
        40,
      ),
    }),
    run(input) {
      const rows = parseCsv(String(input.csv ?? "").slice(0, 200_000), delimiterOf(input));
      const [header = [], ...body] = rows;
      const columns = header.slice(0, 40).map((cell, index) => {
        const values = body.map((row) => (row[index] ?? "").trim());
        const type = inferType(values);
        const numeric = type === "integer" || type === "number" ? values.filter(Boolean).map((value) => Number(value.replace(",", "."))) : [];
        const stats = describe(numeric);
        return {
          name: clip(headerKey(cell, index), 64),
          type,
          nulls: values.filter((value) => value === "").length,
          unique: new Set(values.filter(Boolean)).size,
          samples: [...new Set(values.filter(Boolean))].slice(0, 3).map((value) => clip(value, 100)),
          min: stats.min,
          max: stats.max,
          mean: round(stats.mean, 4),
        };
      });
      return { rows: body.length, columns };
    },
  },
  {
    name: "JSON schema inferrer",
    slug: "json_schema_infer",
    category: "data",
    description:
      "Infer a JSON Schema from one or more example JSON documents: types, required fields, nested objects and arrays. " +
      "Bootstraps API contracts, validation rules, Roster escrow result schemas and typed SDKs.",
    tags: ["json-schema", "json", "api", "validation", "codegen"],
    priceUsdc: "0.015",
    p95Ms: 300,
    p50Ms: 60,
    input: { samples: s.arr({ type: "object" }, 50, 1) },
    required: ["samples"],
    example: { samples: [{ total: "12.50", currency: "EUR", items: [{ sku: "A", qty: 2 }] }, { total: "3.00", currency: "USD", items: [] }] },
    output: s.obj({ schema: s.str(50_000), fieldCount: s.int(0) }),
    run(input) {
      const samples = records(input, "samples", 50);
      const schema = samples.length === 0 ? { type: "object", properties: {} } : mergeSchemas(samples.map((sample) => inferSchema(sample, 0)));
      const serialized = JSON.stringify(schema, null, 2);
      return { schema: clip(serialized, 50_000), fieldCount: (serialized.match(/"type"/g) ?? []).length - 1 };
    },
  },
  {
    name: "JSON diff",
    slug: "json_diff",
    category: "data",
    description:
      "Compare two JSON documents and list added, removed and changed paths with old and new values. Config drift " +
      "detection, API response regression checks, audit trails and data reconciliation.",
    tags: ["json", "diff", "compare", "audit", "data"],
    priceUsdc: "0.01",
    p95Ms: 300,
    p50Ms: 60,
    input: { before: { type: "object" }, after: { type: "object" } },
    required: ["before", "after"],
    example: { before: { plan: "free", seats: 1, flags: { beta: false } }, after: { plan: "pro", seats: 1, flags: { beta: true, sso: true } } },
    output: s.obj({
      changes: s.arr(s.obj({ path: s.str(300), op: s.enm(["added", "removed", "changed"]), before: s.str(500), after: s.str(500) }), 200),
      total: s.int(0),
    }),
    run(input) {
      const changes: { path: string; op: "added" | "removed" | "changed"; before: string; after: string }[] = [];
      diffValues(input.before ?? {}, input.after ?? {}, "$", changes, 0);
      return { changes: changes.slice(0, 200), total: changes.length };
    },
  },
  {
    name: "Record deduplicator",
    slug: "record_dedupe",
    category: "data",
    description:
      "Deduplicate a list of records (contacts, leads, products) by one or more key fields with case and whitespace " +
      "normalization, keeping the first or most complete record. CRM hygiene and master data management.",
    tags: ["dedupe", "data-cleaning", "crm", "records", "mdm"],
    priceUsdc: "0.015",
    p95Ms: 400,
    p50Ms: 80,
    input: { records: s.arr({ type: "object" }, 5000, 1), keys: s.arr(s.str(64), 5, 1), keep: s.enm(["first", "most_complete"]) },
    required: ["records", "keys"],
    example: {
      records: [{ email: "Anna@x.io", name: "Anna" }, { email: "anna@x.io ", name: "Anna Puig", phone: "+34600000000" }, { email: "joan@x.io" }],
      keys: ["email"],
      keep: "most_complete",
    },
    output: s.obj({ records: s.str(400_000), kept: s.int(0), removed: s.int(0), groups: s.int(0) }),
    run(input) {
      const list = records(input, "records", 5000);
      const keys = strings(input, "keys", 5, 64);
      const keep = oneOf(input, "keep", ["first", "most_complete"] as const, "first");
      const groups = new Map<string, Json[]>();
      for (const record of list) {
        const key = keys.length === 0 ? JSON.stringify(record) : keys.map((name) => scalar(record[name]).trim().toLowerCase()).join("\u0001");
        const group = groups.get(key) ?? [];
        group.push(record);
        groups.set(key, group);
      }
      const completeness = (record: Json) => Object.values(record).filter((value) => value !== null && value !== "" && value !== undefined).length;
      const kept = [...groups.values()].map((group) =>
        keep === "first" ? group[0] : [...group].sort((left, right) => completeness(right) - completeness(left))[0],
      );
      return { records: clip(JSON.stringify(kept), 400_000), kept: kept.length, removed: list.length - kept.length, groups: groups.size };
    },
  },
  {
    name: "Descriptive statistics calculator",
    slug: "stats_describe",
    category: "data",
    description:
      "Compute descriptive statistics for a list of numbers: count, sum, mean, median, standard deviation, min, max and " +
      "percentiles (p25, p75, p95), plus outliers by the IQR rule. Analytics, KPI reporting, latency and pricing analysis.",
    tags: ["statistics", "analytics", "math", "percentiles", "data"],
    priceUsdc: "0.008",
    p95Ms: 200,
    p50Ms: 40,
    input: { values: s.arr({ type: "number" }, 10_000, 1) },
    required: ["values"],
    example: { values: [120, 98, 143, 101, 99, 870, 110, 105] },
    output: s.obj({ ...statsShape, outliers: s.arr(s.num(), 100) }),
    run(input) {
      const values = numbers(input, "values");
      const stats = describe(values);
      const iqr = stats.p75 - stats.p25;
      const low = stats.p25 - 1.5 * iqr;
      const high = stats.p75 + 1.5 * iqr;
      return { ...stats, outliers: values.filter((value) => value < low || value > high).slice(0, 100) };
    },
  },
  {
    name: "Unit converter pro",
    slug: "units_convert",
    category: "utility",
    description:
      "Convert measurements between units of length, mass, temperature, volume, area, speed and digital storage (km to " +
      "miles, kg to lb, °C to °F, liters to gallons, GB to MiB). Engineering, logistics, recipes and e-commerce specs.",
    tags: ["units", "convert", "measurement", "math", "utility"],
    priceUsdc: "0.005",
    p95Ms: 150,
    p50Ms: 30,
    input: { value: s.num(), from: s.str(16, 1), to: s.str(16, 1) },
    required: ["value", "from", "to"],
    example: { value: 42.195, from: "km", to: "mi" },
    output: s.obj({ value: s.num(), from: s.str(16), to: s.str(16), category: s.str(16), supported: s.bool() }),
    run(input) {
      const value = num(input, "value", 0);
      const from = text(input, "from").trim().toLowerCase().slice(0, 16);
      const to = text(input, "to").trim().toLowerCase().slice(0, 16);
      return convertUnits(value, from, to);
    },
  },
  {
    name: "Timezone converter",
    slug: "timezone_convert",
    category: "utility",
    description:
      "Convert a date and time between IANA time zones (Europe/Madrid, America/New_York, Asia/Tokyo…) with daylight saving " +
      "handled. Meeting scheduling, global support rotas, deadline communication and log correlation.",
    tags: ["timezone", "datetime", "scheduling", "convert", "utility"],
    priceUsdc: "0.005",
    p95Ms: 150,
    p50Ms: 30,
    input: { datetime: s.str(40, 1), fromZone: s.str(64, 1), toZone: s.str(64, 1) },
    required: ["datetime", "fromZone", "toZone"],
    example: { datetime: "2026-10-05T18:30", fromZone: "Europe/Madrid", toZone: "America/New_York" },
    output: s.obj({ converted: s.str(40), utc: s.str(40), offsetMinutes: s.int(-1440, 1440), valid: s.bool() }),
    run(input) {
      const raw = text(input, "datetime").trim();
      const fromZone = text(input, "fromZone").trim();
      const toZone = text(input, "toZone").trim();
      const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
      if (!match || !validZone(fromZone) || !validZone(toZone)) return { converted: "", utc: "", offsetMinutes: 0, valid: false };
      const naive = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] ?? 0));
      const fromOffset = zoneOffset(naive, fromZone);
      const utcMs = naive - fromOffset * 60_000;
      const toOffset = zoneOffset(utcMs, toZone);
      const local = new Date(utcMs + toOffset * 60_000).toISOString().slice(0, 19);
      return { converted: local, utc: new Date(utcMs).toISOString(), offsetMinutes: toOffset - fromOffset, valid: true };
    },
  },
  {
    name: "Business day calculator",
    slug: "business_days",
    category: "utility",
    description:
      "Count calendar days and business days (weekdays minus listed holidays) between two dates, or add N business days to " +
      "a date. SLA deadlines, payment terms (net 30), shipping estimates and HR leave calculations.",
    tags: ["dates", "business-days", "sla", "calendar", "utility"],
    priceUsdc: "0.005",
    p95Ms: 150,
    p50Ms: 30,
    input: { start: s.str(10, 10), end: s.str(10), addBusinessDays: s.int(0, 3650), holidays: s.arr(s.str(10), 100) },
    required: ["start"],
    example: { start: "2026-10-05", end: "2026-10-30", holidays: ["2026-10-12"] },
    output: s.obj({ calendarDays: s.int(), businessDays: s.int(), resultDate: s.str(10), valid: s.bool() }),
    run(input) {
      const start = parseDay(text(input, "start"));
      if (start === null) return { calendarDays: 0, businessDays: 0, resultDate: "", valid: false };
      const holidays = new Set(strings(input, "holidays", 100, 10));
      const isBusiness = (ms: number) => {
        const day = new Date(ms).getUTCDay();
        return day !== 0 && day !== 6 && !holidays.has(new Date(ms).toISOString().slice(0, 10));
      };
      const add = int(input, "addBusinessDays", 0, 0, 3650);
      if (add > 0) {
        let cursor = start;
        let remaining = add;
        while (remaining > 0) {
          cursor += 86_400_000;
          if (isBusiness(cursor)) remaining -= 1;
        }
        return { calendarDays: Math.round((cursor - start) / 86_400_000), businessDays: add, resultDate: new Date(cursor).toISOString().slice(0, 10), valid: true };
      }
      const end = parseDay(text(input, "end"));
      if (end === null) return { calendarDays: 0, businessDays: 0, resultDate: "", valid: false };
      const [low, high] = start <= end ? [start, end] : [end, start];
      let business = 0;
      for (let cursor = low; cursor < high && business < 100_000; cursor += 86_400_000) if (isBusiness(cursor)) business += 1;
      const sign = start <= end ? 1 : -1;
      return {
        calendarDays: sign * Math.round((high - low) / 86_400_000),
        businessDays: sign * business,
        resultDate: new Date(end).toISOString().slice(0, 10),
        valid: true,
      };
    },
  },
  {
    name: "Cron expression explainer",
    slug: "cron_explain",
    category: "code",
    description:
      "Explain a 5-field cron expression in plain English and list the next run times (UTC). Debug crontab, Kubernetes " +
      "CronJob, GitHub Actions schedules and serverless timers.",
    tags: ["cron", "scheduling", "devops", "explain", "code"],
    priceUsdc: "0.005",
    p95Ms: 200,
    p50Ms: 40,
    input: { expression: s.str(100, 1), from: s.str(30), count: s.int(1, 10) },
    required: ["expression"],
    example: { expression: "*/15 9-17 * * 1-5", from: "2026-10-05T08:00:00Z", count: 3 },
    output: s.obj({ description: s.str(500), nextRuns: s.arr(s.str(30), 10), valid: s.bool() }),
    run(input) {
      return explainCron(text(input, "expression").trim(), text(input, "from"), int(input, "count", 5, 1, 10));
    },
  },
];

function flatten(value: Json, prefix = "", output: Record<string, unknown> = {}, depth = 0): Record<string, unknown> {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord(child) && depth < 5) flatten(child, path, output, depth + 1);
    else output[path] = Array.isArray(child) ? JSON.stringify(child) : child;
  }
  return output;
}

type InferredSchema = Record<string, unknown>;

function inferSchema(value: unknown, depth: number): InferredSchema {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((item) => inferSchema(item, depth + 1));
    return { type: "array", items: items.length > 0 ? mergeSchemas(items) : {} };
  }
  if (isRecord(value) && depth < 8) {
    const properties: Record<string, InferredSchema> = {};
    for (const [key, child] of Object.entries(value).slice(0, 100)) properties[key] = inferSchema(child, depth + 1);
    return { type: "object", properties, required: Object.keys(properties) };
  }
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  return { type: "string" };
}

function mergeSchemas(schemas: InferredSchema[]): InferredSchema {
  const first = schemas[0] ?? {};
  if (schemas.every((schema) => schema.type === "object")) {
    const properties: Record<string, InferredSchema[]> = {};
    for (const schema of schemas) {
      const props = (schema.properties ?? {}) as Record<string, InferredSchema>;
      for (const [key, child] of Object.entries(props)) (properties[key] ??= []).push(child);
    }
    const required = Object.keys(properties).filter((key) => (properties[key] ?? []).length === schemas.length);
    const merged: Record<string, InferredSchema> = {};
    for (const [key, list] of Object.entries(properties)) merged[key] = mergeSchemas(list);
    return { type: "object", properties: merged, required };
  }
  const types = [...new Set(schemas.map((schema) => String(schema.type)))];
  if (types.length === 1) {
    if (first.type === "array") {
      const items = schemas.map((schema) => schema.items as InferredSchema).filter((item) => item && Object.keys(item).length > 0);
      return { type: "array", items: items.length > 0 ? mergeSchemas(items) : {} };
    }
    return first;
  }
  if (types.every((type) => type === "integer" || type === "number")) return { type: "number" };
  return { type: types };
}

function diffValues(
  before: unknown,
  after: unknown,
  path: string,
  changes: { path: string; op: "added" | "removed" | "changed"; before: string; after: string }[],
  depth: number,
): void {
  if (changes.length >= 500) return;
  if (isRecord(before) && isRecord(after) && depth < 10) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const childPath = `${path}.${key}`;
      if (!(key in before)) changes.push({ path: clip(childPath, 300), op: "added", before: "", after: clip(scalar(after[key]), 500) });
      else if (!(key in after)) changes.push({ path: clip(childPath, 300), op: "removed", before: clip(scalar(before[key]), 500), after: "" });
      else diffValues(before[key], after[key], childPath, changes, depth + 1);
    }
    return;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    changes.push({ path: clip(path, 300), op: "changed", before: clip(scalar(before), 500), after: clip(scalar(after), 500) });
  }
}

const UNITS: Record<string, { category: string; factor: number }> = {
  mm: { category: "length", factor: 0.001 }, cm: { category: "length", factor: 0.01 }, m: { category: "length", factor: 1 },
  km: { category: "length", factor: 1000 }, in: { category: "length", factor: 0.0254 }, ft: { category: "length", factor: 0.3048 },
  yd: { category: "length", factor: 0.9144 }, mi: { category: "length", factor: 1609.344 }, nmi: { category: "length", factor: 1852 },
  mg: { category: "mass", factor: 0.000001 }, g: { category: "mass", factor: 0.001 }, kg: { category: "mass", factor: 1 },
  t: { category: "mass", factor: 1000 }, oz: { category: "mass", factor: 0.028349523125 }, lb: { category: "mass", factor: 0.45359237 },
  ml: { category: "volume", factor: 0.001 }, l: { category: "volume", factor: 1 }, gal: { category: "volume", factor: 3.785411784 },
  qt: { category: "volume", factor: 0.946352946 }, cup: { category: "volume", factor: 0.2365882365 }, floz: { category: "volume", factor: 0.0295735295625 },
  m2: { category: "area", factor: 1 }, km2: { category: "area", factor: 1_000_000 }, ha: { category: "area", factor: 10_000 },
  acre: { category: "area", factor: 4046.8564224 }, ft2: { category: "area", factor: 0.09290304 },
  "m/s": { category: "speed", factor: 1 }, "km/h": { category: "speed", factor: 1 / 3.6 }, mph: { category: "speed", factor: 0.44704 }, kn: { category: "speed", factor: 0.514444 },
  b: { category: "data", factor: 1 }, kb: { category: "data", factor: 1000 }, mb: { category: "data", factor: 1e6 }, gb: { category: "data", factor: 1e9 },
  tb: { category: "data", factor: 1e12 }, kib: { category: "data", factor: 1024 }, mib: { category: "data", factor: 1024 ** 2 }, gib: { category: "data", factor: 1024 ** 3 },
};

function convertUnits(value: number, from: string, to: string) {
  const temps = ["c", "f", "k"];
  if (temps.includes(from) && temps.includes(to)) {
    const celsius = from === "c" ? value : from === "f" ? ((value - 32) * 5) / 9 : value - 273.15;
    const result = to === "c" ? celsius : to === "f" ? (celsius * 9) / 5 + 32 : celsius + 273.15;
    return { value: round(result, 6), from, to, category: "temperature", supported: true };
  }
  const source = UNITS[from];
  const target = UNITS[to];
  if (!source || !target || source.category !== target.category) return { value: 0, from, to, category: "", supported: false };
  return { value: round((value * source.factor) / target.factor, 6), from, to, category: source.category, supported: true };
}

function validZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function zoneOffset(utcMs: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - utcMs) / 60_000);
}

function parseDay(raw: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(ms) ? null : ms;
}

function expandCronField(field: string, min: number, max: number): number[] | null {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!match) return null;
    const step = match[3] ? Number(match[3]) : 1;
    const start = match[1] === "*" ? min : Number(match[1]);
    const end = match[2] ? Number(match[2]) : match[1] === "*" || match[3] ? max : start;
    if (step < 1 || start < min || end > max || start > end) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return [...values].sort((left, right) => left - right);
}

function explainCron(expression: string, from: string, count: number) {
  const fields = expression.split(/\s+/);
  const invalid = { description: "Not a valid 5-field cron expression.", nextRuns: [], valid: false };
  if (fields.length !== 5) return invalid;
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const sets = [
    expandCronField(minute, 0, 59),
    expandCronField(hour, 0, 23),
    expandCronField(dom, 1, 31),
    expandCronField(month, 1, 12),
    expandCronField(dow.replace(/\b7\b/g, "0"), 0, 6),
  ];
  if (sets.some((set) => set === null)) return invalid;
  const [minutes, hours, days, months, weekdays] = sets as [number[], number[], number[], number[], number[]];
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const describeField = (raw: string, unit: string, names?: string[]) => {
    if (raw === "*") return `every ${unit}`;
    const step = /^\*\/(\d+)$/.exec(raw);
    if (step) return `every ${step[1] ?? ""} ${unit}s`;
    const range = /^(\d+)-(\d+)$/.exec(raw);
    if (range) return `${unit}s ${names ? names[Number(range[1])] ?? range[1] : range[1]} through ${names ? names[Number(range[2])] ?? range[2] : range[2]}`;
    return `${unit} ${raw.split(",").map((value) => (names ? names[Number(value)] ?? value : value)).join(", ")}`;
  };
  const description = [
    `At ${describeField(minute, "minute")}`,
    `during ${describeField(hour, "hour")}`,
    dom === "*" ? "" : `on ${describeField(dom, "day-of-month")}`,
    month === "*" ? "" : `in ${describeField(month, "month")}`,
    dow === "*" ? "" : `on ${describeField(dow, "weekday", dayNames)}`,
  ]
    .filter(Boolean)
    .join(", ");
  const startMs = Number.isNaN(Date.parse(from)) ? Date.UTC(2026, 0, 1) : Date.parse(from);
  const nextRuns: string[] = [];
  const firstDay = Date.UTC(new Date(startMs).getUTCFullYear(), new Date(startMs).getUTCMonth(), new Date(startMs).getUTCDate());
  for (let offset = 0; offset < 1500 && nextRuns.length < count; offset += 1) {
    const day = new Date(firstDay + offset * 86_400_000);
    if (!months.includes(day.getUTCMonth() + 1) || !days.includes(day.getUTCDate()) || !weekdays.includes(day.getUTCDay())) continue;
    for (const hourValue of hours) {
      for (const minuteValue of minutes) {
        const at = day.getTime() + hourValue * 3_600_000 + minuteValue * 60_000;
        if (at > startMs && nextRuns.length < count) nextRuns.push(new Date(at).toISOString());
      }
    }
  }
  return { description: clip(`${description}.`, 500), nextRuns, valid: true };
}
