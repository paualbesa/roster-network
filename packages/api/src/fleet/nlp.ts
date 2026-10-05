/** Small offline NLP helpers shared by the fleet tools. */

export const STOPWORDS = new Set(
  (
    "a about above after again against all am an and any are as at be because been before being below between both but by " +
    "can could did do does doing down during each few for from further had has have having he her here hers herself him " +
    "himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other " +
    "our ours ourselves out over own same she should so some such than that the their theirs them themselves then there " +
    "these they this those through to too under until up very was we were what when where which while who whom why will " +
    "with would you your yours yourself yourselves also may might must shall us via per etc"
  ).split(" "),
);

export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
}

export function contentWords(text: string): string[] {
  return words(text).filter((word) => word.length > 2 && !STOPWORDS.has(word) && !/^\d+$/.test(word));
}

export function sentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  return (normalized.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [normalized]).map((part) => part.trim()).filter(Boolean);
}

export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function frequencies(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

export function topTerms(text: string, limit: number): { term: string; count: number }[] {
  return [...frequencies(contentWords(text)).entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([term, count]) => ({ term, count }));
}

/**
 * Extractive summary: score sentences by content-word frequency, keep the
 * best `limit` in original order.
 */
export function extractiveSummary(text: string, limit: number): string[] {
  const all = sentences(text);
  if (all.length <= limit) return all;
  const counts = frequencies(contentWords(text));
  const scored = all.map((sentence, index) => {
    const tokens = contentWords(sentence);
    const score = tokens.reduce((sum, token) => sum + (counts.get(token) ?? 0), 0) / Math.max(4, tokens.length);
    return { sentence, index, score: score + (index === 0 ? 0.5 : 0) };
  });
  return scored
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.sentence);
}

export function syllables(word: string): number {
  const cleaned = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!cleaned) return 0;
  if (cleaned.length <= 3) return 1;
  const trimmed = cleaned.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

export const POSITIVE = new Set(
  (
    "good great excellent amazing awesome love loved lovely like liked happy pleased fantastic perfect best better wonderful " +
    "nice fast helpful recommend recommended easy smooth reliable friendly delighted superb outstanding brilliant impressive " +
    "satisfied enjoy enjoyed glad positive quick clean beautiful efficient stable affordable valuable thanks thank solid"
  ).split(" "),
);

export const NEGATIVE = new Set(
  (
    "bad terrible awful horrible hate hated poor worst worse slow broken bug bugs buggy crash crashed crashes disappointed " +
    "disappointing annoying useless expensive difficult hard confusing problem problems issue issues fail failed failure " +
    "refund angry rude dirty late never wrong error errors unhappy frustrating frustrated unreliable unstable missing scam"
  ).split(" "),
);

export const NEGATORS = new Set(["not", "no", "never", "hardly", "isn't", "wasn't", "don't", "doesn't", "didn't", "can't", "won't"]);

/** Lexicon sentiment in [-1, 1] with simple negation handling. */
export function sentimentScore(text: string): { score: number; positive: number; negative: number } {
  const tokens = words(text);
  let positive = 0;
  let negative = 0;
  tokens.forEach((token, index) => {
    const previous = tokens[index - 1] ?? "";
    const flipped = NEGATORS.has(previous);
    if (POSITIVE.has(token)) {
      if (flipped) negative += 1;
      else positive += 1;
    } else if (NEGATIVE.has(token)) {
      if (flipped) positive += 1;
      else negative += 1;
    }
  });
  const total = positive + negative;
  const score = total === 0 ? 0 : (positive - negative) / total;
  return { score: Math.round(score * 1000) / 1000, positive, negative };
}

export function titleCase(text: string): string {
  const minor = new Set(["a", "an", "the", "and", "or", "but", "of", "in", "on", "at", "to", "for", "by", "with"]);
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index) => (index > 0 && minor.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

export function slugify(text: string, max = 80): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}
