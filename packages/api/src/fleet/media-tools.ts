import { clip, s, strings, text, type FleetTool } from "./kit.js";
import { contentWords, titleCase } from "./nlp.js";

const COLOR_WORDS = ["red", "blue", "green", "yellow", "black", "white", "orange", "purple", "pink", "gray", "grey", "brown", "gold", "silver"];

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function inlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g, (_match, label: string, href: string) => `<a href="${href}" rel="nofollow noopener">${label}</a>`);
}

export const mediaTools: FleetTool[] = [
  {
    name: "Image caption and alt-text writer",
    slug: "image_caption",
    category: "media",
    description:
      "Write an accessible image caption and alt text (under 125 characters) from what is known about an image: file name, " +
      "page context, subject tags and colors. Accessibility (WCAG) and image SEO for CMS uploads, e-commerce photos and " +
      "social posts. Sandbox version: metadata-based, no vision model.",
    tags: ["image-captioning", "alt-text", "accessibility", "seo", "images"],
    priceUsdc: "0.02",
    p95Ms: 250,
    p50Ms: 60,
    input: { imageUrl: s.str(2048), filename: s.str(255), context: s.str(2000), tags: s.arr(s.str(40), 20) },
    required: [],
    example: { imageUrl: "https://example.com/uploads/red-trail-backpack-mountain.jpg", context: "Product page for a 30L hiking backpack", tags: ["backpack", "mountain", "outdoor"] },
    output: s.obj({ altText: s.str(125), caption: s.str(300), keywords: s.arr(s.str(40), 10), confidence: s.enm(["low", "medium"]) }),
    run(input) {
      const url = text(input, "imageUrl");
      const filename = text(input, "filename") || url.split(/[?#]/)[0]?.split("/").pop() || "";
      const fromName = filename
        .replace(/\.[a-z0-9]{2,5}$/i, "")
        .replace(/[_\-.]+/g, " ")
        .replace(/\b(img|image|photo|pic|dsc|screenshot|final|copy|\d+)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      const tags = strings(input, "tags", 20, 40).map((tag) => tag.toLowerCase());
      const context = text(input, "context");
      const nameWords = contentWords(fromName);
      const subject = [...new Set([...nameWords, ...tags])].slice(0, 6);
      const colors = subject.filter((word) => COLOR_WORDS.includes(word));
      const nouns = subject.filter((word) => !COLOR_WORDS.includes(word));
      const main = nouns[0] ?? contentWords(context)[0] ?? "image";
      const setting = nouns.slice(1, 3);
      const altText = clip(`${colors.length > 0 ? `${colors[0] ?? ""} ` : ""}${nouns.length > 0 ? main : "image"}${setting.length > 0 ? ` with ${setting.join(" and ")}` : ""}`.replace(/^\w/, (char) => char.toUpperCase()), 125);
      const caption = clip(`${altText}.${context ? ` ${context.split(/[.!?]/)[0]?.trim() ?? ""}.` : ""}`.replace(/\.\./g, "."), 300);
      return { altText, caption, keywords: subject.slice(0, 10).map((word) => clip(word, 40)), confidence: subject.length >= 3 ? "medium" : "low" };
    },
  },
  {
    name: "Image header inspector",
    slug: "image_inspect",
    category: "media",
    description:
      "Read image metadata from base64 bytes without decoding pixels: format (PNG, JPEG, GIF, WebP, BMP), width, height, " +
      "aspect ratio, orientation and file size. Validate uploads, enforce dimension rules and pick responsive sizes.",
    tags: ["images", "metadata", "validation", "uploads", "media"],
    priceUsdc: "0.01",
    p95Ms: 150,
    p50Ms: 30,
    input: { base64: s.str(200_000, 1) },
    required: ["base64"],
    example: { base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
    output: s.obj({
      format: s.enm(["png", "jpeg", "gif", "webp", "bmp", "unknown"]),
      width: s.int(0),
      height: s.int(0),
      aspectRatio: s.str(16),
      orientation: s.enm(["landscape", "portrait", "square", "unknown"]),
      bytes: s.int(0),
    }),
    run(input) {
      const raw = text(input, "base64").replace(/^data:[^,]*,/, "").replace(/\s/g, "").slice(0, 200_000);
      let bytes: Buffer;
      try {
        bytes = Buffer.from(raw, "base64");
      } catch {
        bytes = Buffer.alloc(0);
      }
      const info = readImageHeader(bytes);
      const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
      const divisor = info.width > 0 && info.height > 0 ? gcd(info.width, info.height) : 1;
      return {
        format: info.format,
        width: info.width,
        height: info.height,
        aspectRatio: info.width > 0 && info.height > 0 ? `${(info.width / divisor).toString()}:${(info.height / divisor).toString()}` : "",
        orientation: info.width === 0 || info.height === 0 ? "unknown" : info.width === info.height ? "square" : info.width > info.height ? "landscape" : "portrait",
        bytes: bytes.length,
      };
    },
  },
  {
    name: "Markdown to HTML converter",
    slug: "markdown_html",
    category: "media",
    description:
      "Convert Markdown (headings, paragraphs, bold, italic, inline code, code blocks, lists, links, blockquotes) to safe, " +
      "escaped HTML with no script injection. Render READMEs, release notes, emails and CMS content.",
    tags: ["markdown", "html", "convert", "content", "docs"],
    priceUsdc: "0.01",
    p95Ms: 200,
    p50Ms: 40,
    input: { markdown: s.str(100_000, 1) },
    required: ["markdown"],
    example: { markdown: "# Roster Fleet\n\nHire **80+** agents with `USDC` escrow.\n\n- CSV cleaner\n- Code review\n\n[Docs](https://roster.network/docs)" },
    output: s.obj({ html: s.str(200_000), headings: s.arr(s.str(200), 50) }),
    run(input) {
      const lines = String(input.markdown ?? "").slice(0, 100_000).split("\n");
      const out: string[] = [];
      const headings: string[] = [];
      let list: "ul" | "ol" | null = null;
      let code = false;
      let paragraph: string[] = [];
      const flush = () => {
        if (paragraph.length > 0) out.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
        paragraph = [];
      };
      const closeList = () => {
        if (list) out.push(`</${list}>`);
        list = null;
      };
      for (const line of lines) {
        if (line.trim().startsWith("```")) {
          flush();
          closeList();
          out.push(code ? "</code></pre>" : "<pre><code>");
          code = !code;
          continue;
        }
        if (code) {
          out.push(escapeHtml(line));
          continue;
        }
        const heading = /^(#{1,6})\s+(.+)$/.exec(line);
        const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
        const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
        const quote = /^>\s?(.*)$/.exec(line);
        if (heading) {
          flush();
          closeList();
          const level = heading[1]?.length ?? 1;
          if (headings.length < 50) headings.push(clip(heading[2] ?? "", 200));
          out.push(`<h${level.toString()}>${inlineMarkdown(heading[2] ?? "")}</h${level.toString()}>`);
        } else if (bullet || ordered) {
          flush();
          const kind = bullet ? "ul" : "ol";
          if (list !== kind) {
            closeList();
            out.push(`<${kind}>`);
            list = kind;
          }
          out.push(`<li>${inlineMarkdown((bullet ?? ordered)?.[1] ?? "")}</li>`);
        } else if (quote) {
          flush();
          closeList();
          out.push(`<blockquote>${inlineMarkdown(quote[1] ?? "")}</blockquote>`);
        } else if (line.trim() === "") {
          flush();
          closeList();
        } else {
          closeList();
          paragraph.push(line.trim());
        }
      }
      flush();
      closeList();
      if (code) out.push("</code></pre>");
      return { html: clip(out.join("\n"), 200_000), headings };
    },
  },
  {
    name: "HTML to plain text",
    slug: "html_text",
    category: "media",
    description:
      "Strip HTML to clean readable plain text: removes scripts, styles and tags, decodes entities, keeps paragraph breaks " +
      "and lists links separately. Prepare web pages and emails for LLMs, search indexing, summarization or text-to-speech.",
    tags: ["html", "text", "scraping", "cleaning", "llm"],
    priceUsdc: "0.01",
    p95Ms: 200,
    p50Ms: 40,
    input: { html: s.str(300_000, 1) },
    required: ["html"],
    example: { html: "<h1>Roster</h1><p>Agents hire agents.<br>Paid in <b>USDC</b>.</p><script>track()</script><a href='https://roster.network/docs'>Docs</a>" },
    output: s.obj({ text: s.str(200_000), links: s.arr(s.obj({ text: s.str(200), href: s.str(2048) }), 200), words: s.int(0) }),
    run(input) {
      const html = String(input.html ?? "").slice(0, 300_000);
      const links = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].slice(0, 200).map((match) => ({ text: clip((match[2] ?? "").replace(/<[^>]+>/g, "").trim(), 200), href: clip(match[1] ?? "", 2048) }));
      const plain = html
        .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|blockquote)>/gi, "\n")
        .replace(/<li[^>]*>/gi, "• ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/[ \t]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      return { text: clip(plain, 200_000), links, words: (plain.match(/\S+/g) ?? []).length };
    },
  },
  {
    name: "Podcast show notes writer",
    slug: "show_notes",
    category: "media",
    description:
      "Turn a podcast or video transcript with timestamps into show notes: episode title, summary, chapter markers, key " +
      "quotes and mentioned links. YouTube descriptions, podcast feeds and newsletter recaps.",
    tags: ["podcast", "video", "transcript", "show-notes", "content"],
    priceUsdc: "0.04",
    p95Ms: 500,
    p50Ms: 120,
    input: { transcript: s.str(100_000, 1), title: s.str(200) },
    required: ["transcript"],
    example: {
      transcript: "[00:00] Welcome to Agent Economy. Today we talk about escrow.\n[02:15] Pau explains why SLA refunds matter: \"Buyers should never chase a refund.\"\n[10:40] We discuss reputation passports. More at https://roster.network",
      title: "Escrow for agents",
    },
    output: s.obj({
      title: s.str(200),
      summary: s.str(1500),
      chapters: s.arr(s.obj({ time: s.str(12), title: s.str(120) }), 50),
      quotes: s.arr(s.str(300), 10),
      links: s.arr(s.str(2048), 20),
    }),
    run(input) {
      const transcript = String(input.transcript ?? "").slice(0, 100_000);
      const chapters = [...transcript.matchAll(/\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s+([^\n]+)/g)].slice(0, 50).map((match) => ({
        time: clip(match[1] ?? "", 12),
        title: clip(titleCase((match[2] ?? "").split(/[.!?:]/)[0]?.split(/\s+/).slice(0, 8).join(" ") ?? ""), 120),
      }));
      const plain = transcript.replace(/\[?\d{1,2}:\d{2}(?::\d{2})?\]?/g, " ").replace(/\s+/g, " ").trim();
      const quotes = [...plain.matchAll(/["“]([^"”]{12,280})["”]/g)].slice(0, 10).map((match) => clip(match[1] ?? "", 300));
      const links = [...new Set(plain.match(/https?:\/\/[^\s)\]]+/g) ?? [])].slice(0, 20).map((link) => clip(link.replace(/[.,;]+$/, ""), 2048));
      const summarySentences = plain.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.length > 20).slice(0, 3);
      return {
        title: clip(text(input, "title").trim() || (chapters[0]?.title ?? "Episode"), 200),
        summary: clip(summarySentences.join(" "), 1500),
        chapters,
        quotes,
        links,
      };
    },
  },
];

function readImageHeader(bytes: Buffer): { format: "png" | "jpeg" | "gif" | "webp" | "bmp" | "unknown"; width: number; height: number } {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return { format: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 10 && bytes.toString("ascii", 0, 3) === "GIF") {
    return { format: "gif", width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (bytes.length >= 26 && bytes.toString("ascii", 0, 2) === "BM") {
    return { format: "bmp", width: Math.abs(bytes.readInt32LE(18)), height: Math.abs(bytes.readInt32LE(22)) };
  }
  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { format: "webp", width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (chunk === "VP8 ") return { format: "webp", width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L" && bytes.length >= 25) {
      const bits = bytes.readUInt32LE(21);
      return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { format: "webp", width: 0, height: 0 };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1] ?? 0;
      const length = bytes.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: "jpeg", width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
      }
      if (length < 2) break;
      offset += 2 + length;
    }
    return { format: "jpeg", width: 0, height: 0 };
  }
  return { format: "unknown", width: 0, height: 0 };
}
