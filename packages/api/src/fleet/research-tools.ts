import { clip, int, isRecord, num, records, round, s, strings, text, type FleetTool } from "./kit.js";
import { contentWords, sentimentScore, titleCase, topTerms } from "./nlp.js";

export const researchTools: FleetTool[] = [
  {
    name: "Research brief planner",
    slug: "research_brief",
    category: "research",
    description:
      "Plan a research project on any topic: objective, key research questions, sub-topics to investigate, source types to " +
      "consult (academic, industry reports, primary data, expert interviews), search queries and a deliverable outline. " +
      "Desk research and market research kickoff. Plans only; it does not browse the web.",
    tags: ["research", "planning", "market-research", "analysis", "brief"],
    priceUsdc: "0.05",
    p95Ms: 400,
    p50Ms: 100,
    input: { topic: s.str(200, 1), goal: s.str(500), depth: s.enm(["quick", "standard", "deep"]) },
    required: ["topic"],
    example: { topic: "agent-to-agent payments in Europe", goal: "decide whether to launch a USDC escrow product for EU startups", depth: "standard" },
    output: s.obj({
      objective: s.str(600),
      questions: s.arr(s.str(200), 12),
      subtopics: s.arr(s.str(120), 10),
      sources: s.arr(s.obj({ type: s.str(40), why: s.str(200) }), 8),
      searchQueries: s.arr(s.str(120), 10),
      outline: s.arr(s.str(120), 10),
      estimatedHours: s.int(1, 200),
    }),
    run(input) {
      const topic = text(input, "topic").trim().slice(0, 200) || "the topic";
      const goal = text(input, "goal").trim().slice(0, 500);
      const depth = input.depth === "quick" || input.depth === "deep" ? input.depth : "standard";
      const count = depth === "quick" ? 5 : depth === "deep" ? 12 : 8;
      const questions = [
        `What is the current state of ${topic}?`,
        `Who are the main players in ${topic} and how are they positioned?`,
        `How large is the market for ${topic} and how fast is it growing?`,
        `What problems or unmet needs exist in ${topic}?`,
        `What regulations or standards affect ${topic}?`,
        `What technologies enable ${topic} and what are their limits?`,
        `How do customers currently buy or adopt solutions in ${topic}?`,
        `What pricing and business models are common in ${topic}?`,
        `What are the main risks and failure modes in ${topic}?`,
        `Which trends will shape ${topic} over the next 2–3 years?`,
        `What would success look like for a new entrant in ${topic}?`,
        `What evidence would change our decision about ${topic}?`,
      ].slice(0, count);
      const terms = topTerms(`${topic} ${goal}`, 4).map((entry) => entry.term);
      return {
        objective: clip(goal ? `Understand ${topic} well enough to ${goal}.` : `Build a clear, evidence-based picture of ${topic}.`, 600),
        questions,
        subtopics: ["Market size and growth", "Competitors and alternatives", "Customer needs and buying process", "Regulation and compliance", "Technology and infrastructure", "Pricing and unit economics", "Risks and open questions"].slice(0, depth === "quick" ? 4 : 7),
        sources: [
          { type: "Industry reports", why: "Market sizing and trend data from analysts and associations." },
          { type: "Academic papers", why: "Peer-reviewed evidence and technical depth." },
          { type: "Regulator publications", why: "Binding rules, consultations and enforcement actions." },
          { type: "Competitor websites and docs", why: "Positioning, features and pricing pages." },
          { type: "Customer interviews", why: "Primary evidence on pain points and willingness to pay." },
          { type: "Community forums", why: "Unfiltered practitioner opinions and recurring problems." },
        ].slice(0, depth === "quick" ? 3 : 6),
        searchQueries: [`${topic} market size 2026`, `${topic} competitors`, `${topic} regulation`, `${topic} pricing`, `${topic} case study`, `${topic} challenges`, ...terms.map((term) => `${term} trends`)].slice(0, 10).map((query) => clip(query, 120)),
        outline: ["Executive summary", "Context and definitions", "Market and players", "Customer insights", "Regulatory landscape", "Opportunities and risks", "Recommendation and next steps"],
        estimatedHours: depth === "quick" ? 4 : depth === "deep" ? 40 : 16,
      };
    },
  },
  {
    name: "Feature comparison matrix",
    slug: "compare_matrix",
    category: "research",
    description:
      "Build a feature comparison matrix from product feature lists: which options support which features, unique " +
      "features per product, coverage score and a winner per weighted criteria. Competitive analysis, vendor selection and " +
      "buyer guides.",
    tags: ["comparison", "competitive-analysis", "vendors", "research", "matrix"],
    priceUsdc: "0.03",
    p95Ms: 300,
    p50Ms: 60,
    input: { products: s.arr(s.obj({ name: s.str(80, 1), features: s.arr(s.str(80), 50) }), 10, 2), weights: { type: "object" } },
    required: ["products"],
    example: {
      products: [
        { name: "Roster", features: ["usdc escrow", "schema validation", "sla refunds", "reputation"] },
        { name: "Generic gig board", features: ["reputation", "chat"] },
      ],
      weights: { "usdc escrow": 3, "sla refunds": 2 },
    },
    output: s.obj({
      features: s.arr(s.str(80), 100),
      rows: s.arr(s.obj({ product: s.str(80), supported: s.arr(s.bool(), 100), coverage: s.num(0, 1), weightedScore: s.num(0), unique: s.arr(s.str(80), 50) }), 10),
      winner: s.str(80),
    }),
    run(input) {
      const products = records(input, "products", 10).map((product) => ({
        name: clip(typeof product.name === "string" ? product.name : "Unnamed", 80),
        features: strings(product, "features", 50, 80).map((feature) => feature.trim().toLowerCase()).filter(Boolean),
      }));
      const weights = isRecord(input.weights) ? input.weights : {};
      const features = [...new Set(products.flatMap((product) => product.features))].slice(0, 100);
      const rows = products.map((product) => {
        const supported = features.map((feature) => product.features.includes(feature));
        const weightedScore = features.reduce((sum, feature, index) => sum + (supported[index] ? Math.max(0, num(weights, feature, 1)) : 0), 0);
        const unique = product.features.filter((feature) => products.filter((other) => other.features.includes(feature)).length === 1).slice(0, 50);
        return { product: product.name, supported, coverage: features.length === 0 ? 0 : round(supported.filter(Boolean).length / features.length, 3), weightedScore: round(weightedScore, 3), unique };
      });
      const winner = [...rows].sort((left, right) => right.weightedScore - left.weightedScore)[0]?.product ?? "";
      return { features, rows, winner };
    },
  },
  {
    name: "Citation formatter",
    slug: "citation_format",
    category: "research",
    description:
      "Format a reference in APA 7, MLA 9, Chicago or Harvard style from structured fields (authors, year, title, journal or " +
      "publisher, volume, pages, DOI, URL). Bibliographies for papers, reports and theses.",
    tags: ["citations", "bibliography", "apa", "academic", "research"],
    priceUsdc: "0.005",
    p95Ms: 150,
    p50Ms: 30,
    input: {
      style: s.enm(["apa", "mla", "chicago", "harvard"]),
      authors: s.arr(s.str(100), 20, 1),
      year: s.int(1000, 2100),
      title: s.str(300, 1),
      container: s.str(200),
      volume: s.str(20),
      issue: s.str(20),
      pages: s.str(20),
      doi: s.str(200),
      url: s.str(2048),
    },
    required: ["authors", "title"],
    example: { style: "apa", authors: ["Albesa Vives, Pau", "Puig, Anna"], year: 2026, title: "Escrowed payments between autonomous agents", container: "Journal of Agent Economics", volume: "4", issue: "2", pages: "15-31", doi: "10.1234/jae.2026.042" },
    output: s.obj({ citation: s.str(1500), style: s.str(16) }),
    run(input) {
      const style = input.style === "mla" || input.style === "chicago" || input.style === "harvard" ? input.style : "apa";
      const authors = strings(input, "authors", 20, 100).map((author) => author.trim()).filter(Boolean);
      const year = typeof input.year === "number" ? String(Math.trunc(input.year)) : "n.d.";
      const title = text(input, "title").trim().replace(/\.$/, "");
      const container = text(input, "container").trim();
      const volume = text(input, "volume").trim();
      const issue = text(input, "issue").trim();
      const pages = text(input, "pages").trim().replace("-", "–");
      const doi = text(input, "doi").trim().replace(/^https?:\/\/doi\.org\//, "");
      const link = doi ? `https://doi.org/${doi}` : text(input, "url").trim();
      const initials = (author: string) => {
        const [last, first = ""] = author.includes(",") ? author.split(",").map((part) => part.trim()) : [author.split(" ").slice(-1)[0] ?? author, author.split(" ").slice(0, -1).join(" ")];
        const init = first.split(/\s+/).filter(Boolean).map((name) => `${name.charAt(0)}.`).join(" ");
        return { last: last ?? author, first, init };
      };
      const parsed = authors.map(initials);
      const join = (list: string[], last: string) => (list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")}, ${last} ${list[list.length - 1] ?? ""}`);
      let citation = "";
      if (style === "apa") {
        const names = join(parsed.map((author) => `${author.last}, ${author.init}`.trim().replace(/,\s*$/, "")), "&");
        citation = `${names} (${year}). ${title}.${container ? ` ${container}` : ""}${volume ? `, ${volume}` : ""}${issue ? `(${issue})` : ""}${pages ? `, ${pages}` : ""}.${link ? ` ${link}` : ""}`;
      } else if (style === "mla") {
        const first = parsed[0];
        const names = !first ? "" : parsed.length === 1 ? `${first.last}, ${first.first}` : parsed.length === 2 ? `${first.last}, ${first.first}, and ${parsed[1]?.first ?? ""} ${parsed[1]?.last ?? ""}` : `${first.last}, ${first.first}, et al`;
        citation = `${names}. "${title}."${container ? ` ${container}` : ""}${volume ? `, vol. ${volume}` : ""}${issue ? `, no. ${issue}` : ""}, ${year}${pages ? `, pp. ${pages}` : ""}.${link ? ` ${link.replace(/^https?:\/\//, "")}.` : ""}`;
      } else if (style === "chicago") {
        const names = join(parsed.map((author, index) => (index === 0 ? `${author.last}, ${author.first}` : `${author.first} ${author.last}`)), "and");
        citation = `${names}. ${year}. "${title}."${container ? ` ${container}` : ""}${volume ? ` ${volume}` : ""}${issue ? ` (${issue})` : ""}${pages ? `: ${pages}` : ""}.${link ? ` ${link}.` : ""}`;
      } else {
        const names = join(parsed.map((author) => `${author.last}, ${author.init.replace(/ /g, "")}`), "and");
        citation = `${names} (${year}) '${title}',${container ? ` ${container}` : ""}${volume ? `, ${volume}` : ""}${issue ? `(${issue})` : ""}${pages ? `, pp. ${pages}` : ""}.${link ? ` Available at: ${link}.` : ""}`;
      }
      return { citation: clip(citation.replace(/\s+/g, " ").replace(/\.\./g, ".").trim(), 1500), style };
    },
  },
  {
    name: "Survey theme tagger",
    slug: "survey_themes",
    category: "research",
    description:
      "Tag open-ended survey responses, NPS comments or user interview notes with recurring themes (pricing, usability, " +
      "performance, support, features, reliability, onboarding) and sentiment per theme. Qualitative research synthesis at scale.",
    tags: ["survey", "nps", "feedback", "themes", "ux-research"],
    priceUsdc: "0.03",
    p95Ms: 400,
    p50Ms: 100,
    input: { responses: s.arr(s.str(2000), 2000, 1) },
    required: ["responses"],
    example: { responses: ["Too expensive for a small team", "Setup was easy and support answered fast", "The dashboard is slow and confusing", "Love the escrow, wish it had more integrations"] },
    output: s.obj({
      themes: s.arr(s.obj({ theme: s.str(32), count: s.int(1), share: s.num(0, 1), sentiment: s.num(-1, 1), example: s.str(300) }), 10),
      untagged: s.int(0),
      emergingTerms: s.arr(s.str(40), 10),
    }),
    run(input) {
      const responses = strings(input, "responses", 2000, 2000);
      const themes: Record<string, RegExp> = {
        pricing: /price|pricing|expensive|cheap|cost|plan|billing|fee/i,
        usability: /easy|hard|confus|intuitive|ux|ui|design|navigation|dashboard|simple/i,
        performance: /slow|fast|speed|lag|latency|performance|loading/i,
        support: /support|help|answer|response|team|customer service/i,
        features: /feature|integration|wish|missing|add|api|export|would like/i,
        reliability: /bug|crash|error|down|outage|reliable|stable|broken/i,
        onboarding: /setup|onboard|getting started|docs|documentation|tutorial|signup|sign up/i,
      };
      const tally = new Map<string, { count: number; sentiment: number; example: string }>();
      let untagged = 0;
      for (const response of responses) {
        const matched = Object.entries(themes).filter(([, pattern]) => pattern.test(response));
        if (matched.length === 0) untagged += 1;
        const score = sentimentScore(response).score;
        for (const [theme] of matched) {
          const current = tally.get(theme) ?? { count: 0, sentiment: 0, example: response };
          tally.set(theme, { count: current.count + 1, sentiment: current.sentiment + score, example: current.example });
        }
      }
      const known = new Set(["price", "pricing", "support", "easy", "slow", "fast", "feature", "features"]);
      return {
        themes: [...tally.entries()]
          .sort((left, right) => right[1].count - left[1].count)
          .map(([theme, value]) => ({ theme, count: value.count, share: round(value.count / Math.max(1, responses.length), 3), sentiment: round(value.sentiment / value.count, 3), example: clip(value.example, 300) })),
        untagged,
        emergingTerms: topTerms(responses.join(" "), 15).map((entry) => entry.term).filter((term) => !known.has(term)).slice(0, 10).map((term) => clip(term, 40)),
      };
    },
  },
  {
    name: "Review rating aggregator",
    slug: "review_aggregate",
    category: "research",
    description:
      "Aggregate product or app reviews: average rating, star distribution, Bayesian-adjusted score, sentiment split and the " +
      "most mentioned praise and complaint terms. Competitive review mining and product feedback dashboards.",
    tags: ["reviews", "ratings", "sentiment", "analytics", "research"],
    priceUsdc: "0.02",
    p95Ms: 300,
    p50Ms: 80,
    input: { reviews: s.arr(s.obj({ rating: s.num(1, 5), text: s.str(5000) }, ["rating"]), 5000, 1), priorMean: s.num(1, 5), priorWeight: s.int(0, 1000) },
    required: ["reviews"],
    example: { reviews: [{ rating: 5, text: "Fast and reliable" }, { rating: 2, text: "Support was slow and the app crashed" }, { rating: 4, text: "Great value, easy setup" }] },
    output: s.obj({
      count: s.int(0),
      average: s.num(0, 5),
      bayesian: s.num(0, 5),
      distribution: s.obj({ one: s.int(0), two: s.int(0), three: s.int(0), four: s.int(0), five: s.int(0) }),
      positiveShare: s.num(0, 1),
      praise: s.arr(s.str(40), 10),
      complaints: s.arr(s.str(40), 10),
    }),
    run(input) {
      const reviews = records(input, "reviews", 5000).map((review) => ({ rating: Math.min(5, Math.max(1, Math.round(num(review, "rating", 3)))), text: typeof review.text === "string" ? review.text.slice(0, 5000) : "" }));
      const count = reviews.length;
      const sum = reviews.reduce((acc, review) => acc + review.rating, 0);
      const priorMean = Math.min(5, Math.max(1, num(input, "priorMean", 3.5)));
      const priorWeight = int(input, "priorWeight", 10, 0, 1000);
      const distribution = { one: 0, two: 0, three: 0, four: 0, five: 0 };
      const keys = ["one", "two", "three", "four", "five"] as const;
      for (const review of reviews) distribution[keys[review.rating - 1] ?? "three"] += 1;
      const positive = reviews.filter((review) => review.rating >= 4);
      const negative = reviews.filter((review) => review.rating <= 2);
      const termsOf = (list: { text: string }[]) => topTerms(list.map((review) => review.text).join(" "), 10).map((entry) => clip(entry.term, 40));
      return {
        count,
        average: count === 0 ? 0 : round(sum / count, 2),
        bayesian: count + priorWeight === 0 ? 0 : round((sum + priorMean * priorWeight) / (count + priorWeight), 2),
        distribution,
        positiveShare: count === 0 ? 0 : round(positive.length / count, 3),
        praise: termsOf(positive),
        complaints: termsOf(negative),
      };
    },
  },
  {
    name: "Topic clusterer",
    slug: "topic_cluster",
    category: "research",
    description:
      "Group a list of short texts (support tickets, search queries, headlines, ideas, keywords) into topic clusters by " +
      "shared terms, with a label and members for each cluster. Keyword clustering for SEO, ticket triage and idea sorting.",
    tags: ["clustering", "topics", "keywords", "triage", "research"],
    priceUsdc: "0.03",
    p95Ms: 500,
    p50Ms: 120,
    input: { items: s.arr(s.str(500), 1000, 2), maxClusters: s.int(2, 20) },
    required: ["items"],
    example: { items: ["refund not received", "how to get a refund", "api key revoked", "rotate api key", "escrow refund timing", "create api key"], maxClusters: 3 },
    output: s.obj({ clusters: s.arr(s.obj({ label: s.str(80), size: s.int(1), members: s.arr(s.str(500), 1000) }), 21) }),
    run(input) {
      const items = strings(input, "items", 1000, 500);
      const maxClusters = int(input, "maxClusters", 8, 2, 20);
      const tokens = items.map((item) => new Set(contentWords(item)));
      const df = new Map<string, number>();
      for (const set of tokens) for (const token of set) df.set(token, (df.get(token) ?? 0) + 1);
      const seeds = [...df.entries()].filter(([, count]) => count >= 2).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, maxClusters).map(([term]) => term);
      const clusters = new Map<string, string[]>(seeds.map((seed) => [seed, []]));
      const other: string[] = [];
      items.forEach((item, index) => {
        const set = tokens[index] ?? new Set<string>();
        const seed = seeds.find((candidate) => set.has(candidate));
        if (seed) clusters.get(seed)?.push(item);
        else other.push(item);
      });
      const result = [...clusters.entries()].filter(([, members]) => members.length > 0).map(([seed, members]) => ({ label: clip(titleCase(seed), 80), size: members.length, members }));
      if (other.length > 0) result.push({ label: "Other", size: other.length, members: other });
      return { clusters: result };
    },
  },
];
