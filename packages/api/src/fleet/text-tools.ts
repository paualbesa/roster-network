import { clip, int, oneOf, round, s, text, type FleetTool } from "./kit.js";
import {
  extractiveSummary,
  NEGATIVE,
  paragraphs,
  sentences,
  sentimentScore,
  slugify,
  syllables,
  titleCase,
  topTerms,
  words,
} from "./nlp.js";

const SAMPLE_ARTICLE =
  "Roster lets software agents hire other agents and pay them in USDC. Each job locks funds in escrow before work starts. " +
  "The seller delivers a JSON result that must match the buyer's schema. A valid result releases payment, minus a small take-rate. " +
  "If the seller misses the SLA, the buyer gets a full refund automatically. Reputation passports record every outcome.";

const textInput = { text: s.str(20_000, 1) };

export const textTools: FleetTool[] = [
  {
    name: "Extractive text summarizer",
    slug: "text_summarize",
    category: "text",
    description:
      "Summarize an article, report, email thread or document into its most important sentences. Extractive summarization: " +
      "picks key sentences by term frequency, so the summary never invents facts. Good for TL;DR, digests and briefs.",
    tags: ["summarize", "summary", "tldr", "text", "docs"],
    priceUsdc: "0.02",
    p95Ms: 400,
    p50Ms: 120,
    input: { ...textInput, maxSentences: s.int(1, 10) },
    required: ["text"],
    example: { text: SAMPLE_ARTICLE, maxSentences: 2 },
    output: s.obj({
      summary: s.str(4000),
      sentenceCount: s.int(0, 10),
      compressionRatio: s.num(0, 1),
    }),
    run(input) {
      const source = text(input, "text");
      const picked = extractiveSummary(source, int(input, "maxSentences", 3, 1, 10));
      const summary = clip(picked.join(" "), 4000);
      return {
        summary,
        sentenceCount: picked.length,
        compressionRatio: source.length === 0 ? 0 : round(Math.min(1, summary.length / source.length), 3),
      };
    },
  },
  {
    name: "Bullet-point summarizer",
    slug: "bullet_summary",
    category: "text",
    description:
      "Turn long text into concise bullet points: key takeaways, highlights and main ideas as a list. Useful for meeting " +
      "recaps, newsletters, release notes and executive summaries.",
    tags: ["summarize", "bullets", "takeaways", "text"],
    priceUsdc: "0.02",
    p95Ms: 400,
    p50Ms: 120,
    input: { ...textInput, maxBullets: s.int(1, 10) },
    required: ["text"],
    example: { text: SAMPLE_ARTICLE, maxBullets: 3 },
    output: s.obj({ bullets: s.arr(s.str(400), 10) }),
    run(input) {
      const picked = extractiveSummary(text(input, "text"), int(input, "maxBullets", 5, 1, 10));
      return { bullets: picked.map((sentence) => clip(sentence.replace(/[.!?]+$/, ""), 400)) };
    },
  },
  {
    name: "Headline writer",
    slug: "headline_writer",
    category: "text",
    description:
      "Write a short headline and title options for an article, blog post, press release or product update, based on its " +
      "most frequent key terms and lead sentence. Returns title-cased headlines under 70 characters.",
    tags: ["headline", "title", "copywriting", "text", "marketing"],
    priceUsdc: "0.015",
    p95Ms: 300,
    p50Ms: 90,
    input: textInput,
    required: ["text"],
    example: { text: SAMPLE_ARTICLE },
    output: s.obj({ headline: s.str(120), alternatives: s.arr(s.str(120), 3) }),
    run(input) {
      const source = text(input, "text");
      const terms = topTerms(source, 4).map((entry) => entry.term);
      const lead = sentences(source)[0] ?? "";
      const leadWords = lead.split(/\s+/).slice(0, 9).join(" ").replace(/[.!?,;:]+$/, "");
      const headline = clip(titleCase(leadWords || terms.join(" ") || "Untitled"), 70);
      const alternatives = [
        terms.length >= 2 ? `${titleCase(terms[0] ?? "")} and ${titleCase(terms[1] ?? "")}: What to Know` : "",
        terms.length >= 1 ? `How ${titleCase(terms[0] ?? "")} Works` : "",
        terms.length >= 3 ? `${titleCase(terms.slice(0, 3).join(", "))} Explained` : "",
      ]
        .filter(Boolean)
        .map((entry) => clip(entry, 70));
      return { headline, alternatives };
    },
  },
  {
    name: "Keyword extractor",
    slug: "keyword_extract",
    category: "text",
    description:
      "Extract the main keywords and key phrases from text with relevance scores (term frequency without stopwords). Use it " +
      "for tagging, topic detection, indexing, SEO research and content classification.",
    tags: ["keywords", "tagging", "topics", "text", "seo"],
    priceUsdc: "0.01",
    p95Ms: 300,
    p50Ms: 80,
    input: { ...textInput, limit: s.int(1, 30) },
    required: ["text"],
    example: { text: SAMPLE_ARTICLE, limit: 5 },
    output: s.obj({
      keywords: s.arr(s.obj({ term: s.str(64), count: s.int(1), score: s.num(0, 1) }), 30),
    }),
    run(input) {
      const source = text(input, "text");
      const terms = topTerms(source, int(input, "limit", 10, 1, 30));
      const top = terms[0]?.count ?? 1;
      return {
        keywords: terms.map((entry) => ({ term: clip(entry.term, 64), count: entry.count, score: round(entry.count / top, 3) })),
      };
    },
  },
  {
    name: "Readability scorer",
    slug: "readability_score",
    category: "text",
    description:
      "Score how easy English text is to read: Flesch reading ease, Flesch-Kincaid grade level, average sentence length and " +
      "long-word ratio. Helps editors simplify docs, onboarding copy, legal text and support articles.",
    tags: ["readability", "writing", "editing", "text"],
    priceUsdc: "0.01",
    p95Ms: 250,
    p50Ms: 60,
    input: textInput,
    required: ["text"],
    example: { text: SAMPLE_ARTICLE },
    output: s.obj({
      fleschReadingEase: s.num(-200, 200),
      gradeLevel: s.num(-10, 100),
      avgSentenceWords: s.num(0),
      longWordRatio: s.num(0, 1),
      verdict: s.enm(["very easy", "easy", "standard", "difficult", "very difficult"]),
    }),
    run(input) {
      const source = text(input, "text");
      const tokens = words(source);
      const sentenceCount = Math.max(1, sentences(source).length);
      const wordCount = Math.max(1, tokens.length);
      const syllableCount = tokens.reduce((sum, word) => sum + syllables(word), 0);
      const ease = round(206.835 - 1.015 * (wordCount / sentenceCount) - 84.6 * (syllableCount / wordCount), 1);
      const grade = round(0.39 * (wordCount / sentenceCount) + 11.8 * (syllableCount / wordCount) - 15.59, 1);
      const long = tokens.filter((word) => syllables(word) >= 3).length;
      const clampedEase = Math.max(-200, Math.min(200, tokens.length === 0 ? 100 : ease));
      const verdict =
        clampedEase >= 80 ? "very easy" : clampedEase >= 65 ? "easy" : clampedEase >= 50 ? "standard" : clampedEase >= 30 ? "difficult" : "very difficult";
      return {
        fleschReadingEase: clampedEase,
        gradeLevel: Math.max(-10, Math.min(100, tokens.length === 0 ? 0 : grade)),
        avgSentenceWords: round(tokens.length / sentenceCount, 1),
        longWordRatio: round(long / wordCount, 3),
        verdict,
      };
    },
  },
  {
    name: "Word count and reading time",
    slug: "text_stats",
    category: "text",
    description:
      "Count words, characters, sentences and paragraphs, and estimate reading and speaking time. A quick text statistics " +
      "tool for writers, CMS pipelines, content limits and essay checks.",
    tags: ["word-count", "statistics", "reading-time", "text"],
    priceUsdc: "0.01",
    p95Ms: 200,
    p50Ms: 40,
    input: textInput,
    required: ["text"],
    example: { text: SAMPLE_ARTICLE },
    output: s.obj({
      words: s.int(0),
      characters: s.int(0),
      charactersNoSpaces: s.int(0),
      sentences: s.int(0),
      paragraphs: s.int(0),
      readingTimeSec: s.int(0),
      speakingTimeSec: s.int(0),
    }),
    run(input) {
      const source = text(input, "text");
      const wordCount = words(source).length;
      return {
        words: wordCount,
        characters: source.length,
        charactersNoSpaces: source.replace(/\s/g, "").length,
        sentences: sentences(source).length,
        paragraphs: paragraphs(source).length,
        readingTimeSec: Math.round((wordCount / 238) * 60),
        speakingTimeSec: Math.round((wordCount / 140) * 60),
      };
    },
  },
  {
    name: "Sentiment analyzer",
    slug: "sentiment_analyze",
    category: "text",
    description:
      "Classify the sentiment of a review, tweet, support ticket or survey answer as positive, negative or neutral with a " +
      "score from -1 to 1. Lexicon-based opinion mining with negation handling; runs offline.",
    tags: ["sentiment", "opinion", "reviews", "classification", "text"],
    priceUsdc: "0.01",
    p95Ms: 250,
    p50Ms: 60,
    input: textInput,
    required: ["text"],
    example: { text: "The checkout was fast and the support team was really helpful, but shipping was slow." },
    output: s.obj({
      label: s.enm(["positive", "negative", "neutral"]),
      score: s.num(-1, 1),
      positiveHits: s.int(0),
      negativeHits: s.int(0),
    }),
    run(input) {
      const result = sentimentScore(text(input, "text"));
      const label = result.score > 0.15 ? "positive" : result.score < -0.15 ? "negative" : "neutral";
      return { label, score: result.score, positiveHits: result.positive, negativeHits: result.negative };
    },
  },
  {
    name: "Emotion tagger",
    slug: "emotion_tag",
    category: "text",
    description:
      "Detect emotions in text (joy, anger, sadness, fear, surprise, trust) with hit counts. Useful for customer feedback " +
      "triage, social listening, community moderation and voice-of-customer analysis.",
    tags: ["emotion", "sentiment", "feedback", "classification", "text"],
    priceUsdc: "0.01",
    p95Ms: 250,
    p50Ms: 60,
    input: textInput,
    required: ["text"],
    example: { text: "I was so happy when it arrived, but then I got angry because a part was missing." },
    output: s.obj({
      dominant: s.enm(["joy", "anger", "sadness", "fear", "surprise", "trust", "none"]),
      emotions: s.arr(s.obj({ emotion: s.str(16), hits: s.int(1) }), 6),
    }),
    run(input) {
      const lexicon: Record<string, string[]> = {
        joy: ["happy", "glad", "joy", "love", "delighted", "excited", "great", "wonderful", "fun", "enjoy"],
        anger: ["angry", "furious", "mad", "annoyed", "hate", "outraged", "rage", "irritated", "unacceptable"],
        sadness: ["sad", "unhappy", "disappointed", "sorry", "miss", "lonely", "depressed", "regret", "upset"],
        fear: ["afraid", "scared", "worried", "fear", "anxious", "nervous", "panic", "risk", "concerned"],
        surprise: ["surprised", "unexpected", "wow", "suddenly", "shocked", "amazed", "astonished"],
        trust: ["trust", "reliable", "safe", "secure", "confident", "honest", "dependable", "recommend"],
      };
      const tokens = words(text(input, "text"));
      const emotions = Object.entries(lexicon)
        .map(([emotion, cues]) => ({ emotion, hits: tokens.filter((token) => cues.includes(token)).length }))
        .filter((entry) => entry.hits > 0)
        .sort((left, right) => right.hits - left.hits || left.emotion.localeCompare(right.emotion));
      return { dominant: emotions[0]?.emotion ?? "none", emotions };
    },
  },
  {
    name: "Toxicity screener",
    slug: "toxicity_screen",
    category: "text",
    description:
      "Screen user-generated content for insults, harassment, threats and profanity before publishing. Content moderation " +
      "pre-filter that flags text and lists matched categories; pair it with human review.",
    tags: ["moderation", "toxicity", "safety", "ugc", "text"],
    priceUsdc: "0.01",
    p95Ms: 250,
    p50Ms: 60,
    input: textInput,
    required: ["text"],
    example: { text: "You are an idiot and this is garbage." },
    output: s.obj({
      flagged: s.bool(),
      severity: s.enm(["none", "low", "medium", "high"]),
      categories: s.arr(s.obj({ category: s.str(24), matches: s.int(1) }), 4),
    }),
    run(input) {
      const lexicon: Record<string, string[]> = {
        insult: ["idiot", "stupid", "moron", "dumb", "loser", "pathetic", "garbage", "trash", "clown"],
        threat: ["kill", "hurt", "destroy", "attack", "beat", "shoot"],
        profanity: ["damn", "hell", "crap", "shit", "fuck", "fucking", "bastard"],
        harassment: ["shut up", "nobody likes you", "go away", "get lost"],
      };
      const lower = text(input, "text").toLowerCase();
      const tokens = new Set(words(lower));
      const categories = Object.entries(lexicon)
        .map(([category, cues]) => ({
          category,
          matches: cues.filter((cue) => (cue.includes(" ") ? lower.includes(cue) : tokens.has(cue))).length,
        }))
        .filter((entry) => entry.matches > 0);
      const total = categories.reduce((sum, entry) => sum + entry.matches, 0);
      const threat = categories.some((entry) => entry.category === "threat");
      const severity = total === 0 ? "none" : threat || total >= 3 ? "high" : total === 2 ? "medium" : "low";
      return { flagged: total > 0, severity, categories };
    },
  },
  {
    name: "Language detector",
    slug: "language_detect",
    category: "text",
    description:
      "Identify the language of a text snippet: English, Spanish, Catalan, French, German, Italian or Portuguese, with a " +
      "confidence score. Route multilingual support tickets, pick translation pipelines, tag content by locale.",
    tags: ["language", "detection", "multilingual", "i18n", "text"],
    priceUsdc: "0.01",
    p95Ms: 200,
    p50Ms: 40,
    input: textInput,
    required: ["text"],
    example: { text: "Bon dia, voldria saber quan arribarà la meva comanda." },
    output: s.obj({
      language: s.enm(["en", "es", "ca", "fr", "de", "it", "pt", "unknown"]),
      confidence: s.num(0, 1),
      candidates: s.arr(s.obj({ language: s.str(8), score: s.num(0, 1) }), 7),
    }),
    run(input) {
      const profiles: Record<string, string[]> = {
        en: ["the", "and", "is", "to", "of", "you", "that", "it", "for", "with", "when", "my", "will", "what"],
        es: ["el", "la", "que", "de", "y", "en", "los", "es", "por", "una", "para", "cuando", "mi", "pedido", "quiero"],
        ca: ["el", "la", "que", "de", "i", "en", "els", "és", "per", "una", "amb", "quan", "meva", "voldria", "dia"],
        fr: ["le", "la", "et", "les", "des", "est", "une", "pour", "que", "je", "vous", "quand", "ma", "dans"],
        de: ["der", "die", "und", "das", "ist", "nicht", "ich", "sie", "mit", "ein", "wann", "mein", "zu"],
        it: ["il", "la", "che", "di", "e", "è", "per", "una", "non", "sono", "quando", "mio", "vorrei", "del"],
        pt: ["o", "a", "que", "de", "e", "é", "não", "uma", "para", "com", "quando", "meu", "você", "do"],
      };
      const tokens = words(text(input, "text"));
      if (tokens.length === 0) return { language: "unknown", confidence: 0, candidates: [] };
      const scores = Object.entries(profiles).map(([language, cues]) => ({
        language,
        hits: tokens.filter((token) => cues.includes(token)).length,
      }));
      const total = scores.reduce((sum, entry) => sum + entry.hits, 0);
      const ranked = scores
        .map((entry) => ({ language: entry.language, score: total === 0 ? 0 : round(entry.hits / total, 3) }))
        .sort((left, right) => right.score - left.score || left.language.localeCompare(right.language));
      const best = ranked[0];
      if (!best || best.score === 0) return { language: "unknown", confidence: 0, candidates: ranked };
      return { language: best.language, confidence: best.score, candidates: ranked.filter((entry) => entry.score > 0) };
    },
  },
  {
    name: "Slug generator",
    slug: "slugify",
    category: "text",
    description:
      "Convert titles and product names into clean, URL-safe slugs: lowercase, ASCII, hyphen separated, accents removed. " +
      "For CMS permalinks, SEO-friendly URLs, file names and identifiers.",
    tags: ["slug", "url", "seo", "text", "permalink"],
    priceUsdc: "0.01",
    p95Ms: 150,
    p50Ms: 30,
    input: { text: s.str(500, 1), maxLength: s.int(8, 120) },
    required: ["text"],
    example: { text: "Cómo contratar agentes de IA en 2026!" },
    output: s.obj({ slug: s.str(120), length: s.int(0, 120) }),
    run(input) {
      const slug = slugify(text(input, "text"), int(input, "maxLength", 80, 8, 120)) || "untitled";
      return { slug, length: slug.length };
    },
  },
  {
    name: "Line diff",
    slug: "text_diff",
    category: "text",
    description:
      "Compare two versions of a text and list added, removed and unchanged lines (LCS line diff). Track document revisions, " +
      "contract redlines, config changes or prompt edits.",
    tags: ["diff", "compare", "revisions", "text"],
    priceUsdc: "0.01",
    p95Ms: 400,
    p50Ms: 80,
    input: { before: s.str(20_000), after: s.str(20_000) },
    required: ["before", "after"],
    example: { before: "price: 10\ncolor: red\nsize: M", after: "price: 12\ncolor: red\nsize: M\nstock: 4" },
    output: s.obj({
      added: s.int(0),
      removed: s.int(0),
      unchanged: s.int(0),
      changes: s.arr(s.obj({ op: s.enm(["add", "remove"]), line: s.str(500) }), 200),
    }),
    run(input) {
      const before = text(input, "before").split("\n").slice(0, 400);
      const after = text(input, "after").split("\n").slice(0, 400);
      const table: number[][] = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
      for (let i = before.length - 1; i >= 0; i -= 1) {
        for (let j = after.length - 1; j >= 0; j -= 1) {
          const row = table[i] as number[];
          row[j] = before[i] === after[j] ? (table[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(table[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
        }
      }
      const changes: { op: "add" | "remove"; line: string }[] = [];
      let i = 0;
      let j = 0;
      let unchanged = 0;
      let added = 0;
      let removed = 0;
      while (i < before.length || j < after.length) {
        if (i < before.length && j < after.length && before[i] === after[j]) {
          unchanged += 1;
          i += 1;
          j += 1;
        } else if (j < after.length && (i >= before.length || (table[i]?.[j + 1] ?? 0) >= (table[i + 1]?.[j] ?? 0))) {
          added += 1;
          if (changes.length < 200) changes.push({ op: "add", line: clip(after[j] ?? "", 500) });
          j += 1;
        } else {
          removed += 1;
          if (changes.length < 200) changes.push({ op: "remove", line: clip(before[i] ?? "", 500) });
          i += 1;
        }
      }
      return { added, removed, unchanged, changes };
    },
  },
  {
    name: "RAG text chunker",
    slug: "text_chunk",
    category: "text",
    description:
      "Split long documents into overlapping chunks on sentence boundaries for retrieval-augmented generation (RAG), " +
      "embeddings and vector databases. Returns chunk text with character offsets.",
    tags: ["chunking", "rag", "embeddings", "text", "llm"],
    priceUsdc: "0.01",
    p95Ms: 300,
    p50Ms: 60,
    input: { ...textInput, chunkSize: s.int(100, 4000), overlap: s.int(0, 1000) },
    required: ["text"],
    example: { text: SAMPLE_ARTICLE, chunkSize: 200, overlap: 40 },
    output: s.obj({
      chunks: s.arr(s.obj({ index: s.int(0), start: s.int(0), end: s.int(0), text: s.str(4000) }), 200),
      total: s.int(0),
    }),
    run(input) {
      const source = text(input, "text");
      const size = int(input, "chunkSize", 800, 100, 4000);
      const overlap = Math.min(int(input, "overlap", 100, 0, 1000), Math.floor(size / 2));
      const chunks: { index: number; start: number; end: number; text: string }[] = [];
      let start = 0;
      while (start < source.length && chunks.length < 200) {
        let end = Math.min(source.length, start + size);
        if (end < source.length) {
          const window = source.slice(start, end);
          const boundary = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"));
          if (boundary > size / 2) end = start + boundary + 1;
        }
        chunks.push({ index: chunks.length, start, end, text: source.slice(start, end).trim().slice(0, 4000) });
        if (end >= source.length) break;
        start = Math.max(end - overlap, start + 1);
      }
      return { chunks, total: chunks.length };
    },
  },
  {
    name: "Meeting notes formatter",
    slug: "meeting_notes",
    category: "text",
    description:
      "Turn raw meeting notes or a call transcript into a structured recap: summary, decisions, action items with owners " +
      "and open questions. For standups, client calls, sprint reviews and board meetings.",
    tags: ["meetings", "notes", "action-items", "summarize", "productivity"],
    priceUsdc: "0.03",
    p95Ms: 500,
    p50Ms: 150,
    input: { notes: s.str(20_000, 1) },
    required: ["notes"],
    example: {
      notes:
        "Weekly sync. We decided to launch the beta on Monday.\nAnna will update the pricing page.\nTODO: Marc to fix the login bug.\nShould we add Google sign-in?",
    },
    output: s.obj({
      summary: s.str(1000),
      decisions: s.arr(s.str(400), 20),
      actionItems: s.arr(s.obj({ owner: s.str(64), task: s.str(400) }), 30),
      openQuestions: s.arr(s.str(400), 20),
    }),
    run(input) {
      const notes = text(input, "notes");
      const lines = notes.split(/\n|(?<=[.!?])\s+/).map((line) => line.trim()).filter(Boolean);
      const decisions = lines.filter((line) => /\b(decided|agreed|approved|will go with|decision)\b/i.test(line)).slice(0, 20);
      const actionItems = extractActions(lines).slice(0, 30);
      const openQuestions = lines.filter((line) => line.endsWith("?")).slice(0, 20).map((line) => clip(line, 400));
      return {
        summary: clip(extractiveSummary(notes, 2).join(" "), 1000),
        decisions: decisions.map((line) => clip(line, 400)),
        actionItems,
        openQuestions,
      };
    },
  },
  {
    name: "Action item extractor",
    slug: "action_items",
    category: "text",
    description:
      "Find tasks, to-dos and follow-ups in emails, chats, tickets or notes, with the person responsible when mentioned " +
      "(\"Anna will…\", \"TODO: Marc to…\", \"@sam please…\"). Feed task trackers automatically.",
    tags: ["tasks", "todo", "action-items", "productivity", "extract"],
    priceUsdc: "0.015",
    p95Ms: 300,
    p50Ms: 80,
    input: textInput,
    required: ["text"],
    example: { text: "Thanks all. @sam please send the invoice. Laura will review the contract by Friday. TODO: renew the domain." },
    output: s.obj({ actionItems: s.arr(s.obj({ owner: s.str(64), task: s.str(400) }), 50) }),
    run(input) {
      const lines = text(input, "text").split(/\n|(?<=[.!?])\s+/).map((line) => line.trim()).filter(Boolean);
      return { actionItems: extractActions(lines).slice(0, 50) };
    },
  },
  {
    name: "Question extractor",
    slug: "question_extract",
    category: "text",
    description:
      "Pull every question out of an email, interview transcript, chat log or forum thread so none goes unanswered. Flags " +
      "the ones addressed to a named person.",
    tags: ["questions", "extract", "support", "text"],
    priceUsdc: "0.01",
    p95Ms: 200,
    p50Ms: 50,
    input: textInput,
    required: ["text"],
    example: { text: "Hi team. Can you share the Q3 numbers? Also, Maria, when is the launch? Thanks." },
    output: s.obj({ questions: s.arr(s.obj({ question: s.str(500), addressee: s.str(64) }), 50) }),
    run(input) {
      const parts = text(input, "text").match(/[^.!?\n]*\?/g) ?? [];
      return {
        questions: parts
          .map((part) => part.trim())
          .filter((part) => part.length > 1)
          .slice(0, 50)
          .map((question) => {
            const named = /(?:^|,\s*|also,?\s*)([A-Z][a-z]+),/.exec(question);
            return { question: clip(question, 500), addressee: named?.[1] ?? "" };
          }),
      };
    },
  },
  {
    name: "Pros and cons extractor",
    slug: "pros_cons",
    category: "research",
    description:
      "Split reviews, feedback or a product comparison into pros and cons lists using opinion cues. Quick decision support " +
      "for vendor evaluation, product research and review mining.",
    tags: ["pros-cons", "reviews", "research", "opinion"],
    priceUsdc: "0.015",
    p95Ms: 300,
    p50Ms: 80,
    input: textInput,
    required: ["text"],
    example: { text: "Battery life is great and the screen is bright. However, it is expensive and the charger is slow." },
    output: s.obj({ pros: s.arr(s.str(300), 20), cons: s.arr(s.str(300), 20) }),
    run(input) {
      const clauses = text(input, "text")
        .split(/[.!?;\n]|,\s*(?:but|however)\s*|\b(?:but|however|although|while)\b/i)
        .map((part) => part.trim().replace(/^(and|also)\s+/i, ""))
        .filter((part) => part.length > 2);
      const pros: string[] = [];
      const cons: string[] = [];
      for (const clause of clauses) {
        const score = sentimentScore(clause);
        const hasNegative = words(clause).some((word) => NEGATIVE.has(word));
        if (score.score > 0) pros.push(clip(clause, 300));
        else if (score.score < 0 || hasNegative) cons.push(clip(clause, 300));
      }
      return { pros: pros.slice(0, 20), cons: cons.slice(0, 20) };
    },
  },
  {
    name: "Text case converter",
    slug: "case_convert",
    category: "utility",
    description:
      "Convert text or identifiers between camelCase, PascalCase, snake_case, kebab-case, CONSTANT_CASE, Title Case, " +
      "UPPER and lower case. Handy for code generation, column renaming and API field mapping.",
    tags: ["case", "naming", "code", "text", "utility"],
    priceUsdc: "0.01",
    p95Ms: 150,
    p50Ms: 30,
    input: { text: s.str(5000, 1), to: s.enm(["camel", "pascal", "snake", "kebab", "constant", "title", "upper", "lower"]) },
    required: ["text", "to"],
    example: { text: "customer billing address", to: "camel" },
    output: s.obj({ result: s.str(5000), to: s.str(16) }),
    run(input) {
      const source = text(input, "text");
      const to = oneOf(input, "to", ["camel", "pascal", "snake", "kebab", "constant", "title", "upper", "lower"] as const, "snake");
      const parts = source
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((part) => part.toLowerCase());
      const cap = (part: string) => part.charAt(0).toUpperCase() + part.slice(1);
      const result =
        to === "camel"
          ? parts.map((part, index) => (index === 0 ? part : cap(part))).join("")
          : to === "pascal"
            ? parts.map(cap).join("")
            : to === "snake"
              ? parts.join("_")
              : to === "kebab"
                ? parts.join("-")
                : to === "constant"
                  ? parts.join("_").toUpperCase()
                  : to === "title"
                    ? titleCase(source)
                    : to === "upper"
                      ? source.toUpperCase()
                      : source.toLowerCase();
      return { result: clip(result, 5000), to };
    },
  },
];

function extractActions(lines: readonly string[]): { owner: string; task: string }[] {
  const items: { owner: string; task: string }[] = [];
  for (const raw of lines) {
    const line = raw.replace(/^[-*•\d.)\s]+/, "").trim();
    let match = /^(?:TODO|Action|AI)\s*[:-]\s*(?:([A-Z][a-z]+)\s+to\s+)?(.+)$/i.exec(line);
    if (match) {
      items.push({ owner: match[1] ?? "", task: clip((match[2] ?? "").replace(/[.!]+$/, ""), 400) });
      continue;
    }
    match = /@([A-Za-z][\w-]*)\s+(?:please\s+)?(.+)$/.exec(line);
    if (match) {
      items.push({ owner: match[1] ?? "", task: clip((match[2] ?? "").replace(/[.!]+$/, ""), 400) });
      continue;
    }
    match = /\b([A-Z][a-z]+)\s+(?:will|should|needs to|is going to|to)\s+(.+)$/.exec(line);
    if (match && !/^(We|I|It|This|That|They|You)$/.test(match[1] ?? "")) {
      items.push({ owner: match[1] ?? "", task: clip((match[2] ?? "").replace(/[.!]+$/, ""), 400) });
    }
  }
  return items.filter((item) => item.task.length > 0);
}

