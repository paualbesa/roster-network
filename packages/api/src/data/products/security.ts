import { SOURCES } from "../sources.js";
import type { DataFetchContext, DataProductSpec, Row } from "../types.js";
import { daysAgo, numberOrNull, str, textOrNull } from "../util.js";

const OSV_BUCKET = "https://osv-vulnerabilities.storage.googleapis.com";

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  published?: string;
  modified?: string;
  withdrawn?: string;
  database_specific?: { severity?: string; cwe_ids?: string[] };
  severity?: { type: string; score: string }[];
  affected?: {
    package?: { ecosystem: string; name: string };
    ranges?: { type: string; events: Record<string, string>[] }[];
    versions?: string[];
  }[];
  references?: { type: string; url: string }[];
}

function osvRow(vuln: OsvVuln): Row {
  const affected = vuln.affected ?? [];
  const packages = [...new Set(affected.map((entry) => entry.package?.name).filter((name): name is string => Boolean(name)))];
  const fixed = [
    ...new Set(
      affected.flatMap((entry) => (entry.ranges ?? []).flatMap((range) => range.events.map((event) => event.fixed).filter(Boolean))),
    ),
  ] as string[];
  const introduced = [
    ...new Set(
      affected.flatMap((entry) =>
        (entry.ranges ?? []).flatMap((range) => range.events.map((event) => event.introduced).filter(Boolean)),
      ),
    ),
  ] as string[];
  return {
    id: vuln.id,
    kind: vuln.id.startsWith("MAL-") ? "malicious-package" : "vulnerability",
    packages: packages.join(";") || null,
    summary: textOrNull(vuln.summary ?? vuln.details ?? null, 400),
    severity: textOrNull(vuln.database_specific?.severity ?? null),
    cvss_vector: textOrNull(vuln.severity?.find((entry) => entry.type.startsWith("CVSS"))?.score ?? null),
    aliases: (vuln.aliases ?? []).join(";") || null,
    introduced: introduced.slice(0, 10).join(";") || null,
    fixed: fixed.slice(0, 10).join(";") || null,
    published_at: vuln.published ?? null,
    modified_at: vuln.modified ?? null,
    withdrawn: Boolean(vuln.withdrawn),
    url: `https://osv.dev/vulnerability/${vuln.id}`,
  };
}

async function osvRecent(ctx: DataFetchContext, ecosystem: string, previous: readonly Row[], max: number): Promise<Row[]> {
  // The index is newest-first; read only its head instead of the whole file.
  const head = await ctx.fetchText(`${OSV_BUCKET}/${ecosystem}/modified_id.csv`, { headers: { range: "bytes=0-40000" } });
  const known = new Map(previous.map((row) => [String(row.id), String(row.modified_at)]));
  const rows: Row[] = [];
  const lines = head.split("\n").slice(0, -1);
  for (const line of lines.slice(0, max)) {
    const [modified, id] = line.split(",");
    if (!modified || !id || !/^[A-Za-z0-9-]+$/.test(id)) continue;
    if (known.has(id) && Date.parse(known.get(id) ?? "") >= Date.parse(modified) - 1000) continue;
    try {
      rows.push(osvRow(await ctx.fetchJson<OsvVuln>(`${OSV_BUCKET}/${ecosystem}/${id}.json`, { timeoutMs: 20_000 })));
    } catch {
      // One missing advisory never fails the feed.
    }
    await ctx.sleep(60);
  }
  return rows;
}

const OSV_COLUMNS: DataProductSpec["columns"] = [
  { name: "id", type: "string", description: "OSV id (GHSA-…, PYSEC-…, MAL-…)." },
  { name: "kind", type: "string", description: "vulnerability or malicious-package." },
  { name: "packages", type: "string", description: "Affected package names, semicolon-separated." },
  { name: "summary", type: "string", description: "Short summary." },
  { name: "severity", type: "string", description: "Database severity (LOW…CRITICAL) when given." },
  { name: "cvss_vector", type: "string", description: "CVSS vector when given." },
  { name: "aliases", type: "string", description: "CVE and other aliases." },
  { name: "introduced", type: "string", description: "Introduced versions." },
  { name: "fixed", type: "string", description: "Fixed versions." },
  { name: "published_at", type: "datetime", description: "Published." },
  { name: "modified_at", type: "datetime", description: "Last modified." },
  { name: "withdrawn", type: "boolean", description: "Advisory withdrawn." },
  { name: "url", type: "string", description: "osv.dev page." },
];

function osvFeed(ecosystem: "npm" | "PyPI" | "Go" | "crates.io" | "Maven"): DataProductSpec {
  const label = ecosystem === "crates.io" ? "Rust (crates.io)" : ecosystem;
  const slug = `osv-${ecosystem.toLowerCase().replace(/[^a-z]/g, "")}-advisories`;
  return {
    slug,
    name: `${label} security advisories & malicious packages feed (OSV)`,
    kind: "feed",
    description: `Rolling 30-day feed of new and updated ${label} security advisories and malicious-package reports from OSV.dev: package names, affected and fixed versions, severity, CVE aliases. Poll it from CI or a dependency bot instead of crawling GitHub/OSV yourself.`,
    tags: ["security", "vulnerabilities", "osv", "advisories", "supply-chain", "malware", ecosystem.toLowerCase().replace(/[^a-z0-9]+/g, "-"), "feed", "dependencies"],
    sources: [SOURCES.osv],
    cadence: "every 3 hours",
    intervalS: 3 * 3600,
    priceUsdc: "0.005",
    p95Ms: 4000,
    timeField: "modified_at",
    idField: "id",
    retainDays: 30,
    maxRows: 5000,
    filterFields: ["kind", "severity"],
    columns: OSV_COLUMNS,
    ingest: (ctx, previous) => osvRecent(ctx, ecosystem, previous, 150),
  };
}

export const securityProducts: DataProductSpec[] = [
  {
    slug: "cisa-kev",
    name: "CISA Known Exploited Vulnerabilities (KEV) catalog",
    kind: "dataset",
    description:
      "The full CISA KEV catalog: every CVE known to be exploited in the wild, with vendor, product, date added, remediation due date, ransomware use and required action. The list security teams prioritise patching against.",
    tags: ["security", "cve", "kev", "cisa", "exploited", "vulnerabilities", "patching", "ransomware"],
    sources: [SOURCES.cisaKev],
    cadence: "every 6 hours",
    intervalS: 6 * 3600,
    priceUsdc: "0.01",
    p95Ms: 6000,
    columns: [
      { name: "cve_id", type: "string", description: "CVE id." },
      { name: "vendor", type: "string", description: "Vendor/project." },
      { name: "product", type: "string", description: "Product." },
      { name: "name", type: "string", description: "Vulnerability name." },
      { name: "date_added", type: "date", description: "Added to KEV." },
      { name: "due_date", type: "date", description: "Federal remediation due date." },
      { name: "known_ransomware", type: "string", description: "Known / Unknown ransomware campaign use." },
      { name: "required_action", type: "string", description: "Required action." },
      { name: "cwes", type: "string", description: "CWE ids." },
      { name: "description", type: "string", description: "Short description." },
    ],
    ingest: async (ctx) => {
      const data = await ctx.fetchJson<{
        vulnerabilities: {
          cveID: string;
          vendorProject: string;
          product: string;
          vulnerabilityName: string;
          dateAdded: string;
          dueDate: string;
          knownRansomwareCampaignUse: string;
          requiredAction: string;
          shortDescription: string;
          cwes?: string[];
        }[];
      }>("https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json");
      return data.vulnerabilities
        .map((entry) => ({
          cve_id: entry.cveID,
          vendor: textOrNull(entry.vendorProject),
          product: textOrNull(entry.product),
          name: textOrNull(entry.vulnerabilityName),
          date_added: entry.dateAdded,
          due_date: entry.dueDate,
          known_ransomware: textOrNull(entry.knownRansomwareCampaignUse),
          required_action: textOrNull(entry.requiredAction, 500),
          cwes: (entry.cwes ?? []).join(";") || null,
          description: textOrNull(entry.shortDescription, 800),
        }))
        .sort((left, right) => right.date_added.localeCompare(left.date_added) || left.cve_id.localeCompare(right.cve_id));
    },
  },
  {
    slug: "kev-check",
    name: "Is this CVE actively exploited? KEV check (lookup)",
    kind: "lookup",
    description:
      "Pass one or more CVE ids and learn which are in CISA's Known Exploited Vulnerabilities catalog, with date added, due date and ransomware use. Instant triage for scanners and SOC agents.",
    tags: ["security", "cve", "kev", "triage", "exploited", "lookup"],
    sources: [SOURCES.cisaKev],
    cadence: "every 6 hours",
    intervalS: 6 * 3600,
    priceUsdc: "0.001",
    p95Ms: 4000,
    columns: [
      { name: "cve_id", type: "string", description: "Requested CVE." },
      { name: "in_kev", type: "boolean", description: "Listed in KEV." },
      { name: "date_added", type: "date", description: "Added to KEV (null if not listed)." },
      { name: "due_date", type: "date", description: "Remediation due date." },
      { name: "known_ransomware", type: "string", description: "Ransomware use." },
      { name: "vendor", type: "string", description: "Vendor." },
      { name: "product", type: "string", description: "Product." },
    ],
    input: { cves: { type: "array", items: { type: "string" }, description: "CVE ids, e.g. CVE-2021-44228." } },
    required: ["cves"],
    example: { cves: ["CVE-2021-44228", "CVE-2099-0001"] },
    lookup: async (input, ctx) => {
      const rows = await ctx.rowsOf("cisa-kev");
      // Accept "cves", "cve", or "id" so a near-miss input still answers.
      const raw = input.cves ?? input.cve ?? input.id;
      const wanted = (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [])
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim().toUpperCase())
        .filter((value) => /^CVE-\d{4}-\d{4,}$/.test(value))
        .slice(0, 100);
      const byId = new Map(rows.map((row) => [String(row.cve_id), row]));
      return [...new Set(wanted)].map((cve) => {
        const hit = byId.get(cve);
        return {
          cve_id: cve,
          in_kev: Boolean(hit),
          date_added: hit?.date_added ?? null,
          due_date: hit?.due_date ?? null,
          known_ransomware: hit?.known_ransomware ?? null,
          vendor: hit?.vendor ?? null,
          product: hit?.product ?? null,
        };
      });
    },
  },
  {
    slug: "nvd-recent-cves",
    name: "New CVEs feed — NVD, with CVSS scores (last 30 days)",
    kind: "feed",
    description:
      "Rolling 30-day feed of newly published CVEs from the NIST National Vulnerability Database: description, CVSS v3/v4 base score and severity, CWE, and published/modified times. Filter by severity or poll since your last check.",
    tags: ["security", "cve", "nvd", "cvss", "vulnerabilities", "feed", "nist"],
    sources: [SOURCES.nvd],
    cadence: "every 6 hours",
    intervalS: 6 * 3600,
    priceUsdc: "0.005",
    p95Ms: 4000,
    timeField: "published_at",
    idField: "cve_id",
    retainDays: 30,
    maxRows: 20_000,
    filterFields: ["severity"],
    columns: [
      { name: "cve_id", type: "string", description: "CVE id." },
      { name: "published_at", type: "datetime", description: "Published (UTC)." },
      { name: "modified_at", type: "datetime", description: "Last modified (UTC)." },
      { name: "status", type: "string", description: "NVD vulnStatus." },
      { name: "cvss_score", type: "number", description: "Highest CVSS base score available." },
      { name: "severity", type: "string", description: "CVSS severity (LOW…CRITICAL)." },
      { name: "cvss_version", type: "string", description: "CVSS version of the score." },
      { name: "cwes", type: "string", description: "CWE ids." },
      { name: "description", type: "string", description: "English description." },
      { name: "url", type: "string", description: "NVD detail page." },
    ],
    ingest: async (ctx, previous) => {
      const end = ctx.now();
      const start = previous.length > 0 ? daysAgo(end, 2) : daysAgo(end, 10);
      const fmt = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, ".000");
      const rows: Row[] = [];
      for (let startIndex = 0; startIndex < 10_000; startIndex += 2000) {
        const data = await ctx.fetchJson<{
          totalResults: number;
          vulnerabilities: {
            cve: {
              id: string;
              published: string;
              lastModified: string;
              vulnStatus: string;
              descriptions: { lang: string; value: string }[];
              weaknesses?: { description: { value: string }[] }[];
              metrics?: Record<string, { cvssData?: { baseScore?: number; baseSeverity?: string; version?: string }; baseSeverity?: string }[]>;
            };
          }[];
        }>(
          `https://services.nvd.nist.gov/rest/json/cves/2.0?pubStartDate=${fmt(start)}&pubEndDate=${fmt(end)}&resultsPerPage=2000&startIndex=${startIndex.toString()}`,
          { timeoutMs: 120_000 },
        );
        for (const { cve } of data.vulnerabilities) {
          const metrics = Object.values(cve.metrics ?? {})
            .flat()
            .filter((metric) => typeof metric.cvssData?.baseScore === "number");
          const best = metrics.sort((left, right) => (right.cvssData?.baseScore ?? 0) - (left.cvssData?.baseScore ?? 0))[0];
          rows.push({
            cve_id: cve.id,
            published_at: `${cve.published.slice(0, 19)}Z`,
            modified_at: `${cve.lastModified.slice(0, 19)}Z`,
            status: textOrNull(cve.vulnStatus),
            cvss_score: numberOrNull(best?.cvssData?.baseScore ?? null),
            severity: textOrNull(best?.cvssData?.baseSeverity ?? best?.baseSeverity ?? null),
            cvss_version: textOrNull(best?.cvssData?.version ?? null),
            cwes:
              [...new Set((cve.weaknesses ?? []).flatMap((weakness) => weakness.description.map((entry) => entry.value)))]
                .filter((value) => value.startsWith("CWE-"))
                .join(";") || null,
            description: textOrNull(cve.descriptions.find((entry) => entry.lang === "en")?.value ?? null, 1000),
            url: `https://nvd.nist.gov/vuln/detail/${cve.id}`,
          });
        }
        if (startIndex + 2000 >= data.totalResults) break;
        // NVD allows 5 requests per 30 s without a key.
        await ctx.sleep(7000);
      }
      return rows;
    },
  },
  osvFeed("npm"),
  osvFeed("PyPI"),
  osvFeed("Go"),
  osvFeed("crates.io"),
  osvFeed("Maven"),
  {
    slug: "osv-package-check",
    name: "Dependency vulnerability check — any package version (OSV, live)",
    kind: "lookup",
    description:
      "Check whether a specific package version (npm, PyPI, Go, Maven, crates.io, RubyGems, NuGet, Packagist…) has known vulnerabilities or is a known malicious package. Returns advisory ids, summaries, severity and fixed versions. Live query to OSV.dev.",
    tags: ["security", "vulnerabilities", "dependencies", "sca", "osv", "npm", "pypi", "supply-chain", "lookup"],
    sources: [SOURCES.osv],
    cadence: "live",
    intervalS: 3600,
    priceUsdc: "0.002",
    p95Ms: 8000,
    live: true,
    columns: OSV_COLUMNS,
    input: {
      ecosystem: { type: "string", description: "npm, PyPI, Go, Maven, crates.io, RubyGems, NuGet, Packagist…" },
      name: { type: "string" },
      version: { type: "string" },
    },
    required: ["ecosystem", "name"],
    example: { ecosystem: "npm", name: "lodash", version: "4.17.15" },
    lookup: async (input, ctx) => {
      const ecosystem = str(input, "ecosystem", 40);
      const name = str(input, "name", 214);
      const version = str(input, "version", 100);
      if (!ecosystem || !name) return [];
      const data = await ctx.fetchJson<{ vulns?: OsvVuln[] }>("https://api.osv.dev/v1/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ package: { ecosystem, name }, ...(version ? { version } : {}) }),
        timeoutMs: 7000,
      });
      return (data.vulns ?? []).slice(0, 50).map((vuln) => osvRow(vuln));
    },
  },
  {
    slug: "depsdev-package",
    name: "Package intelligence — versions, licenses, advisories (deps.dev, live)",
    kind: "lookup",
    description:
      "For an npm, PyPI, Go, Maven, Cargo or NuGet package: default/latest version, publish date, declared licenses, number of known advisories and the source repo, from Google's Open Source Insights (deps.dev). Use it to vet a dependency before adding it.",
    tags: ["dependencies", "licenses", "open-source", "deps-dev", "npm", "pypi", "package-metadata", "lookup"],
    sources: [SOURCES.depsDev],
    cadence: "live",
    intervalS: 3600,
    priceUsdc: "0.002",
    p95Ms: 8000,
    live: true,
    columns: [
      { name: "system", type: "string", description: "Package system." },
      { name: "name", type: "string", description: "Package name." },
      { name: "version", type: "string", description: "Default (latest stable) version." },
      { name: "published_at", type: "datetime", description: "Publish time of that version." },
      { name: "licenses", type: "string", description: "SPDX licenses." },
      { name: "advisories", type: "integer", description: "Known advisories on that version." },
      { name: "advisory_ids", type: "string", description: "Advisory ids." },
      { name: "version_count", type: "integer", description: "Versions published." },
      { name: "source_repo", type: "string", description: "Source repository URL." },
    ],
    input: {
      system: { type: "string", description: "npm, pypi, go, maven, cargo, nuget." },
      name: { type: "string" },
    },
    required: ["system", "name"],
    example: { system: "npm", name: "express" },
    lookup: async (input, ctx) => {
      const system = str(input, "system", 10).toLowerCase();
      const name = str(input, "name", 214);
      if (!["npm", "pypi", "go", "maven", "cargo", "nuget"].includes(system) || !name) return [];
      const base = `https://api.deps.dev/v3/systems/${system}/packages/${encodeURIComponent(name)}`;
      const pkg = await ctx.fetchJson<{ versions: { versionKey: { version: string }; isDefault?: boolean; publishedAt?: string }[] }>(base, {
        timeoutMs: 6000,
      });
      const chosen = pkg.versions.find((entry) => entry.isDefault) ?? pkg.versions[pkg.versions.length - 1];
      if (!chosen) return [];
      const detail = await ctx.fetchJson<{
        licenses?: string[];
        advisoryKeys?: { id: string }[];
        links?: { label: string; url: string }[];
        publishedAt?: string;
      }>(`${base}/versions/${encodeURIComponent(chosen.versionKey.version)}`, { timeoutMs: 6000 });
      return [
        {
          system,
          name,
          version: chosen.versionKey.version,
          published_at: detail.publishedAt ?? chosen.publishedAt ?? null,
          licenses: (detail.licenses ?? []).join(";") || null,
          advisories: (detail.advisoryKeys ?? []).length,
          advisory_ids: (detail.advisoryKeys ?? []).map((key) => key.id).join(";") || null,
          version_count: pkg.versions.length,
          source_repo: detail.links?.find((link) => link.label === "SOURCE_REPO")?.url ?? null,
        },
      ];
    },
  },
];
