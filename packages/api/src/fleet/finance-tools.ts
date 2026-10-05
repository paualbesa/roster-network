import { clip, int, money, num, oneOf, parseAmount, records, round, s, text, type FleetTool } from "./kit.js";

const EU_VAT: Record<string, { standard: number; reduced: number; name: string }> = {
  AT: { standard: 20, reduced: 10, name: "Austria" }, BE: { standard: 21, reduced: 6, name: "Belgium" },
  BG: { standard: 20, reduced: 9, name: "Bulgaria" }, HR: { standard: 25, reduced: 5, name: "Croatia" },
  CY: { standard: 19, reduced: 5, name: "Cyprus" }, CZ: { standard: 21, reduced: 12, name: "Czechia" },
  DK: { standard: 25, reduced: 25, name: "Denmark" }, EE: { standard: 22, reduced: 9, name: "Estonia" },
  FI: { standard: 25.5, reduced: 10, name: "Finland" }, FR: { standard: 20, reduced: 5.5, name: "France" },
  DE: { standard: 19, reduced: 7, name: "Germany" }, GR: { standard: 24, reduced: 6, name: "Greece" },
  HU: { standard: 27, reduced: 5, name: "Hungary" }, IE: { standard: 23, reduced: 9, name: "Ireland" },
  IT: { standard: 22, reduced: 10, name: "Italy" }, LV: { standard: 21, reduced: 12, name: "Latvia" },
  LT: { standard: 21, reduced: 9, name: "Lithuania" }, LU: { standard: 17, reduced: 8, name: "Luxembourg" },
  MT: { standard: 18, reduced: 5, name: "Malta" }, NL: { standard: 21, reduced: 9, name: "Netherlands" },
  PL: { standard: 23, reduced: 8, name: "Poland" }, PT: { standard: 23, reduced: 6, name: "Portugal" },
  RO: { standard: 19, reduced: 9, name: "Romania" }, SK: { standard: 23, reduced: 10, name: "Slovakia" },
  SI: { standard: 22, reduced: 9.5, name: "Slovenia" }, ES: { standard: 21, reduced: 10, name: "Spain" },
  SE: { standard: 25, reduced: 12, name: "Sweden" },
};

const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FR: 27, GB: 22, GR: 27,
  HR: 21, HU: 28, IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18, NO: 15, PL: 28, PT: 25,
  RO: 24, SE: 24, SI: 19, SK: 24, SM: 27,
};

const CATEGORY_RULES: [string, RegExp][] = [
  ["software", /aws|amazon web|google cloud|gcp|azure|github|vercel|supabase|openai|anthropic|notion|slack|figma|atlassian|saas|subscription/i],
  ["travel", /uber|lyft|cabify|renfe|ryanair|vueling|iberia|airbnb|booking\.com|hotel|airline|taxi|train/i],
  ["meals", /restaurant|cafe|café|coffee|starbucks|glovo|deliveroo|just eat|uber eats|bar |pizza|burger/i],
  ["groceries", /mercadona|carrefour|lidl|aldi|supermarket|grocery|condis|bonpreu/i],
  ["utilities", /electric|endesa|iberdrola|naturgy|water|gas|internet|movistar|vodafone|orange|telefon/i],
  ["payroll", /salary|payroll|nomina|nómina|wage/i],
  ["taxes", /tax|hacienda|aeat|irs|vat|iva|seguridad social/i],
  ["fees", /fee|commission|comisión|interest|charge/i],
  ["office", /office|staples|ikea|amazon\.|stationery|coworking|rent/i],
  ["marketing", /facebook ads|meta ads|google ads|linkedin|mailchimp|advertising|ads/i],
  ["income", /refund|transfer from|payment received|invoice paid|stripe payout|deposit/i],
];

export const financeTools: FleetTool[] = [
  {
    name: "Bank transaction categorizer",
    slug: "txn_categorize",
    category: "finance",
    description:
      "Categorize bank or card transactions (software, travel, meals, groceries, utilities, payroll, taxes, fees, " +
      "marketing, income) from merchant descriptions, and total spend per category. Bookkeeping, expense analytics, " +
      "budgeting apps and accounting exports.",
    tags: ["banking", "categorize", "expenses", "bookkeeping", "finance"],
    priceUsdc: "0.02",
    p95Ms: 300,
    p50Ms: 80,
    input: {
      transactions: s.arr(s.obj({ description: s.str(300, 1), amount: s.num() }, ["description", "amount"]), 2000, 1),
    },
    required: ["transactions"],
    example: {
      transactions: [
        { description: "AWS EMEA invoice", amount: -84.12 },
        { description: "Glovo order Barcelona", amount: -23.5 },
        { description: "Stripe payout", amount: 1200 },
      ],
    },
    output: s.obj({
      transactions: s.arr(s.obj({ description: s.str(300), amount: s.num(), category: s.str(24) }), 2000),
      totals: s.arr(s.obj({ category: s.str(24), total: s.num(), count: s.int(1) }), 20),
    }),
    run(input) {
      const list = records(input, "transactions", 2000).map((entry) => {
        const description = clip(typeof entry.description === "string" ? entry.description : "", 300);
        const amount = round(num(entry, "amount", 0), 2);
        const category = CATEGORY_RULES.find(([, pattern]) => pattern.test(description))?.[0] ?? (amount > 0 ? "income" : "other");
        return { description, amount, category };
      });
      const totals = new Map<string, { total: number; count: number }>();
      for (const entry of list) {
        const current = totals.get(entry.category) ?? { total: 0, count: 0 };
        totals.set(entry.category, { total: current.total + entry.amount, count: current.count + 1 });
      }
      return {
        transactions: list,
        totals: [...totals.entries()]
          .map(([category, value]) => ({ category, total: round(value.total, 2), count: value.count }))
          .sort((left, right) => left.total - right.total),
      };
    },
  },
  {
    name: "EU VAT calculator",
    slug: "vat_calc",
    category: "finance",
    description:
      "Calculate VAT for any EU country: net to gross or gross to net, standard or reduced rate, with the tax amount " +
      "broken out. Pricing pages, invoicing, e-commerce checkout and cross-border sales (rates table built in).",
    tags: ["vat", "tax", "eu", "invoicing", "pricing", "finance"],
    priceUsdc: "0.005",
    p95Ms: 150,
    p50Ms: 30,
    input: { amount: s.num(0), country: s.str(2, 2), rate: s.enm(["standard", "reduced"]), mode: s.enm(["net_to_gross", "gross_to_net"]) },
    required: ["amount", "country"],
    example: { amount: 100, country: "ES", rate: "standard", mode: "net_to_gross" },
    output: s.obj({ net: s.str(32), vat: s.str(32), gross: s.str(32), ratePercent: s.num(0, 100), country: s.str(64), supported: s.bool() }),
    run(input) {
      const amount = Math.max(0, num(input, "amount", 0));
      const code = text(input, "country").trim().toUpperCase().replace("GR", "GR").slice(0, 2);
      const entry = EU_VAT[code === "EL" ? "GR" : code];
      if (!entry) return { net: money(amount), vat: "0.00", gross: money(amount), ratePercent: 0, country: code, supported: false };
      const ratePercent = oneOf(input, "rate", ["standard", "reduced"] as const, "standard") === "standard" ? entry.standard : entry.reduced;
      const mode = oneOf(input, "mode", ["net_to_gross", "gross_to_net"] as const, "net_to_gross");
      const net = mode === "net_to_gross" ? amount : amount / (1 + ratePercent / 100);
      const vat = net * (ratePercent / 100);
      return { net: money(net), vat: money(vat), gross: money(net + vat), ratePercent, country: entry.name, supported: true };
    },
  },
  {
    name: "IBAN validator",
    slug: "iban_validate",
    category: "finance",
    description:
      "Validate an IBAN bank account number: country length, format and the ISO 13616 mod-97 checksum, and return the " +
      "formatted IBAN and bank code. Prevents failed SEPA transfers and payout errors during supplier onboarding.",
    tags: ["iban", "banking", "validation", "sepa", "payments"],
    priceUsdc: "0.005",
    p95Ms: 150,
    p50Ms: 30,
    input: { iban: s.str(64, 1) },
    required: ["iban"],
    example: { iban: "ES91 2100 0418 4502 0005 1332" },
    output: s.obj({ valid: s.bool(), country: s.str(2), formatted: s.str(64), bankCode: s.str(16), reason: s.str(100) }),
    run(input) {
      const compact = text(input, "iban").replace(/[\s-]/g, "").toUpperCase().slice(0, 40);
      const country = compact.slice(0, 2);
      const formatted = clip(compact.replace(/(.{4})/g, "$1 ").trim(), 64);
      const fail = (reason: string) => ({ valid: false, country: /^[A-Z]{2}$/.test(country) ? country : "", formatted, bankCode: "", reason });
      if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(compact)) return fail("Invalid characters or format.");
      const expected = IBAN_LENGTHS[country];
      if (expected !== undefined && compact.length !== expected) return fail(`Expected ${expected.toString()} characters for ${country}.`);
      const rearranged = `${compact.slice(4)}${compact.slice(0, 4)}`.replace(/[A-Z]/g, (char) => (char.charCodeAt(0) - 55).toString());
      let remainder = 0;
      for (const digit of rearranged) remainder = (remainder * 10 + Number(digit)) % 97;
      if (remainder !== 1) return fail("Checksum (mod 97) does not match.");
      return { valid: true, country, formatted, bankCode: compact.slice(4, 8), reason: "" };
    },
  },
  {
    name: "Card number validator",
    slug: "luhn_validate",
    category: "finance",
    description:
      "Check a payment card number with the Luhn checksum and detect the brand (Visa, Mastercard, Amex, Discover, JCB, " +
      "Diners). Form validation and test-data checks only: numbers are not stored and the result is masked.",
    tags: ["cards", "luhn", "validation", "payments", "checkout"],
    priceUsdc: "0.005",
    p95Ms: 150,
    p50Ms: 30,
    input: { number: s.str(32, 1) },
    required: ["number"],
    example: { number: "4242 4242 4242 4242" },
    output: s.obj({ valid: s.bool(), brand: s.str(16), masked: s.str(32), length: s.int(0, 32) }),
    run(input) {
      const digits = text(input, "number").replace(/\D/g, "").slice(0, 19);
      let sum = 0;
      for (let index = 0; index < digits.length; index += 1) {
        let digit = Number(digits[digits.length - 1 - index]);
        if (index % 2 === 1) {
          digit *= 2;
          if (digit > 9) digit -= 9;
        }
        sum += digit;
      }
      const brand = /^4/.test(digits)
        ? "visa"
        : /^(5[1-5]|2[2-7])/.test(digits)
          ? "mastercard"
          : /^3[47]/.test(digits)
            ? "amex"
            : /^6(?:011|5)/.test(digits)
              ? "discover"
              : /^35/.test(digits)
                ? "jcb"
                : /^3(?:0[0-5]|[68])/.test(digits)
                  ? "diners"
                  : "unknown";
      const masked = digits.length >= 4 ? `${"•".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}` : "";
      return { valid: digits.length >= 12 && sum % 10 === 0, brand, masked, length: digits.length };
    },
  },
  {
    name: "Loan amortization calculator",
    slug: "loan_amortize",
    category: "finance",
    description:
      "Compute the monthly payment, total interest and an amortization schedule for a fixed-rate loan or mortgage. " +
      "Financial planning, lending calculators, equipment financing and runway models.",
    tags: ["loan", "mortgage", "amortization", "interest", "finance"],
    priceUsdc: "0.008",
    p95Ms: 200,
    p50Ms: 40,
    input: { principal: s.num(0), annualRatePercent: s.num(0, 100), months: s.int(1, 600), scheduleRows: s.int(0, 24) },
    required: ["principal", "annualRatePercent", "months"],
    example: { principal: 25000, annualRatePercent: 5.5, months: 48, scheduleRows: 3 },
    output: s.obj({
      monthlyPayment: s.str(32),
      totalInterest: s.str(32),
      totalPaid: s.str(32),
      schedule: s.arr(s.obj({ month: s.int(1), interest: s.str(32), principal: s.str(32), balance: s.str(32) }), 24),
    }),
    run(input) {
      const principal = Math.max(0, num(input, "principal", 0));
      const rate = Math.min(100, Math.max(0, num(input, "annualRatePercent", 0))) / 100 / 12;
      const months = int(input, "months", 12, 1, 600);
      const payment = rate === 0 ? principal / months : (principal * rate) / (1 - (1 + rate) ** -months);
      const rows = int(input, "scheduleRows", 12, 0, 24);
      const schedule: { month: number; interest: string; principal: string; balance: string }[] = [];
      let balance = principal;
      for (let month = 1; month <= Math.min(rows, months); month += 1) {
        const interest = balance * rate;
        const paid = payment - interest;
        balance = Math.max(0, balance - paid);
        schedule.push({ month, interest: money(interest), principal: money(paid), balance: money(balance) });
      }
      return {
        monthlyPayment: money(payment),
        totalInterest: money(payment * months - principal),
        totalPaid: money(payment * months),
        schedule,
      };
    },
  },
  {
    name: "Expense report summarizer",
    slug: "expense_summary",
    category: "finance",
    description:
      "Summarize an expense report: totals by category and by person, policy flags for items over a limit or missing " +
      "receipts, and the grand total. Finance approvals, reimbursement and travel expense audits.",
    tags: ["expenses", "reimbursement", "audit", "policy", "finance"],
    priceUsdc: "0.02",
    p95Ms: 300,
    p50Ms: 80,
    input: {
      expenses: s.arr(
        s.obj({ person: s.str(64), category: s.str(32), amount: s.num(0), hasReceipt: s.bool() }, ["category", "amount"]),
        2000,
        1,
      ),
      limitPerItem: s.num(0),
    },
    required: ["expenses"],
    example: {
      expenses: [
        { person: "Anna", category: "travel", amount: 240, hasReceipt: true },
        { person: "Anna", category: "meals", amount: 95, hasReceipt: false },
        { person: "Joan", category: "travel", amount: 610, hasReceipt: true },
      ],
      limitPerItem: 500,
    },
    output: s.obj({
      total: s.str(32),
      byCategory: s.arr(s.obj({ name: s.str(64), total: s.str(32) }), 50),
      byPerson: s.arr(s.obj({ name: s.str(64), total: s.str(32) }), 200),
      flags: s.arr(s.obj({ index: s.int(0), reason: s.str(100) }), 200),
    }),
    run(input) {
      const list = records(input, "expenses", 2000);
      const limit = num(input, "limitPerItem", 0);
      const byCategory = new Map<string, number>();
      const byPerson = new Map<string, number>();
      const flags: { index: number; reason: string }[] = [];
      let total = 0;
      list.forEach((entry, index) => {
        const amount = Math.max(0, num(entry, "amount", 0));
        const category = clip(typeof entry.category === "string" && entry.category ? entry.category : "other", 64);
        const person = clip(typeof entry.person === "string" && entry.person ? entry.person : "unassigned", 64);
        total += amount;
        byCategory.set(category, (byCategory.get(category) ?? 0) + amount);
        byPerson.set(person, (byPerson.get(person) ?? 0) + amount);
        if (limit > 0 && amount > limit && flags.length < 200) flags.push({ index, reason: `Over the ${money(limit)} per-item limit.` });
        if (entry.hasReceipt === false && flags.length < 200) flags.push({ index, reason: "Missing receipt." });
      });
      const sorted = (map: Map<string, number>, max: number) =>
        [...map.entries()].sort((left, right) => right[1] - left[1]).slice(0, max).map(([name, value]) => ({ name, total: money(value) }));
      return { total: money(total), byCategory: sorted(byCategory, 50), byPerson: sorted(byPerson, 200), flags };
    },
  },
  {
    name: "Currency amount normalizer",
    slug: "amount_normalize",
    category: "finance",
    description:
      "Normalize messy money strings (\"1.234,56 €\", \"$1,234.56\", \"USD 12\", \"12,5 EUR\") into a decimal amount and ISO " +
      "currency code. Cleans scraped prices, OCR output, spreadsheets and multi-locale order data.",
    tags: ["currency", "money", "normalize", "parse", "finance"],
    priceUsdc: "0.005",
    p95Ms: 150,
    p50Ms: 30,
    input: { amounts: s.arr(s.str(64), 1000, 1) },
    required: ["amounts"],
    example: { amounts: ["1.234,56 €", "$1,234.56", "USD 12", "12,5 EUR", "£7"] },
    output: s.obj({ results: s.arr(s.obj({ raw: s.str(64), amount: s.str(32), currency: s.str(3), valid: s.bool() }), 1000) }),
    run(input) {
      const raw = Array.isArray(input.amounts) ? input.amounts.filter((entry): entry is string => typeof entry === "string").slice(0, 1000) : [];
      const symbols: Record<string, string> = { "€": "EUR", $: "USD", "£": "GBP", "¥": "JPY", "₹": "INR", "₿": "BTC" };
      return {
        results: raw.map((entry) => {
          const value = parseAmount(entry.slice(0, 64));
          const code = /\b([A-Z]{3})\b/.exec(entry)?.[1] ?? symbols[/[€$£¥₹₿]/.exec(entry)?.[0] ?? ""] ?? "";
          return { raw: clip(entry, 64), amount: value === null ? "" : value.toFixed(2), currency: code.slice(0, 3), valid: value !== null };
        }),
      };
    },
  },
];
