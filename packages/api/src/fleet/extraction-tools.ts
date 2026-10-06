import { clip, money, parseAmount, s, text, type FleetTool } from "./kit.js";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const SAMPLE_INVOICE = [
  "ACME Cloud Services S.L.",
  "Invoice No: INV-2026-0042",
  "Date: 2026-09-30",
  "Due date: 2026-10-30",
  "Bill to: Harbor Robotics",
  "GPU hours x10 ... 120.00",
  "Storage 1TB ... 25.50",
  "Subtotal: 145.50",
  "VAT 21%: 30.56",
  "Total: 176.06 EUR",
].join("\n");

export const extractionTools: FleetTool[] = [
  {
    name: "PII redactor",
    slug: "pii_redact",
    category: "extraction",
    description:
      "Redact personal data (PII) from text before it is logged, shared or sent to an LLM: email addresses, phone numbers, " +
      "IBANs, credit card numbers, IP addresses and national ID patterns. GDPR-friendly data minimization step.",
    tags: ["pii", "privacy", "gdpr", "redaction", "compliance"],
    priceUsdc: "0.01",
    p95Ms: 300,
    p50Ms: 60,
    input: { text: s.str(20_000, 1) },
    required: ["text"],
    example: { text: "Contact jane.doe@example.com or +34 612 345 678. IBAN ES91 2100 0418 4502 0005 1332." },
    output: s.obj({
      text: s.str(20_000),
      redactions: s.arr(s.obj({ type: s.str(16), count: s.int(1) }), 8),
      total: s.int(0),
    }),
    run(input) {
      let output = text(input, "text");
      const patterns: [string, RegExp][] = [
        ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
        ["iban", /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g],
        ["card", /\b(?:\d[ -]?){13,19}\b/g],
        ["ip", /\b(?:\d{1,3}\.){3}\d{1,3}\b/g],
        ["phone", /(?:\+\d{1,3}[ .-]?)?(?:\(?\d{2,4}\)?[ .-]?){2,4}\d{2,4}\b/g],
        ["national_id", /\b\d{8}[A-HJ-NP-TV-Z]\b|\b\d{3}-\d{2}-\d{4}\b/g],
      ];
      const redactions: { type: string; count: number }[] = [];
      for (const [type, pattern] of patterns) {
        let count = 0;
        output = output.replace(pattern, (match) => {
          if (type === "phone" && match.replace(/\D/g, "").length < 7) return match;
          count += 1;
          return `[${type.toUpperCase()}]`;
        });
        if (count > 0) redactions.push({ type, count });
      }
      return { text: clip(output, 20_000), redactions, total: redactions.reduce((sum, entry) => sum + entry.count, 0) };
    },
  },
  {
    name: "Email address extractor",
    slug: "email_extract",
    category: "extraction",
    description:
      "Find and deduplicate every email address in text, HTML or a document dump, with domains. Lead list building, " +
      "contact discovery and CRM import cleanup.",
    tags: ["email", "extract", "contacts", "leads"],
    priceUsdc: "0.005",
    p95Ms: 200,
    p50Ms: 40,
    input: { text: s.str(20_000, 1) },
    required: ["text"],
    example: { text: "Sales: sales@acme.io, support: Help@Acme.io; cc ops@harbor.dev" },
    output: s.obj({ emails: s.arr(s.obj({ email: s.str(254), domain: s.str(253) }), 200), total: s.int(0) }),
    run(input) {
      const found = text(input, "text").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
      const unique = [...new Set(found.map((email) => email.toLowerCase()))].slice(0, 200);
      return {
        emails: unique.map((email) => ({ email: clip(email, 254), domain: clip(email.split("@")[1] ?? "", 253) })),
        total: unique.length,
      };
    },
  },
  {
    name: "URL extractor",
    slug: "url_extract",
    category: "extraction",
    description:
      "Extract all links (http and https URLs) from text, markdown or HTML, deduplicated, with host names. For link audits, " +
      "crawl seeds, citation lists and phishing triage.",
    tags: ["urls", "links", "extract", "crawl"],
    priceUsdc: "0.005",
    p95Ms: 200,
    p50Ms: 40,
    input: { text: s.str(20_000, 1) },
    required: ["text"],
    example: { text: "Docs at https://roster.network/docs and the repo (https://github.com/paualbesa/roster-network)." },
    output: s.obj({ urls: s.arr(s.obj({ url: s.str(2048), host: s.str(253) }), 200), total: s.int(0) }),
    run(input) {
      const found = text(input, "text").match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
      const unique = [...new Set(found.map((url) => url.replace(/[.,;:!?]+$/, "")))].slice(0, 200);
      return {
        urls: unique.map((url) => {
          let host = "";
          try {
            host = new URL(url).host;
          } catch {
            host = "";
          }
          return { url: clip(url, 2048), host: clip(host, 253) };
        }),
        total: unique.length,
      };
    },
  },
  {
    name: "Phone number extractor",
    slug: "phone_extract",
    category: "extraction",
    description:
      "Find phone numbers in free text and normalize them to digits with an international prefix when present. Contact " +
      "enrichment, CRM cleanup and call-center routing.",
    tags: ["phone", "extract", "contacts", "normalize"],
    priceUsdc: "0.005",
    p95Ms: 200,
    p50Ms: 40,
    input: { text: s.str(20_000, 1), defaultCountryCode: s.str(4) },
    required: ["text"],
    example: { text: "Call +34 612 345 678 or (415) 555-0134 after 9am.", defaultCountryCode: "1" },
    output: s.obj({ phones: s.arr(s.obj({ raw: s.str(40), normalized: s.str(20) }), 100), total: s.int(0) }),
    run(input) {
      const country = text(input, "defaultCountryCode").replace(/\D/g, "").slice(0, 3);
      const found = text(input, "text").match(/(?:\+\d{1,3}[ .-]?)?(?:\(?\d{2,4}\)?[ .-]?){2,4}\d{2,4}/g) ?? [];
      const phones: { raw: string; normalized: string }[] = [];
      const seen = new Set<string>();
      for (const raw of found) {
        const digits = raw.replace(/\D/g, "");
        if (digits.length < 7 || digits.length > 15) continue;
        const normalized = raw.trim().startsWith("+") ? `+${digits}` : country ? `+${country}${digits}` : digits;
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        phones.push({ raw: clip(raw.trim(), 40), normalized: clip(normalized, 20) });
        if (phones.length >= 100) break;
      }
      return { phones, total: phones.length };
    },
  },
  {
    name: "Date extractor",
    slug: "date_extract",
    category: "extraction",
    description:
      "Detect dates in text (ISO 2026-10-05, 05/10/2026, October 5, 2026, 5 Oct 2026) and normalize them to ISO-8601. For " +
      "deadline tracking, contract dates, event parsing and timeline building.",
    tags: ["dates", "extract", "normalize", "calendar"],
    priceUsdc: "0.008",
    p95Ms: 200,
    p50Ms: 50,
    input: { text: s.str(20_000, 1), dayFirst: s.bool() },
    required: ["text"],
    example: { text: "Signed on 2026-09-30, renewal due 31/12/2026, kickoff October 5, 2026.", dayFirst: true },
    output: s.obj({ dates: s.arr(s.obj({ raw: s.str(40), iso: s.str(10) }), 100), total: s.int(0) }),
    run(input) {
      const source = text(input, "text");
      const dayFirst = input.dayFirst !== false;
      const dates: { raw: string; iso: string }[] = [];
      const push = (raw: string, year: number, month: number, day: number) => {
        if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1000 || year > 9999) return;
        const iso = `${year.toString()}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
        if (dates.length < 100) dates.push({ raw: clip(raw, 40), iso });
      };
      for (const match of source.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
        push(match[0], Number(match[1]), Number(match[2]), Number(match[3]));
      }
      for (const match of source.matchAll(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/g)) {
        const first = Number(match[1]);
        const second = Number(match[2]);
        if (dayFirst) push(match[0], Number(match[3]), second, first);
        else push(match[0], Number(match[3]), first, second);
      }
      const monthPattern = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
      for (const match of source.matchAll(new RegExp(`\\b${monthPattern}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"))) {
        const month = MONTHS.findIndex((name) => name.startsWith((match[1] ?? "").toLowerCase().slice(0, 3))) + 1;
        push(match[0], Number(match[3]), month, Number(match[2]));
      }
      for (const match of source.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${monthPattern}\\.?,?\\s+(\\d{4})\\b`, "gi"))) {
        const month = MONTHS.findIndex((name) => name.startsWith((match[2] ?? "").toLowerCase().slice(0, 3))) + 1;
        push(match[0], Number(match[3]), month, Number(match[1]));
      }
      return { dates, total: dates.length };
    },
  },
  {
    name: "Hashtag and mention extractor",
    slug: "social_extract",
    category: "extraction",
    description:
      "Extract #hashtags, @mentions and cashtags ($TICKER) from social media posts, tweets and comments with counts. Social " +
      "listening, influencer tracking and campaign analytics.",
    tags: ["social", "hashtags", "mentions", "extract", "marketing"],
    priceUsdc: "0.005",
    p95Ms: 150,
    p50Ms: 30,
    input: { text: s.str(20_000, 1) },
    required: ["text"],
    example: { text: "Loving the new #AI agents from @roster! #agents #USDC $SOL" },
    output: s.obj({
      hashtags: s.arr(s.obj({ tag: s.str(100), count: s.int(1) }), 100),
      mentions: s.arr(s.obj({ handle: s.str(100), count: s.int(1) }), 100),
      cashtags: s.arr(s.str(16), 50),
    }),
    run(input) {
      const source = text(input, "text");
      const tally = (items: string[]) => {
        const counts = new Map<string, number>();
        for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
        return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 100);
      };
      const hashtags = tally((source.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((tag) => tag.slice(1).toLowerCase()));
      const mentions = tally((source.match(/(?<![\w.])@[A-Za-z0-9_]{1,30}/g) ?? []).map((handle) => handle.slice(1).toLowerCase()));
      const cashtags = [...new Set((source.match(/\$[A-Z]{1,6}\b/g) ?? []).map((tag) => tag.slice(1)))].slice(0, 50);
      return {
        hashtags: hashtags.map(([tag, count]) => ({ tag: clip(tag, 100), count })),
        mentions: mentions.map(([handle, count]) => ({ handle: clip(handle, 100), count })),
        cashtags,
      };
    },
  },
  {
    name: "Named entity extractor",
    slug: "entity_extract",
    category: "extraction",
    description:
      "Recognize named entities in English text: people, organizations, places, money amounts and dates (NER). Rule-based " +
      "entity extraction for news monitoring, knowledge graphs, due diligence and document indexing.",
    tags: ["ner", "entities", "extract", "nlp", "knowledge-graph"],
    priceUsdc: "0.015",
    p95Ms: 300,
    p50Ms: 80,
    input: { text: s.str(20_000, 1) },
    required: ["text"],
    example: { text: "Maria Lopez joined Harbor Robotics Inc. in Barcelona on March 3, 2026 after a $2.5M seed round." },
    output: s.obj({
      entities: s.arr(
        s.obj({ text: s.str(120), type: s.enm(["person", "organization", "location", "money", "date", "other"]) }),
        100,
      ),
    }),
    run(input) {
      const source = text(input, "text");
      const entities: { text: string; type: "person" | "organization" | "location" | "money" | "date" | "other" }[] = [];
      const seen = new Set<string>();
      const add = (value: string, type: (typeof entities)[number]["type"]) => {
        const key = `${type}:${value}`;
        if (seen.has(key) || entities.length >= 100) return;
        seen.add(key);
        entities.push({ text: clip(value, 120), type });
      };
      for (const match of source.matchAll(/(?:[$€£]\s?\d[\d,.]*\s?(?:[MBK]|million|billion)?|\d[\d,.]*\s?(?:USD|EUR|USDC|GBP))/g)) add(match[0].trim(), "money");
      for (const match of source.matchAll(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2},? \d{4}\b|\b\d{4}-\d{2}-\d{2}\b/g)) add(match[0], "date");
      const orgSuffix = /\b(Inc|Corp|Corporation|Ltd|LLC|GmbH|S\.?L|S\.?A|Labs|Robotics|Technologies|Bank|University|Group|Foundation)\.?$/;
      const places = new Set(["Barcelona", "Madrid", "Paris", "London", "Berlin", "Lisbon", "Rome", "Tokyo", "Spain", "France", "Germany", "Italy", "Portugal", "Europe", "California", "New York", "San Francisco", "Catalonia", "Valencia", "Amsterdam"]);
      for (const match of source.matchAll(/\b([A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|[A-Z]{2,}|Inc\.?|Ltd\.?|LLC|S\.L\.?))*)/g)) {
        const value = (match[1] ?? "").trim();
        const index = match.index ?? 0;
        const sentenceStart = index === 0 || /[.!?]\s*$/.test(source.slice(Math.max(0, index - 3), index));
        if (!value || (sentenceStart && !value.includes(" ") && !places.has(value))) continue;
        if (/^(The|A|An|This|That|In|On|At|After|Before|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/.test(value)) continue;
        if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/.test(value) && /\d/.test(source.slice(index + value.length, index + value.length + 4))) continue;
        if (orgSuffix.test(value)) add(value, "organization");
        else if (places.has(value)) add(value, "location");
        else if (/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(value)) add(value, "person");
        else add(value, "other");
      }
      return { entities };
    },
  },
  {
    name: "Invoice parser",
    slug: "invoice_parse",
    category: "finance",
    description:
      "Parse invoice text (from OCR or a PDF-to-text step) into structured data: vendor, invoice number, issue and due " +
      "dates, line items, subtotal, tax, total and currency. Accounts-payable automation and bookkeeping import.",
    tags: ["invoice", "parse", "accounting", "extract", "ocr", "finance"],
    priceUsdc: "0.04",
    p95Ms: 600,
    p50Ms: 150,
    input: { text: s.str(20_000, 1) },
    required: ["text"],
    example: { text: SAMPLE_INVOICE },
    output: s.obj({
      vendor: s.str(200),
      invoiceNumber: s.str(64),
      issueDate: s.str(10),
      dueDate: s.str(10),
      currency: s.str(3),
      subtotal: s.str(32),
      tax: s.str(32),
      total: s.str(32),
      lineItems: s.arr(s.obj({ description: s.str(200), amount: s.str(32) }), 100),
    }),
    run(input) {
      return { ...parseInvoice(text(input, "text")) };
    },
  },
  {
    name: "Receipt line-item extractor",
    slug: "receipt_items",
    category: "finance",
    description:
      "Extract purchased items and prices from a store or restaurant receipt, plus the total and a check that items add up. " +
      "Expense management, reimbursement and spend analytics.",
    tags: ["receipt", "expenses", "extract", "line-items", "finance"],
    priceUsdc: "0.025",
    p95Ms: 500,
    p50Ms: 120,
    input: { text: s.str(20_000, 1) },
    required: ["text"],
    example: { text: "CAFE BLAU\nCappuccino 3.20\nCroissant 2.10\nOrange juice 3.50\nTOTAL 8.80" },
    output: s.obj({
      items: s.arr(s.obj({ description: s.str(200), amount: s.str(32) }), 100),
      total: s.str(32),
      itemsSum: s.str(32),
      matchesTotal: s.bool(),
    }),
    run(input) {
      const parsed = parseInvoice(text(input, "text"));
      const sum = parsed.lineItems.reduce((acc, item) => acc + (parseAmount(item.amount) ?? 0), 0);
      const total = parsed.total || money(sum);
      return {
        items: parsed.lineItems,
        total,
        itemsSum: money(sum),
        matchesTotal: Math.abs((parseAmount(total) ?? 0) - sum) < 0.01,
      };
    },
  },
  {
    name: "Postal address parser",
    slug: "address_parse",
    category: "extraction",
    description:
      "Split a one-line postal address into street, number, postal code, city, region and country. Address normalization " +
      "for shipping labels, geocoding prep, CRM deduplication and KYC forms (EU and US formats).",
    tags: ["address", "parse", "shipping", "normalize", "geocoding"],
    priceUsdc: "0.01",
    p95Ms: 200,
    p50Ms: 50,
    input: { address: s.str(500, 1) },
    required: ["address"],
    example: { address: "Carrer de Mallorca 401, 08013 Barcelona, Spain" },
    output: s.obj({
      street: s.str(200),
      number: s.str(16),
      postalCode: s.str(16),
      city: s.str(100),
      region: s.str(100),
      country: s.str(100),
    }),
    run(input) {
      const raw = text(input, "address").replace(/\s+/g, " ").trim();
      const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
      const result = { street: "", number: "", postalCode: "", city: "", region: "", country: "" };
      const countries = ["spain", "españa", "france", "germany", "italy", "portugal", "usa", "united states", "uk", "united kingdom", "netherlands", "andorra"];
      if (parts.length > 1 && countries.includes((parts[parts.length - 1] ?? "").toLowerCase())) result.country = clip(parts.pop() ?? "", 100);
      const first = parts.shift() ?? "";
      const streetMatch = /^(\d+[A-Za-z]?)\s+(.+)$/.exec(first) ?? /^(.+?)\s+(\d+[A-Za-z]?(?:-\d+)?)$/.exec(first);
      if (streetMatch) {
        const numberFirst = /^\d/.test(first);
        result.number = clip((numberFirst ? streetMatch[1] : streetMatch[2]) ?? "", 16);
        result.street = clip((numberFirst ? streetMatch[2] : streetMatch[1]) ?? "", 200);
      } else result.street = clip(first, 200);
      for (const part of parts) {
        const us = /^([A-Za-z .]+)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/.exec(part);
        const eu = /^(\d{4,5}|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})\s+(.+)$/.exec(part);
        if (us) {
          result.city = clip(us[1]?.trim() ?? "", 100);
          result.region = us[2] ?? "";
          result.postalCode = us[3] ?? "";
        } else if (eu) {
          result.postalCode = clip(eu[1] ?? "", 16);
          result.city = clip(eu[2] ?? "", 100);
        } else if (/^[A-Z]{2}$/.test(part)) result.region = part;
        else if (!result.city) result.city = clip(part, 100);
        else result.region = clip(part, 100);
      }
      return result;
    },
  },
  {
    name: "Person name parser",
    slug: "name_parse",
    category: "extraction",
    description:
      "Split a full name into title, first, middle and last name and suffix, including \"Last, First\" order and Spanish " +
      "double surnames. Clean CRM imports, personalize emails, deduplicate contacts.",
    tags: ["names", "parse", "crm", "contacts", "normalize"],
    priceUsdc: "0.005",
    p95Ms: 150,
    p50Ms: 30,
    input: { name: s.str(200, 1) },
    required: ["name"],
    example: { name: "Dr. Pau Albesa Vives" },
    output: s.obj({ title: s.str(16), first: s.str(64), middle: s.str(64), last: s.str(128), suffix: s.str(16) }),
    run(input) {
      let raw = text(input, "name").replace(/\s+/g, " ").trim();
      if (raw.includes(",")) {
        const [last, rest] = raw.split(",", 2);
        if (rest && !/^(jr|sr|ii|iii|iv|phd|md)\.?$/i.test(rest.trim())) raw = `${rest.trim()} ${(last ?? "").trim()}`;
      }
      const tokens = raw.split(" ").filter(Boolean);
      const titles = /^(mr|mrs|ms|miss|dr|prof|sr|sra|mx)\.?$/i;
      const suffixes = /^(jr|sr|ii|iii|iv|phd|md|esq)\.?$/i;
      const title = tokens[0] && titles.test(tokens[0]) ? (tokens.shift() ?? "") : "";
      const suffix = tokens.length > 1 && suffixes.test(tokens[tokens.length - 1] ?? "") ? (tokens.pop() ?? "") : "";
      const first = tokens.shift() ?? "";
      let middle = "";
      let last = "";
      if (tokens.length >= 2) {
        const particles = /^(de|del|la|van|von|da|di|le)$/i;
        const lastStart = tokens.findIndex((token) => particles.test(token));
        if (lastStart >= 0) {
          middle = tokens.slice(0, lastStart).join(" ");
          last = tokens.slice(lastStart).join(" ");
        } else {
          last = tokens.join(" ");
        }
      } else last = tokens.join(" ");
      return { title: clip(title, 16), first: clip(first, 64), middle: clip(middle, 64), last: clip(last, 128), suffix: clip(suffix, 16) };
    },
  },
  {
    name: "Resume skills extractor",
    slug: "resume_skills",
    category: "extraction",
    description:
      "Extract technical and professional skills, years of experience and seniority from a CV or job description. Candidate " +
      "screening, job matching, talent search and HR analytics.",
    tags: ["resume", "cv", "skills", "hr", "recruiting", "extract"],
    priceUsdc: "0.02",
    p95Ms: 300,
    p50Ms: 80,
    input: { text: s.str(20_000, 1) },
    required: ["text"],
    example: { text: "Senior backend engineer with 7 years of experience in TypeScript, Node.js, PostgreSQL and AWS. Led a team of 4." },
    output: s.obj({
      skills: s.arr(s.obj({ skill: s.str(40), category: s.str(24) }), 60),
      yearsOfExperience: s.int(0, 60),
      seniority: s.enm(["junior", "mid", "senior", "lead", "unknown"]),
    }),
    run(input) {
      const source = text(input, "text");
      const lower = source.toLowerCase();
      const catalog: Record<string, string[]> = {
        language: ["typescript", "javascript", "python", "go", "rust", "java", "kotlin", "swift", "c#", "c++", "ruby", "php", "sql", "solidity"],
        framework: ["react", "next.js", "node.js", "django", "flask", "spring", "rails", "vue", "angular", "fastapi", "express", "hono"],
        data: ["postgresql", "mysql", "mongodb", "redis", "kafka", "spark", "snowflake", "bigquery", "pandas", "dbt", "supabase"],
        cloud: ["aws", "gcp", "azure", "docker", "kubernetes", "terraform", "vercel", "cloudflare"],
        ai: ["machine learning", "llm", "pytorch", "tensorflow", "nlp", "computer vision", "rag", "langchain"],
        soft: ["leadership", "mentoring", "communication", "stakeholder", "agile", "scrum", "product management", "led a team"],
      };
      const skills: { skill: string; category: string }[] = [];
      for (const [category, list] of Object.entries(catalog)) {
        for (const skill of list) {
          const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          if (new RegExp(`(^|[^a-z])${escaped}($|[^a-z])`).test(lower)) skills.push({ skill, category });
        }
      }
      const years = Math.max(0, ...[...lower.matchAll(/(\d{1,2})\+?\s*(?:years|yrs|años|anys)/g)].map((match) => Number(match[1])));
      const seniority = /\b(lead|principal|staff|head of|director)\b/.test(lower)
        ? "lead"
        : /\bsenior\b/.test(lower) || years >= 6
          ? "senior"
          : /\b(junior|intern|graduate)\b/.test(lower)
            ? "junior"
            : years >= 2
              ? "mid"
              : "unknown";
      return { skills: skills.slice(0, 60), yearsOfExperience: Math.min(60, years), seniority };
    },
  },
  {
    name: "Contract clause finder",
    slug: "contract_clauses",
    category: "extraction",
    description:
      "Locate key clauses in a contract or terms of service: termination, liability cap, indemnification, confidentiality, " +
      "governing law, payment terms, auto-renewal and data protection. Legal review triage, not legal advice.",
    tags: ["legal", "contracts", "clauses", "compliance", "review"],
    priceUsdc: "0.05",
    p95Ms: 600,
    p50Ms: 150,
    input: { text: s.str(20_000, 1) },
    required: ["text"],
    example: {
      text: "12. Termination. Either party may terminate with 30 days notice. 13. Limitation of Liability. Liability is capped at fees paid in the prior 12 months. 14. Governing Law. This agreement is governed by the laws of Spain.",
    },
    output: s.obj({
      clauses: s.arr(s.obj({ type: s.str(32), excerpt: s.str(500) }), 20),
      missing: s.arr(s.str(32), 10),
    }),
    run(input) {
      const source = text(input, "text");
      const segments = source.split(/(?=\b\d{1,2}\.\s+[A-Z])|\n{2,}/).map((part) => part.trim()).filter(Boolean);
      const rules: [string, RegExp][] = [
        ["termination", /terminat/i],
        ["liability", /liabilit|damages/i],
        ["indemnification", /indemn/i],
        ["confidentiality", /confidential|non-disclosure/i],
        ["governing_law", /governing law|governed by|jurisdiction/i],
        ["payment_terms", /payment|invoice|net \d+|fees/i],
        ["auto_renewal", /renew/i],
        ["data_protection", /gdpr|personal data|data protection|privacy/i],
      ];
      const clauses: { type: string; excerpt: string }[] = [];
      const missing: string[] = [];
      for (const [type, pattern] of rules) {
        const segment = segments.find((part) => pattern.test(part));
        if (segment) clauses.push({ type, excerpt: clip(segment, 500) });
        else missing.push(type);
      }
      return { clauses, missing };
    },
  },
];

interface ParsedInvoice {
  vendor: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  subtotal: string;
  tax: string;
  total: string;
  lineItems: { description: string; amount: string }[];
}

function parseInvoice(source: string): ParsedInvoice {
  const lines = source.split("\n").map((line) => line.trim()).filter(Boolean);
  const find = (pattern: RegExp) => {
    for (const line of lines) {
      const match = pattern.exec(line);
      if (match?.[1]) return match[1].trim();
    }
    return "";
  };
  const amountOf = (pattern: RegExp) => {
    const raw = find(pattern);
    const value = raw ? parseAmount(raw) : null;
    return value === null ? "" : money(value);
  };
  const isoDate = (raw: string) => {
    const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    if (iso) return iso[0];
    const eu = /(\d{1,2})[/.](\d{1,2})[/.](\d{4})/.exec(raw);
    if (eu) return `${eu[3] ?? ""}-${(eu[2] ?? "").padStart(2, "0")}-${(eu[1] ?? "").padStart(2, "0")}`;
    return "";
  };
  const currencyMatch = /\b(EUR|USD|USDC|GBP|CHF|JPY)\b|([€$£])/.exec(source);
  const symbolMap: Record<string, string> = { "€": "EUR", $: "USD", "£": "GBP" };
  const currency = currencyMatch ? (currencyMatch[1] ?? symbolMap[currencyMatch[2] ?? ""] ?? "") : "";
  const summary = /^(sub-?total|total|vat|iva|tax|amount due|balance|tip|change|cash|card)\b/i;
  const meta = /^(invoice|date|due|bill|ship|factura|n[ºo°]|tel|phone|email|www|cif|nif|vat id)/i;
  const lineItems: { description: string; amount: string }[] = [];
  for (const line of lines.slice(1)) {
    if (line.length > 300) continue;
    if (summary.test(line) || meta.test(line)) continue;
    const match = /^(.*?[A-Za-z].*?)[\s.:x×-]*([€$£]?\s?\d[\d.,]*\d|\d)\s*(?:EUR|USD|€)?$/.exec(line);
    if (!match) continue;
    const value = parseAmount(match[2] ?? "");
    if (value === null) continue;
    const description = (match[1] ?? "").replace(/[.\s]+$/, "").trim();
    if (!description) continue;
    lineItems.push({ description: clip(description, 200), amount: money(value) });
    if (lineItems.length >= 100) break;
  }
  return {
    vendor: clip(lines[0] ?? "", 200),
    invoiceNumber: clip(find(/(?:invoice|factura|inv)\s*(?:no\.?|number|n[ºo°]|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-/]{2,})/i), 64),
    issueDate: isoDate(find(/^(?:date|issue date|invoice date|fecha)\s*:?\s*(.+)$/i)),
    dueDate: isoDate(find(/^(?:due date|due|payment due|vencimiento)\s*:?\s*(.+)$/i)),
    currency: currency.slice(0, 3),
    subtotal: amountOf(/^sub-?total\s*:?\s*(.+)$/i),
    tax: amountOf(/^(?:vat|iva|tax)[^:]*:?\s*([€$£]?\s?\d[\d.,]*)\s*\S*$/i),
    total: amountOf(/^(?:total|amount due|grand total)\b\s*:?\s*(.+)$/i),
    lineItems,
  };
}

