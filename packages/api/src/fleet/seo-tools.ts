import { clip, fnv, int, s, strings, text, type FleetTool } from "./kit.js";
import { sentences, slugify, titleCase, topTerms, words } from "./nlp.js";

const SPAM_WORDS = ["free", "guarantee", "winner", "urgent", "act now", "limited time", "risk-free", "cash", "100%", "click here", "buy now", "no cost", "!!!", "$$$"];

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export const seoTools: FleetTool[] = [
  {
    name: "SEO content brief",
    slug: "seo_brief",
    category: "seo",
    description:
      "Create an SEO content brief for a target keyword: search intent, title tag and meta description options, H2/H3 " +
      "outline, related terms to cover, FAQ questions, internal-link anchors and a recommended word count. Hand it to a " +
      "writer or an LLM drafting agent.",
    tags: ["seo", "content-brief", "keywords", "content-marketing", "outline"],
    priceUsdc: "0.06",
    p95Ms: 500,
    p50Ms: 120,
    input: { keyword: s.str(120, 1), audience: s.str(120), relatedTerms: s.arr(s.str(60), 20) },
    required: ["keyword"],
    example: { keyword: "ai agent marketplace", audience: "startup CTOs", relatedTerms: ["escrow", "usdc payments", "agent reputation"] },
    output: s.obj({
      keyword: s.str(120),
      intent: s.enm(["informational", "commercial", "transactional", "navigational"]),
      titles: s.arr(s.str(70), 3),
      metaDescription: s.str(160),
      slug: s.str(80),
      outline: s.arr(s.obj({ heading: s.str(120), level: s.int(2, 3) }), 20),
      relatedTerms: s.arr(s.str(60), 20),
      faqs: s.arr(s.str(160), 6),
      wordCount: s.int(300, 5000),
    }),
    run(input) {
      const keyword = text(input, "keyword").trim().toLowerCase().slice(0, 120) || "topic";
      const audience = text(input, "audience").trim().slice(0, 120);
      const related = strings(input, "relatedTerms", 20, 60);
      const title = titleCase(keyword);
      const intent = /\b(buy|price|pricing|cost|cheap|deal|order|hire)\b/.test(keyword)
        ? "transactional"
        : /\b(best|top|vs|review|compare|comparison|alternative|marketplace|tool|software)\b/.test(keyword)
          ? "commercial"
          : /\b(login|sign in|dashboard|docs)\b/.test(keyword)
            ? "navigational"
            : "informational";
      const forWhom = audience ? ` for ${audience}` : "";
      const titles = [`${title}: The Complete Guide${forWhom}`, `What Is ${title}? How It Works and Why It Matters`, `${title} in 2026: Benefits, Costs and How to Start`].map((entry) => clip(entry, 70));
      const metaDescription = clip(`Learn what ${keyword} is, how it works, what it costs and how to get started${forWhom}. Practical steps, examples and FAQs.`, 160);
      const terms = [...new Set([...related.map((term) => term.toLowerCase()), `${keyword} examples`, `how ${keyword} works`, `${keyword} pricing`, `${keyword} benefits`, `${keyword} vs alternatives`])].slice(0, 20);
      const outline = [
        { heading: `What is ${keyword}?`, level: 2 },
        { heading: `How ${keyword} works`, level: 2 },
        ...related.slice(0, 4).map((term) => ({ heading: titleCase(term), level: 3 })),
        { heading: `Benefits of ${keyword}`, level: 2 },
        { heading: `${titleCase(keyword)} pricing and costs`, level: 2 },
        { heading: `How to choose the right ${keyword}`, level: 2 },
        { heading: "Getting started step by step", level: 2 },
        { heading: "Frequently asked questions", level: 2 },
      ].map((entry) => ({ heading: clip(entry.heading, 120), level: entry.level }));
      const faqs = [`What is ${keyword}?`, `How much does ${keyword} cost?`, `Is ${keyword} secure?`, `How do I get started with ${keyword}?`, `What are the alternatives to ${keyword}?`].map((entry) => clip(entry, 160));
      const wordCount = intent === "informational" ? 1800 : intent === "commercial" ? 2200 : 1200;
      return { keyword, intent, titles, metaDescription, slug: slugify(keyword) || "topic", outline, relatedTerms: terms.map((term) => clip(term, 60)), faqs, wordCount };
    },
  },
  {
    name: "Meta description writer",
    slug: "meta_description",
    category: "seo",
    description:
      "Write a search-friendly meta description (120–160 characters) for a page from its content and target keyword, plus " +
      "an Open Graph description. Better click-through rates from Google and social shares.",
    tags: ["seo", "meta-description", "serp", "copywriting", "open-graph"],
    priceUsdc: "0.01",
    p95Ms: 250,
    p50Ms: 60,
    input: { content: s.str(20_000, 1), keyword: s.str(120) },
    required: ["content"],
    example: { content: "Roster is a marketplace where AI agents hire other agents. Payments are locked in USDC escrow and released only when the result matches the schema.", keyword: "agent marketplace" },
    output: s.obj({ metaDescription: s.str(160), ogDescription: s.str(200), length: s.int(0, 160), containsKeyword: s.bool() }),
    run(input) {
      const content = text(input, "content");
      const keyword = text(input, "keyword").trim().toLowerCase();
      const lead = sentences(content).slice(0, 2).join(" ");
      let description = lead;
      if (keyword && !description.toLowerCase().includes(keyword)) description = `${titleCase(keyword)}: ${description}`;
      if (description.length > 160) description = `${description.slice(0, 157).replace(/\s+\S*$/, "")}…`;
      if (description.length < 120 && description.length > 0) description = clip(`${description} Learn more and get started today.`, 160);
      return {
        metaDescription: clip(description, 160),
        ogDescription: clip(lead || description, 200),
        length: Math.min(160, description.length),
        containsKeyword: keyword === "" ? false : description.toLowerCase().includes(keyword),
      };
    },
  },
  {
    name: "Title tag checker",
    slug: "title_tag",
    category: "seo",
    description:
      "Check and improve an HTML title tag: length and estimated pixel width against Google truncation, keyword position, " +
      "brand placement and duplicate words, with a suggested rewrite. On-page SEO quick wins.",
    tags: ["seo", "title-tag", "on-page", "serp", "audit"],
    priceUsdc: "0.01",
    p95Ms: 150,
    p50Ms: 30,
    input: { title: s.str(300, 1), keyword: s.str(120), brand: s.str(60) },
    required: ["title"],
    example: { title: "Home | Roster - the marketplace where AI agents hire AI agents and get paid in USDC escrow", keyword: "ai agents", brand: "Roster" },
    output: s.obj({
      length: s.int(0),
      pixelWidth: s.int(0),
      truncated: s.bool(),
      warnings: s.arr(s.str(160), 10),
      suggestion: s.str(70),
    }),
    run(input) {
      const title = text(input, "title").trim().slice(0, 300);
      const keyword = text(input, "keyword").trim().toLowerCase();
      const brand = text(input, "brand").trim();
      const pixelWidth = Math.round([...title].reduce((sum, char) => sum + (/[A-Z]/.test(char) ? 11 : /[il.,'|! ]/.test(char) ? 4.5 : /[mw]/.test(char) ? 13 : 8.5), 0));
      const warnings: string[] = [];
      if (title.length < 30) warnings.push("Title is short: use 50–60 characters to describe the page.");
      if (pixelWidth > 580) warnings.push("Title will likely be truncated in Google results (over ~580px).");
      if (keyword && !title.toLowerCase().includes(keyword)) warnings.push("Target keyword is missing.");
      else if (keyword && title.toLowerCase().indexOf(keyword) > 30) warnings.push("Move the keyword closer to the start.");
      if (/^home\b/i.test(title)) warnings.push("Avoid generic words like \"Home\" at the start.");
      const tokens = words(title);
      if (new Set(tokens).size < tokens.length - 2) warnings.push("Repeated words: tighten the wording.");
      const core = title.replace(/^home\s*[|\-–]\s*/i, "").replace(new RegExp(`\\s*[|\\-–]\\s*${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"), "");
      const base = keyword && !core.toLowerCase().startsWith(keyword) ? `${titleCase(keyword)} – ${core}` : core;
      const suffix = brand ? ` | ${brand}` : "";
      const room = 60 - suffix.length;
      const trimmed = base.length > room ? base.slice(0, room).replace(/\s+\S*$/, "") : base;
      return { length: title.length, pixelWidth, truncated: pixelWidth > 580, warnings, suggestion: clip(`${trimmed}${suffix}`, 70) };
    },
  },
  {
    name: "HTML SEO audit",
    slug: "seo_audit",
    category: "seo",
    description:
      "Audit a page's HTML for on-page SEO and accessibility issues: title and meta description, H1 count, heading order, " +
      "images missing alt text, canonical tag, robots noindex, Open Graph tags, word count and internal vs external links. " +
      "Returns a score and a prioritized fix list.",
    tags: ["seo", "audit", "html", "accessibility", "technical-seo"],
    priceUsdc: "0.04",
    p95Ms: 500,
    p50Ms: 120,
    input: { html: s.str(300_000, 1), url: s.str(2048) },
    required: ["html"],
    example: {
      html: "<html><head><title>Roster</title></head><body><h1>Agents</h1><h1>Escrow</h1><img src='a.png'><a href='/docs'>Docs</a><a href='https://x.com'>X</a><p>Hire agents and pay in USDC.</p></body></html>",
      url: "https://roster.network/",
    },
    output: s.obj({
      score: s.int(0, 100),
      title: s.str(300),
      metaDescription: s.str(400),
      h1Count: s.int(0),
      wordCount: s.int(0),
      imagesMissingAlt: s.int(0),
      internalLinks: s.int(0),
      externalLinks: s.int(0),
      issues: s.arr(s.obj({ severity: s.enm(["high", "medium", "low"]), message: s.str(200) }), 30),
    }),
    run(input) {
      const html = String(input.html ?? "").slice(0, 300_000);
      const url = text(input, "url");
      let host = "";
      try {
        host = url ? new URL(url).host : "";
      } catch {
        host = "";
      }
      const title = stripHtml(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
      const metaDescription = /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1] ?? /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(html)?.[1] ?? "";
      const h1Count = (html.match(/<h1\b/gi) ?? []).length;
      const images = html.match(/<img\b[^>]*>/gi) ?? [];
      const imagesMissingAlt = images.filter((tag) => !/\balt\s*=\s*["'][^"']+["']/i.test(tag)).length;
      const links = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)].map((match) => match[1] ?? "");
      const externalLinks = links.filter((href) => /^https?:\/\//i.test(href) && (!host || !href.includes(host))).length;
      const internalLinks = links.length - externalLinks;
      const body = stripHtml(/<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html);
      const wordCount = words(body).length;
      const issues: { severity: "high" | "medium" | "low"; message: string }[] = [];
      const add = (severity: "high" | "medium" | "low", message: string) => {
        if (issues.length < 30) issues.push({ severity, message });
      };
      if (!title) add("high", "Missing <title> tag.");
      else if (title.length < 30 || title.length > 60) add("medium", `Title is ${title.length.toString()} characters; aim for 30–60.`);
      if (!metaDescription) add("high", "Missing meta description.");
      else if (metaDescription.length < 70 || metaDescription.length > 160) add("low", "Meta description should be 70–160 characters.");
      if (h1Count === 0) add("high", "No <h1> heading.");
      if (h1Count > 1) add("medium", `${h1Count.toString()} <h1> headings; use exactly one.`);
      if (imagesMissingAlt > 0) add("medium", `${imagesMissingAlt.toString()} image(s) missing alt text (accessibility and image SEO).`);
      if (!/<link[^>]+rel=["']canonical["']/i.test(html)) add("medium", "No canonical link tag.");
      if (/<meta[^>]+name=["']robots["'][^>]*noindex/i.test(html)) add("high", "Page is set to noindex.");
      if (!/<meta[^>]+property=["']og:title["']/i.test(html)) add("low", "Missing Open Graph tags for social sharing.");
      if (!/<meta[^>]+name=["']viewport["']/i.test(html)) add("medium", "Missing responsive viewport meta tag.");
      if (!/<html[^>]+lang=/i.test(html)) add("low", "Missing lang attribute on <html>.");
      if (wordCount < 300) add("low", `Thin content: ${wordCount.toString()} words.`);
      const penalty = issues.reduce((sum, issue) => sum + (issue.severity === "high" ? 15 : issue.severity === "medium" ? 8 : 3), 0);
      return { score: Math.max(0, 100 - penalty), title: clip(title, 300), metaDescription: clip(metaDescription, 400), h1Count, wordCount, imagesMissingAlt, internalLinks, externalLinks, issues };
    },
  },
  {
    name: "Keyword density analyzer",
    slug: "keyword_density",
    category: "seo",
    description:
      "Measure keyword density and term frequency in an article or landing page, check a target keyword and its placement " +
      "(title, first paragraph), and warn about keyword stuffing. Content optimization for SEO writers.",
    tags: ["seo", "keyword-density", "content", "optimization"],
    priceUsdc: "0.01",
    p95Ms: 250,
    p50Ms: 60,
    input: { text: s.str(50_000, 1), keyword: s.str(120), limit: s.int(1, 30) },
    required: ["text"],
    example: { text: "Agent escrow keeps buyers safe. With agent escrow, funds lock until the result is valid. Escrow releases payment automatically.", keyword: "agent escrow", limit: 5 },
    output: s.obj({
      totalWords: s.int(0),
      keywordCount: s.int(0),
      keywordDensity: s.num(0, 100),
      inFirstParagraph: s.bool(),
      stuffing: s.bool(),
      terms: s.arr(s.obj({ term: s.str(64), count: s.int(1), density: s.num(0, 100) }), 30),
    }),
    run(input) {
      const source = text(input, "text", "").slice(0, 50_000);
      const keyword = text(input, "keyword").trim().toLowerCase();
      const total = Math.max(1, words(source).length);
      const lower = source.toLowerCase();
      const keywordCount = keyword ? lower.split(keyword).length - 1 : 0;
      const keywordWords = Math.max(1, words(keyword).length);
      const density = keyword ? Math.round(((keywordCount * keywordWords) / total) * 10000) / 100 : 0;
      const firstParagraph = (source.split(/\n\s*\n/)[0] ?? "").toLowerCase();
      return {
        totalWords: words(source).length,
        keywordCount,
        keywordDensity: Math.min(100, density),
        inFirstParagraph: keyword !== "" && firstParagraph.includes(keyword),
        stuffing: density > 3,
        terms: topTerms(source, int(input, "limit", 10, 1, 30)).map((entry) => ({ term: clip(entry.term, 64), count: entry.count, density: Math.round((entry.count / total) * 10000) / 100 })),
      };
    },
  },
  {
    name: "UTM link builder",
    slug: "utm_build",
    category: "seo",
    description:
      "Build campaign tracking URLs with UTM parameters (source, medium, campaign, term, content), normalized to lowercase " +
      "and URL-encoded, for Google Analytics, Plausible or Matomo. Marketing attribution for ads, newsletters and social posts.",
    tags: ["utm", "analytics", "marketing", "campaigns", "tracking"],
    priceUsdc: "0.01",
    p95Ms: 150,
    p50Ms: 30,
    input: { url: s.str(2048, 1), source: s.str(100, 1), medium: s.str(100, 1), campaign: s.str(100, 1), term: s.str(100), content: s.str(100) },
    required: ["url", "source", "medium", "campaign"],
    example: { url: "https://roster.network/console", source: "newsletter", medium: "email", campaign: "Fleet Launch Oct" },
    output: s.obj({ url: s.str(4096), valid: s.bool() }),
    run(input) {
      try {
        const target = new URL(text(input, "url").trim());
        if (target.protocol !== "https:" && target.protocol !== "http:") return { url: "", valid: false };
        for (const key of ["source", "medium", "campaign", "term", "content"]) {
          const value = text(input, key).trim().toLowerCase().replace(/\s+/g, "_").slice(0, 100);
          if (value) target.searchParams.set(`utm_${key}`, value);
        }
        return { url: clip(target.toString(), 4096), valid: true };
      } catch {
        return { url: "", valid: false };
      }
    },
  },
  {
    name: "Email subject line tester",
    slug: "subject_test",
    category: "seo",
    description:
      "Score an email subject line for opens and deliverability: length, mobile truncation, spam trigger words, ALL CAPS, " +
      "excess punctuation, emoji, personalization and urgency, with suggestions. Newsletter and cold outreach optimization.",
    tags: ["email-marketing", "subject-line", "deliverability", "copywriting", "marketing"],
    priceUsdc: "0.01",
    p95Ms: 150,
    p50Ms: 30,
    input: { subject: s.str(300, 1) },
    required: ["subject"],
    example: { subject: "FREE upgrade!!! Act now, {first_name} 🚀" },
    output: s.obj({ score: s.int(0, 100), length: s.int(0), spamWords: s.arr(s.str(32), 20), warnings: s.arr(s.str(160), 10), personalized: s.bool() }),
    run(input) {
      const subject = text(input, "subject").trim().slice(0, 300);
      const lower = subject.toLowerCase();
      const spamWords = SPAM_WORDS.filter((word) => lower.includes(word));
      const warnings: string[] = [];
      let score = 100;
      if (subject.length > 60) {
        warnings.push("Over 60 characters: likely truncated on mobile.");
        score -= 15;
      }
      if (subject.length < 15) {
        warnings.push("Very short: add a concrete benefit.");
        score -= 10;
      }
      if (spamWords.length > 0) {
        warnings.push(`Spam trigger words: ${spamWords.join(", ")}.`);
        score -= spamWords.length * 10;
      }
      const capsWords = subject.split(/\s+/).filter((word) => word.length > 2 && word === word.toUpperCase() && /[A-Z]/.test(word));
      if (capsWords.length > 0) {
        warnings.push("Avoid ALL CAPS words.");
        score -= 10;
      }
      if (/[!?]{2,}/.test(subject)) {
        warnings.push("Excess punctuation looks like spam.");
        score -= 10;
      }
      const emoji = (subject.match(/\p{Extended_Pictographic}/gu) ?? []).length;
      if (emoji > 1) {
        warnings.push("Use at most one emoji.");
        score -= 5;
      }
      const personalized = /\{[^}]+\}|\[[^\]]+\]|%[A-Z_]+%/.test(subject);
      if (personalized) score += 5;
      return { score: Math.max(0, Math.min(100, score)), length: subject.length, spamWords: spamWords.slice(0, 20), warnings, personalized };
    },
  },
  {
    name: "Social post drafter",
    slug: "social_posts",
    category: "seo",
    description:
      "Draft social media posts for X (Twitter), LinkedIn and Bluesky from a product announcement or blog post: platform " +
      "length limits, hashtags and a call to action. Template-based copy for launches, changelogs and content distribution.",
    tags: ["social-media", "copywriting", "linkedin", "twitter", "marketing"],
    priceUsdc: "0.02",
    p95Ms: 300,
    p50Ms: 60,
    input: { topic: s.str(300, 1), details: s.str(5000), url: s.str(2048), hashtags: s.arr(s.str(40), 5) },
    required: ["topic"],
    example: { topic: "Roster Fleet now offers 80+ first-party agent services", details: "Hire CSV cleaning, code review, SEO briefs and invoice parsing with USDC escrow.", url: "https://roster.network", hashtags: ["AIagents", "USDC"] },
    output: s.obj({ posts: s.arr(s.obj({ network: s.enm(["x", "linkedin", "bluesky"]), text: s.str(3000), length: s.int(0) }), 3) }),
    run(input) {
      const topic = text(input, "topic").trim().slice(0, 300) || "Update";
      const details = sentences(text(input, "details")).slice(0, 2).join(" ");
      const url = text(input, "url").trim();
      const derived = topTerms(`${topic} ${details}`, 3).map((entry) => entry.term.replace(/[^a-z0-9]/gi, ""));
      const tags = (strings(input, "hashtags", 5, 40).length > 0 ? strings(input, "hashtags", 5, 40) : derived)
        .map((tag) => `#${tag.replace(/^#/, "").replace(/[^\p{L}\p{N}_]/gu, "")}`)
        .filter((tag) => tag.length > 1);
      const hooks = ["Big news:", "Just shipped:", "New:", "Announcing:"];
      const hook = hooks[fnv(topic) % hooks.length] ?? "New:";
      const fit = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, max - 1).replace(/\s+\S*$/, "")}…`);
      const x = fit(`${hook} ${topic}${details ? ` — ${details}` : ""} ${url} ${tags.join(" ")}`.replace(/\s+/g, " ").trim(), 280);
      const linkedin = fit(`${hook} ${topic}\n\n${details}\n\nWhat would you build with it?${url ? `\n\n👉 ${url}` : ""}\n\n${tags.join(" ")}`.trim(), 3000);
      const bluesky = fit(`${topic}${details ? `. ${details}` : ""} ${url}`.replace(/\s+/g, " ").trim(), 300);
      return {
        posts: [
          { network: "x", text: x, length: x.length },
          { network: "linkedin", text: linkedin, length: linkedin.length },
          { network: "bluesky", text: bluesky, length: bluesky.length },
        ],
      };
    },
  },
  {
    name: "Product description writer",
    slug: "product_copy",
    category: "seo",
    description:
      "Write an e-commerce product description from structured attributes (name, category, features, materials, audience): " +
      "a headline, a benefit-led paragraph, feature bullets and an SEO meta description. Template-based copy for Shopify, " +
      "WooCommerce and marketplace listings.",
    tags: ["ecommerce", "product-description", "copywriting", "seo", "shopify"],
    priceUsdc: "0.03",
    p95Ms: 300,
    p50Ms: 60,
    input: { name: s.str(120, 1), category: s.str(60), features: s.arr(s.str(120), 10), audience: s.str(120), tone: s.enm(["friendly", "premium", "technical"]) },
    required: ["name"],
    example: { name: "Trailhead 30L Backpack", category: "hiking backpack", features: ["waterproof ripstop nylon", "padded laptop sleeve", "1.1 kg"], audience: "weekend hikers", tone: "friendly" },
    output: s.obj({ headline: s.str(120), description: s.str(1500), bullets: s.arr(s.str(160), 10), metaDescription: s.str(160) }),
    run(input) {
      const name = text(input, "name").trim().slice(0, 120) || "This product";
      const category = text(input, "category").trim().slice(0, 60) || "product";
      const features = strings(input, "features", 10, 120);
      const audience = text(input, "audience").trim().slice(0, 120);
      const tone = typeof input.tone === "string" ? input.tone : "friendly";
      const opener = tone === "premium" ? `Crafted for those who expect more, the ${name}` : tone === "technical" ? `The ${name} is a ${category} engineered with` : `Meet the ${name}`;
      const featureText = features.length > 0 ? features.slice(0, 3).join(", ") : "thoughtful details";
      const description =
        tone === "technical"
          ? `${opener} ${featureText}.${audience ? ` Built for ${audience}.` : ""} Every component is chosen for durability and performance.`
          : `${opener}${tone === "premium" ? " combines" : " — a " + category + " with"} ${featureText}.${audience ? ` Perfect for ${audience}.` : ""} It is designed to make every day easier, so you can focus on what matters.`;
      return {
        headline: clip(`${name}${category !== "product" ? ` – ${titleCase(category)}` : ""}`, 120),
        description: clip(description, 1500),
        bullets: features.map((feature) => clip(feature.charAt(0).toUpperCase() + feature.slice(1), 160)),
        metaDescription: clip(`${name}: ${category} with ${featureText}.${audience ? ` Ideal for ${audience}.` : ""}`, 160),
      };
    },
  },
  {
    name: "FAQ builder",
    slug: "faq_build",
    category: "seo",
    description:
      "Build an FAQ section from product docs, a help article or support transcripts: question and answer pairs plus " +
      "FAQPage JSON-LD structured data for rich results. Reduces support tickets and improves SEO.",
    tags: ["faq", "seo", "structured-data", "support", "json-ld"],
    priceUsdc: "0.03",
    p95Ms: 400,
    p50Ms: 100,
    input: { text: s.str(20_000, 1), maxQuestions: s.int(1, 10) },
    required: ["text"],
    example: {
      text: "Roster locks USDC in escrow before work starts. Sellers are paid when the result matches the schema. If the SLA passes, the buyer is refunded. The take-rate is 1%.",
      maxQuestions: 3,
    },
    output: s.obj({ faqs: s.arr(s.obj({ question: s.str(200), answer: s.str(600) }), 10), jsonLd: s.str(20_000) }),
    run(input) {
      const source = text(input, "text");
      const limit = int(input, "maxQuestions", 5, 1, 10);
      const explicit = [...source.matchAll(/([^.!?\n]*\?)\s*([^?]+?[.!])(?=\s|$)/g)].map((match) => ({ question: (match[1] ?? "").trim(), answer: (match[2] ?? "").trim() }));
      const derived = sentences(source)
        .filter((sentence) => !sentence.endsWith("?"))
        .map((sentence) => {
          const subject = sentence.split(/\s+(?:is|are|locks|lets|keeps|uses|can|will|gets|get|pays|refunds)\s+/i)[0]?.trim() ?? "";
          const verb = /\s(is|are)\s/i.exec(sentence)?.[1]?.toLowerCase();
          const question = verb && subject.split(" ").length <= 5 ? `What ${verb} ${subject.charAt(0).toLowerCase()}${subject.slice(1)}?` : /\bif\b/i.test(sentence) ? `What happens ${sentence.slice(sentence.toLowerCase().indexOf("if")).split(",")[0] ?? ""}?` : `How does ${subject.charAt(0).toLowerCase()}${subject.slice(1)} work?`;
          return { question, answer: sentence };
        });
      const faqs = [...explicit, ...derived].slice(0, limit).map((entry) => ({ question: clip(entry.question, 200), answer: clip(entry.answer, 600) }));
      const jsonLd = JSON.stringify({
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: faqs.map((entry) => ({ "@type": "Question", name: entry.question, acceptedAnswer: { "@type": "Answer", text: entry.answer } })),
      });
      return { faqs, jsonLd: clip(jsonLd, 20_000) };
    },
  },
];
