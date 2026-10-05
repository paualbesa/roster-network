import { clip, isRecord, records, s, strings, text, type FleetTool, type Json } from "./kit.js";

const SAMPLE_DIFF = [
  "diff --git a/src/pay.ts b/src/pay.ts",
  "--- a/src/pay.ts",
  "+++ b/src/pay.ts",
  "@@ -1,4 +1,6 @@",
  "-export function pay(amount) {",
  "+export function pay(amount: number) {",
  "+  if (amount <= 0) throw new Error(\"amount must be positive\");",
  "   return charge(amount);",
  " }",
  "diff --git a/README.md b/README.md",
  "+Payments now validate the amount.",
].join("\n");

const SECRET_RULES: [string, RegExp, "high" | "medium"][] = [
  ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/, "high"],
  ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, "high"],
  ["github_token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "high"],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, "high"],
  ["stripe_secret", /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/, "high"],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/, "high"],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, "medium"],
  ["solana_secret_array", /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/, "high"],
  ["generic_secret", /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["'][^"'\s]{8,}["']/i, "medium"],
];

const LINT_RULES: { rule: string; severity: "error" | "warning" | "info"; pattern: RegExp; message: string }[] = [
  { rule: "no-eval", severity: "error", pattern: /\beval\s*\(|new Function\s*\(/, message: "Avoid eval/new Function: code injection risk." },
  { rule: "no-console", severity: "warning", pattern: /\bconsole\.(log|debug)\(/, message: "Remove debug logging before merging." },
  { rule: "no-explicit-any", severity: "warning", pattern: /:\s*any\b|<any>|as any\b/, message: "Prefer a precise type over any." },
  { rule: "todo-comment", severity: "info", pattern: /\b(TODO|FIXME|HACK|XXX)\b/, message: "Unresolved TODO/FIXME." },
  { rule: "no-var", severity: "warning", pattern: /^\s*var\s+/, message: "Use let or const instead of var." },
  { rule: "eqeqeq", severity: "warning", pattern: /[^=!]==[^=]|!=[^=]/, message: "Use === / !== for comparisons." },
  { rule: "no-empty-catch", severity: "warning", pattern: /catch\s*(\([^)]*\))?\s*\{\s*\}/, message: "Empty catch block hides errors." },
  { rule: "sql-concat", severity: "error", pattern: /(SELECT|INSERT|UPDATE|DELETE)\b[^;]*["'`]\s*\+\s*\w+/i, message: "Possible SQL injection: use parameters." },
  { rule: "inner-html", severity: "warning", pattern: /\.innerHTML\s*=|dangerouslySetInnerHTML/, message: "Unescaped HTML can cause XSS." },
  { rule: "hardcoded-http", severity: "info", pattern: /["']http:\/\/(?!localhost|127\.0\.0\.1)/, message: "Plain HTTP URL: prefer HTTPS." },
];

export const codeTools: FleetTool[] = [
  {
    name: "Code review linter",
    slug: "code_review",
    category: "code",
    description:
      "Automated code review for JavaScript, TypeScript and similar languages: flags eval, SQL string concatenation, XSS " +
      "sinks, any types, loose equality, empty catch blocks, debug logs, long lines, TODOs and hardcoded secrets, with a " +
      "quality score. A fast first pass before human pull request review.",
    tags: ["code-review", "lint", "static-analysis", "security", "typescript", "code"],
    priceUsdc: "0.05",
    p95Ms: 600,
    p50Ms: 150,
    input: { code: s.str(100_000, 1), language: s.str(32), maxLineLength: s.int(60, 400) },
    required: ["code"],
    example: { code: "var total = 0\nfunction add(x: any) {\n  if (x == null) return\n  console.log(x)\n  eval(x)\n}\n", language: "typescript" },
    output: s.obj({
      score: s.int(0, 100),
      findings: s.arr(s.obj({ line: s.int(1), severity: s.enm(["error", "warning", "info"]), rule: s.str(32), message: s.str(200) }), 200),
      summary: s.obj({ errors: s.int(0), warnings: s.int(0), infos: s.int(0), lines: s.int(0) }),
    }),
    run(input) {
      const lines = String(input.code ?? "").slice(0, 100_000).split("\n");
      const maxLength = typeof input.maxLineLength === "number" ? Math.min(400, Math.max(60, Math.trunc(input.maxLineLength))) : 120;
      const findings: { line: number; severity: "error" | "warning" | "info"; rule: string; message: string }[] = [];
      lines.forEach((line, index) => {
        if (findings.length >= 200) return;
        for (const rule of LINT_RULES) {
          if (rule.pattern.test(line) && findings.length < 200) findings.push({ line: index + 1, severity: rule.severity, rule: rule.rule, message: rule.message });
        }
        for (const [name, pattern] of SECRET_RULES) {
          if (pattern.test(line) && findings.length < 200) findings.push({ line: index + 1, severity: "error", rule: "hardcoded-secret", message: `Possible ${name.replace(/_/g, " ")} in source.` });
        }
        if (line.length > maxLength && findings.length < 200) {
          findings.push({ line: index + 1, severity: "info", rule: "max-len", message: `Line is ${line.length.toString()} characters (limit ${maxLength.toString()}).` });
        }
      });
      const errors = findings.filter((finding) => finding.severity === "error").length;
      const warnings = findings.filter((finding) => finding.severity === "warning").length;
      const infos = findings.length - errors - warnings;
      const score = Math.max(0, Math.min(100, 100 - errors * 15 - warnings * 5 - infos));
      return { score, findings, summary: { errors, warnings, infos, lines: lines.length } };
    },
  },
  {
    name: "Secret scanner",
    slug: "secret_scan",
    category: "code",
    description:
      "Scan code, config files, logs or a git diff for leaked credentials: AWS access keys, private keys, GitHub, Slack, " +
      "Stripe and Google API tokens, JWTs, Solana secret-key arrays and password assignments. Secrets are masked in the " +
      "output. Pre-commit and CI secret detection.",
    tags: ["secrets", "security", "credentials", "devsecops", "code"],
    priceUsdc: "0.03",
    p95Ms: 400,
    p50Ms: 100,
    input: { content: s.str(200_000, 1) },
    required: ["content"],
    example: { content: `const key = "${"AKIA"}${"EXAMPLEEXAMPLE00"}";\npassword = "hunter2hunter2"\n` },
    output: s.obj({
      findings: s.arr(s.obj({ line: s.int(1), type: s.str(32), severity: s.enm(["high", "medium"]), preview: s.str(80) }), 200),
      clean: s.bool(),
    }),
    run(input) {
      const lines = String(input.content ?? "").slice(0, 200_000).split("\n");
      const findings: { line: number; type: string; severity: "high" | "medium"; preview: string }[] = [];
      lines.forEach((line, index) => {
        for (const [type, pattern, severity] of SECRET_RULES) {
          const match = pattern.exec(line);
          if (match && findings.length < 200) {
            const value = match[0];
            const preview = value.length <= 8 ? "****" : `${value.slice(0, 4)}…${"*".repeat(Math.min(8, value.length - 4))}`;
            findings.push({ line: index + 1, type, severity, preview: clip(preview, 80) });
          }
        }
      });
      return { findings, clean: findings.length === 0 };
    },
  },
  {
    name: "Unified diff summarizer",
    slug: "diff_summary",
    category: "code",
    description:
      "Summarize a unified git diff or patch: files changed, lines added and removed per file, file types touched and a " +
      "one-paragraph human summary. Pull request descriptions, changelogs and code review triage.",
    tags: ["git", "diff", "pull-request", "summarize", "code"],
    priceUsdc: "0.02",
    p95Ms: 300,
    p50Ms: 80,
    input: { diff: s.str(200_000, 1) },
    required: ["diff"],
    example: { diff: SAMPLE_DIFF },
    output: s.obj({
      files: s.arr(s.obj({ path: s.str(300), additions: s.int(0), deletions: s.int(0), status: s.enm(["added", "deleted", "modified", "renamed"]) }), 200),
      additions: s.int(0),
      deletions: s.int(0),
      summary: s.str(1000),
    }),
    run(input) {
      const files = parseDiff(String(input.diff ?? "").slice(0, 200_000));
      const additions = files.reduce((sum, file) => sum + file.additions, 0);
      const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
      const extensions = [...new Set(files.map((file) => file.path.split(".").pop() ?? ""))].filter(Boolean).slice(0, 6);
      const summary =
        files.length === 0
          ? "No file changes found in the diff."
          : `${files.length.toString()} file${files.length === 1 ? "" : "s"} changed (+${additions.toString()} / -${deletions.toString()}). ` +
            `Largest change: ${files.slice().sort((left, right) => right.additions + right.deletions - left.additions - left.deletions)[0]?.path ?? ""}. ` +
            (extensions.length > 0 ? `File types: ${extensions.join(", ")}.` : "");
      return { files: files.slice(0, 200), additions, deletions, summary: clip(summary, 1000) };
    },
  },
  {
    name: "Commit message writer",
    slug: "commit_message",
    category: "code",
    description:
      "Write a Conventional Commits message (feat, fix, docs, test, refactor, chore) from a git diff: type, scope, subject " +
      "line under 72 characters and a body listing touched files. Consistent commit history and changelog generation.",
    tags: ["git", "commit", "conventional-commits", "changelog", "code"],
    priceUsdc: "0.015",
    p95Ms: 300,
    p50Ms: 60,
    input: { diff: s.str(200_000, 1), hint: s.str(200) },
    required: ["diff"],
    example: { diff: SAMPLE_DIFF, hint: "validate payment amount" },
    output: s.obj({ type: s.str(16), scope: s.str(32), subject: s.str(72), message: s.str(2000) }),
    run(input) {
      const files = parseDiff(String(input.diff ?? "").slice(0, 200_000));
      const paths = files.map((file) => file.path);
      const raw = String(input.diff ?? "");
      const type = paths.length > 0 && paths.every((path) => /\.(md|mdx|txt)$|^docs\//.test(path))
        ? "docs"
        : paths.length > 0 && paths.every((path) => /\.(test|spec)\.|__tests__|^tests?\//.test(path))
          ? "test"
          : /\bfix|bug|throw new Error|catch\b/i.test(raw)
            ? "fix"
            : files.some((file) => file.status === "added")
              ? "feat"
              : files.every((file) => file.additions <= file.deletions)
                ? "refactor"
                : "feat";
      const dirs = paths.map((path) => path.split("/").slice(0, -1).pop() ?? "").filter((dir) => dir && dir !== "src");
      const scope = clip(dirs[0] ?? (paths[0]?.split("/")[0]?.replace(/\..*$/, "") ?? ""), 32);
      const hint = text(input, "hint").trim().replace(/[.\s]+$/, "");
      const subjectCore = hint || (paths.length > 0 ? `update ${paths.slice(0, 2).map((path) => path.split("/").pop()).join(" and ")}` : "update code");
      const prefix = `${type}${scope ? `(${scope})` : ""}: `;
      const subject = clip(`${prefix}${subjectCore.charAt(0).toLowerCase()}${subjectCore.slice(1)}`, 72);
      const body = files.slice(0, 20).map((file) => `- ${file.path} (+${file.additions.toString()}/-${file.deletions.toString()})`).join("\n");
      return { type, scope, subject, message: clip(body ? `${subject}\n\n${body}` : subject, 2000) };
    },
  },
  {
    name: "JSON to TypeScript types",
    slug: "json_to_ts",
    category: "code",
    description:
      "Generate TypeScript interfaces from a sample JSON payload, with nested types, arrays and optional fields. Speeds up " +
      "typing API responses, webhooks and SDK models.",
    tags: ["typescript", "codegen", "json", "types", "code"],
    priceUsdc: "0.01",
    p95Ms: 250,
    p50Ms: 50,
    input: { json: { type: "object" }, rootName: s.str(64) },
    required: ["json"],
    example: { json: { id: "job_1", amountUsdc: "1.00", status: "released", seller: { id: "agt_9", score: 91.2 }, tags: ["ocr"] }, rootName: "Job" },
    output: s.obj({ typescript: s.str(50_000), interfaces: s.int(0) }),
    run(input) {
      const root = isRecord(input.json) ? input.json : {};
      const rootName = pascal(text(input, "rootName") || "Root");
      const declarations: string[] = [];
      buildInterface(rootName, root, declarations, 0);
      return { typescript: clip(declarations.join("\n\n"), 50_000), interfaces: declarations.length };
    },
  },
  {
    name: "SQL formatter",
    slug: "sql_format",
    category: "code",
    description:
      "Pretty-print SQL queries: uppercase keywords, one clause per line (SELECT, FROM, JOIN, WHERE, GROUP BY, ORDER BY) and " +
      "indented column lists. Readable queries for code review, docs and debugging slow queries.",
    tags: ["sql", "formatter", "database", "postgres", "code"],
    priceUsdc: "0.005",
    p95Ms: 200,
    p50Ms: 40,
    input: { sql: s.str(50_000, 1) },
    required: ["sql"],
    example: { sql: "select id, name, count(*) as jobs from agents a join jobs j on j.seller_agent_id = a.id where a.status = 'active' group by id, name order by jobs desc limit 10" },
    output: s.obj({ sql: s.str(60_000), statements: s.int(0) }),
    run(input) {
      const source = text(input, "sql").replace(/\s+/g, " ").trim();
      const keywords = ["select", "from", "where", "group by", "order by", "having", "limit", "offset", "left join", "right join", "inner join", "full join", "join", "on", "and", "or", "insert into", "values", "update", "set", "delete from", "returning", "union all", "union", "with", "as", "count", "sum", "avg", "min", "max", "distinct", "desc", "asc", "in", "is", "not", "null", "like", "between", "case", "when", "then", "else", "end"];
      const segments = source.split(/('(?:[^']|'')*')/);
      const formatted = segments
        .map((segment, index) => {
          if (index % 2 === 1) return segment;
          let out = segment;
          for (const keyword of keywords) {
            out = out.replace(new RegExp(`\\b${keyword.replace(" ", "\\s+")}\\b`, "gi"), keyword.toUpperCase());
          }
          return out
            .replace(/\s*\b(SELECT|FROM|WHERE|GROUP BY|ORDER BY|HAVING|LIMIT|OFFSET|LEFT JOIN|RIGHT JOIN|INNER JOIN|FULL JOIN|VALUES|SET|RETURNING|UNION ALL|UNION)\b/g, "\n$1")
            .replace(/(?<!LEFT|RIGHT|INNER|FULL)\s+\bJOIN\b/g, "\nJOIN")
            .replace(/\s+\b(AND|OR)\b\s+/g, "\n  $1 ")
            .replace(/,\s*/g, ",\n  ");
        })
        .join("")
        .replace(/;\s*/g, ";\n\n")
        .trim();
      return { sql: clip(formatted, 60_000), statements: Math.max(1, (source.match(/;/g) ?? []).length + (source.trim().endsWith(";") ? 0 : 1)) };
    },
  },
  {
    name: "SQL risk checker",
    slug: "sql_risk",
    category: "code",
    description:
      "Review a SQL statement for risky patterns before it runs in production: DELETE or UPDATE without WHERE, DROP/TRUNCATE, " +
      "SELECT *, missing LIMIT, leading-wildcard LIKE, implicit cross joins and GRANT ALL. Database change review and " +
      "migration safety checks.",
    tags: ["sql", "database", "migrations", "safety", "code-review"],
    priceUsdc: "0.01",
    p95Ms: 200,
    p50Ms: 40,
    input: { sql: s.str(50_000, 1) },
    required: ["sql"],
    example: { sql: "DELETE FROM jobs; SELECT * FROM agents WHERE name LIKE '%bot'" },
    output: s.obj({
      risk: s.enm(["low", "medium", "high"]),
      findings: s.arr(s.obj({ rule: s.str(32), severity: s.enm(["high", "medium", "low"]), message: s.str(200) }), 50),
    }),
    run(input) {
      const statements = text(input, "sql").split(";").map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
      const findings: { rule: string; severity: "high" | "medium" | "low"; message: string }[] = [];
      for (const statement of statements.slice(0, 100)) {
        const upper = statement.toUpperCase();
        const push = (rule: string, severity: "high" | "medium" | "low", message: string) => {
          if (findings.length < 50) findings.push({ rule, severity, message });
        };
        if (/^DELETE\b/.test(upper) && !/\bWHERE\b/.test(upper)) push("delete-without-where", "high", "DELETE without WHERE removes every row.");
        if (/^UPDATE\b/.test(upper) && !/\bWHERE\b/.test(upper)) push("update-without-where", "high", "UPDATE without WHERE changes every row.");
        if (/^(DROP|TRUNCATE)\b/.test(upper)) push("destructive-ddl", "high", "DROP/TRUNCATE is irreversible without a backup.");
        if (/\bGRANT\s+ALL\b/.test(upper)) push("grant-all", "high", "GRANT ALL gives broader access than needed.");
        if (/^SELECT\s+\*/.test(upper)) push("select-star", "low", "SELECT * fetches unused columns and breaks on schema changes.");
        if (/^SELECT\b/.test(upper) && !/\bLIMIT\b/.test(upper) && !/\bWHERE\b/.test(upper)) push("unbounded-select", "medium", "SELECT without WHERE or LIMIT can scan the whole table.");
        if (/LIKE\s+'%/.test(upper)) push("leading-wildcard", "medium", "LIKE '%…' cannot use a b-tree index.");
        if (/\bFROM\s+\w+\s*,\s*\w+/.test(upper) && !/\bWHERE\b/.test(upper)) push("cross-join", "medium", "Comma join without WHERE is a cross join.");
      }
      const risk = findings.some((finding) => finding.severity === "high") ? "high" : findings.some((finding) => finding.severity === "medium") ? "medium" : "low";
      return { risk, findings };
    },
  },
  {
    name: "Semver bump advisor",
    slug: "semver_bump",
    category: "code",
    description:
      "Recommend the next semantic version (major, minor or patch) from a list of changes or commit messages, following " +
      "SemVer and Conventional Commits (BREAKING CHANGE, feat, fix). Release automation and changelog grouping.",
    tags: ["semver", "release", "versioning", "changelog", "code"],
    priceUsdc: "0.005",
    p95Ms: 150,
    p50Ms: 30,
    input: { currentVersion: s.str(32, 1), changes: s.arr(s.str(300), 500, 1) },
    required: ["currentVersion", "changes"],
    example: { currentVersion: "1.4.2", changes: ["feat(api): add KYC tiers", "fix: refund on SLA timeout", "docs: escrow design"] },
    output: s.obj({
      bump: s.enm(["major", "minor", "patch", "none"]),
      nextVersion: s.str(32),
      groups: s.obj({ breaking: s.arr(s.str(300), 100), features: s.arr(s.str(300), 100), fixes: s.arr(s.str(300), 100), other: s.arr(s.str(300), 100) }),
    }),
    run(input) {
      const changes = strings(input, "changes", 500, 300);
      const groups = { breaking: [] as string[], features: [] as string[], fixes: [] as string[], other: [] as string[] };
      for (const change of changes) {
        if (/BREAKING CHANGE|^\w+(\(.*\))?!:/.test(change)) groups.breaking.push(change);
        else if (/^feat/i.test(change)) groups.features.push(change);
        else if (/^(fix|perf)/i.test(change)) groups.fixes.push(change);
        else groups.other.push(change);
      }
      const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text(input, "currentVersion").trim());
      const [major, minor, patch] = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
      const bump = groups.breaking.length > 0 ? "major" : groups.features.length > 0 ? "minor" : groups.fixes.length > 0 || groups.other.length > 0 ? "patch" : "none";
      const nextVersion =
        bump === "major" ? `${(major + 1).toString()}.0.0` : bump === "minor" ? `${major.toString()}.${(minor + 1).toString()}.0` : bump === "patch" ? `${major.toString()}.${minor.toString()}.${(patch + 1).toString()}` : `${major.toString()}.${minor.toString()}.${patch.toString()}`;
      const cap = (list: string[]) => list.slice(0, 100);
      return { bump, nextVersion, groups: { breaking: cap(groups.breaking), features: cap(groups.features), fixes: cap(groups.fixes), other: cap(groups.other) } };
    },
  },
  {
    name: "Access log parser",
    slug: "log_parse",
    category: "code",
    description:
      "Parse web server access logs (Apache/Nginx common and combined formats) into structured entries and aggregate status " +
      "codes, top paths and error rate. Incident triage, traffic analysis and observability without a log pipeline.",
    tags: ["logs", "nginx", "observability", "parse", "devops"],
    priceUsdc: "0.015",
    p95Ms: 400,
    p50Ms: 100,
    input: { logs: s.str(200_000, 1) },
    required: ["logs"],
    example: {
      logs: '1.2.3.4 - - [05/Oct/2026:18:00:01 +0200] "GET /v1/registry/search?q=ocr HTTP/1.1" 200 512 "-" "curl/8.0"\n5.6.7.8 - - [05/Oct/2026:18:00:02 +0200] "POST /v1/jobs HTTP/1.1" 500 87 "-" "node"',
    },
    output: s.obj({
      entries: s.int(0),
      unparsed: s.int(0),
      errorRate: s.num(0, 1),
      statuses: s.arr(s.obj({ status: s.int(100, 599), count: s.int(1) }), 50),
      topPaths: s.arr(s.obj({ path: s.str(300), count: s.int(1) }), 10),
    }),
    run(input) {
      const lines = String(input.logs ?? "").slice(0, 200_000).split("\n").filter((line) => line.trim() !== "");
      const pattern = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+)[^"]*" (\d{3}) (\S+)/;
      const statuses = new Map<number, number>();
      const paths = new Map<string, number>();
      let parsed = 0;
      let errors = 0;
      for (const line of lines) {
        const match = pattern.exec(line);
        if (!match) continue;
        parsed += 1;
        const status = Number(match[5]);
        if (status >= 500) errors += 1;
        statuses.set(status, (statuses.get(status) ?? 0) + 1);
        const path = (match[4] ?? "").split("?")[0] ?? "";
        paths.set(path, (paths.get(path) ?? 0) + 1);
      }
      return {
        entries: parsed,
        unparsed: lines.length - parsed,
        errorRate: parsed === 0 ? 0 : Math.round((errors / parsed) * 1000) / 1000,
        statuses: [...statuses.entries()].sort((left, right) => left[0] - right[0]).slice(0, 50).map(([status, count]) => ({ status, count })),
        topPaths: [...paths.entries()].sort((left, right) => right[1] - left[1]).slice(0, 10).map(([path, count]) => ({ path: clip(path, 300), count })),
      };
    },
  },
  {
    name: "Stack trace summarizer",
    slug: "stacktrace_summary",
    category: "code",
    description:
      "Summarize a stack trace from Node.js, Python, Java or Go: error type, message, the first in-app frame (skipping " +
      "node_modules and library frames) and a likely-cause hint. Faster debugging and cleaner bug reports.",
    tags: ["debugging", "errors", "stack-trace", "observability", "code"],
    priceUsdc: "0.015",
    p95Ms: 250,
    p50Ms: 60,
    input: { trace: s.str(50_000, 1) },
    required: ["trace"],
    example: {
      trace: "TypeError: Cannot read properties of undefined (reading 'id')\n    at toView (/app/node_modules/hono/dist/x.js:10:3)\n    at JobOrchestrator.createJob (/app/src/jobs.ts:463:22)\n    at async /app/src/app.ts:650:5",
    },
    output: s.obj({
      errorType: s.str(100),
      message: s.str(500),
      language: s.enm(["javascript", "python", "java", "go", "unknown"]),
      topFrame: s.str(300),
      frames: s.int(0),
      hint: s.str(300),
    }),
    run(input) {
      const trace = text(input, "trace", "");
      const lines = trace.split("\n").map((line) => line.trim()).filter(Boolean);
      const language = /^\s*at .+\(.+:\d+:\d+\)|^\s*at .+:\d+:\d+/m.test(trace)
        ? /\.java:\d+\)/.test(trace)
          ? "java"
          : "javascript"
        : /Traceback \(most recent call last\)|File ".+", line \d+/.test(trace)
          ? "python"
          : /goroutine \d+|\.go:\d+/.test(trace)
            ? "go"
            : "unknown";
      const headline = language === "python" ? [...lines].reverse().find((line) => /^\w+(Error|Exception)\b/.test(line)) ?? lines[lines.length - 1] ?? "" : lines.find((line) => /(Error|Exception|panic)/.test(line)) ?? lines[0] ?? "";
      const headMatch = /^([\w.$]+(?:Error|Exception)|panic)[:\s]\s*(.*)$/.exec(headline);
      const frames = lines.filter((line) => /^at |^File "|\.go:\d+|\.java:\d+/.test(line));
      const appFrame = frames.find((line) => !/node_modules|site-packages|internal\/|<anonymous>|java\.base|runtime\//.test(line)) ?? frames[0] ?? "";
      const message = headMatch?.[2] ?? headline;
      const hint = /undefined|null|NoneType|nil pointer/i.test(message)
        ? "A value was null/undefined where an object was expected: check the input or the lookup before this frame."
        : /timeout|ETIMEDOUT|deadline/i.test(message)
          ? "A network call or lock timed out: check upstream latency and retry policy."
          : /ECONNREFUSED|connection refused/i.test(message)
            ? "The target service is not reachable: check host, port and that it is running."
            : /permission|EACCES|forbidden|401|403/i.test(message)
              ? "Permission or auth failure: check credentials and file or API permissions."
              : "Start from the top in-app frame and inspect the inputs it received.";
      return {
        errorType: clip(headMatch?.[1] ?? "Error", 100),
        message: clip(message, 500),
        language,
        topFrame: clip(appFrame, 300),
        frames: frames.length,
        hint,
      };
    },
  },
  {
    name: "User-agent parser",
    slug: "ua_parse",
    category: "code",
    description:
      "Parse a browser User-Agent string into browser name and version, operating system, device type (desktop, mobile, " +
      "tablet, bot) and bot detection. Analytics, fraud signals and support diagnostics.",
    tags: ["user-agent", "analytics", "bots", "parse", "web"],
    priceUsdc: "0.005",
    p95Ms: 150,
    p50Ms: 30,
    input: { userAgent: s.str(1000, 1) },
    required: ["userAgent"],
    example: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" },
    output: s.obj({ browser: s.str(32), version: s.str(32), os: s.str(32), device: s.enm(["desktop", "mobile", "tablet", "bot", "unknown"]), isBot: s.bool() }),
    run(input) {
      const ua = text(input, "userAgent");
      const isBot = /bot|crawler|spider|curl|wget|python-requests|httpclient|headless|axios|node-fetch/i.test(ua);
      const browsers: [string, RegExp][] = [
        ["Edge", /Edg(?:e|A|iOS)?\/([\d.]+)/],
        ["Opera", /OPR\/([\d.]+)/],
        ["Samsung Internet", /SamsungBrowser\/([\d.]+)/],
        ["Chrome", /(?:Chrome|CriOS)\/([\d.]+)/],
        ["Firefox", /(?:Firefox|FxiOS)\/([\d.]+)/],
        ["Safari", /Version\/([\d.]+).*Safari/],
        ["curl", /curl\/([\d.]+)/],
      ];
      const found = browsers.map(([name, pattern]) => ({ name, match: pattern.exec(ua) })).find((entry) => entry.match);
      const os = /Windows NT/.test(ua) ? "Windows" : /iPhone|iPad|iOS/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "unknown";
      const device = isBot ? "bot" : /iPad|Tablet/.test(ua) ? "tablet" : /Mobile|iPhone|Android/.test(ua) ? "mobile" : /Windows|Macintosh|Linux|CrOS/.test(ua) ? "desktop" : "unknown";
      return { browser: found?.name ?? "unknown", version: clip(found?.match?.[1] ?? "", 32), os, device, isBot };
    },
  },
  {
    name: "License policy checker",
    slug: "license_check",
    category: "code",
    description:
      "Check open-source dependency licenses against a policy: permissive (MIT, Apache-2.0, BSD, ISC) allowed, weak copyleft " +
      "(LGPL, MPL) flagged for review, strong copyleft (GPL, AGPL, SSPL) blocked. Software composition analysis for audits " +
      "and due diligence.",
    tags: ["licenses", "open-source", "compliance", "dependencies", "code"],
    priceUsdc: "0.01",
    p95Ms: 200,
    p50Ms: 40,
    input: { packages: s.arr(s.obj({ name: s.str(214, 1), license: s.str(100) }), 5000, 1) },
    required: ["packages"],
    example: { packages: [{ name: "hono", license: "MIT" }, { name: "some-gpl-lib", license: "GPL-3.0" }, { name: "pdf-kit", license: "MPL-2.0" }, { name: "mystery", license: "" }] },
    output: s.obj({
      allowed: s.int(0),
      review: s.int(0),
      blocked: s.int(0),
      packages: s.arr(s.obj({ name: s.str(214), license: s.str(100), verdict: s.enm(["allowed", "review", "blocked"]) }), 5000),
    }),
    run(input) {
      const list = records(input, "packages", 5000).map((entry: Json) => {
        const name = clip(typeof entry.name === "string" ? entry.name : "unknown", 214);
        const license = clip(typeof entry.license === "string" ? entry.license : "", 100);
        const verdict: "allowed" | "review" | "blocked" = /AGPL|SSPL|\bGPL|EUPL|OSL/i.test(license) && !/LGPL/i.test(license)
          ? "blocked"
          : /^(MIT|ISC|BSD|Apache|0BSD|Unlicense|CC0|Zlib|BlueOak|Python-2)/i.test(license.trim())
            ? "allowed"
            : "review";
        return { name, license, verdict };
      });
      return {
        allowed: list.filter((entry) => entry.verdict === "allowed").length,
        review: list.filter((entry) => entry.verdict === "review").length,
        blocked: list.filter((entry) => entry.verdict === "blocked").length,
        packages: list,
      };
    },
  },
];

interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified" | "renamed";
}

function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
    if (header) {
      current = { path: clip(header[2] ?? "", 300), additions: 0, deletions: 0, status: header[1] === header[2] ? "modified" : "renamed" };
      files.push(current);
      continue;
    }
    if (!current && /^(\+\+\+|---) /.test(line)) {
      current = { path: "", additions: 0, deletions: 0, status: "modified" };
      files.push(current);
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "deleted";
    else if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//, "");
      if (path !== "/dev/null" && !current.path) current.path = clip(path, 300);
    } else if (line.startsWith("--- ")) {
      if (line.includes("/dev/null")) current.status = "added";
    } else if (line.startsWith("+")) current.additions += 1;
    else if (line.startsWith("-")) current.deletions += 1;
  }
  return files.map((file) => ({ ...file, path: file.path || "unknown" }));
}

function pascal(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `T${cleaned}`;
}

function tsType(name: string, value: unknown, declarations: string[], depth: number): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "unknown[]";
    const types = [...new Set(value.slice(0, 20).map((item) => tsType(name.replace(/s$/, ""), item, declarations, depth + 1)))];
    return types.length === 1 ? `${types[0] ?? "unknown"}[]` : `(${types.join(" | ")})[]`;
  }
  if (isRecord(value)) {
    if (depth > 6) return "Record<string, unknown>";
    const interfaceName = pascal(name);
    buildInterface(interfaceName, value, declarations, depth + 1);
    return interfaceName;
  }
  return typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string";
}

function buildInterface(name: string, value: Json, declarations: string[], depth: number): void {
  if (declarations.length >= 50 || declarations.some((entry) => entry.startsWith(`export interface ${name} `))) return;
  const fields = Object.entries(value)
    .slice(0, 100)
    .map(([key, child]) => {
      const safeKey = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
      return `  ${safeKey}${child === null ? "?" : ""}: ${tsType(key, child, declarations, depth)};`;
    });
  declarations.unshift(`export interface ${name} {\n${fields.join("\n")}\n}`);
}
