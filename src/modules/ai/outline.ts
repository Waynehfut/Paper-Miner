/**
 * Slide-outline parsing and normalisation.
 *
 * LLMs are unreliable JSON generators, so this module extracts the first
 * balanced JSON object from the response, repairs common damage (code fences,
 * smart quotes, trailing commas) and normalises every field to the outline
 * shape used by `ppt.ts`. When parsing fails we still return a useful
 * metadata-based outline instead of throwing.
 */

import type { PaperMeta } from "../../types";
import {
  stripCodeFence,
  stripControlCharacters,
  type OutputLanguage,
} from "./prompts";

export interface PptSlideOutline {
  title: string;
  bullets: string[];
  speakerNotes?: string;
}

export interface PptOutline {
  title: string;
  subtitle: string;
  slides: PptSlideOutline[];
}

/** Bullets per slide: keep decks readable and avoid overflowing the text box. */
export const PPT_MAX_BULLETS = 6;
export const PPT_MIN_BULLETS = 3;
/** Maximum display width (CJK = 2, latin = 1) of one bullet. */
export const PPT_MAX_BULLET_WIDTH = 120;
export const PPT_MAX_TITLE_WIDTH = 64;

const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

/** Terminal width of a string, counting CJK characters as two columns. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of Array.from(String(text || ""))) {
    const code = char.codePointAt(0) || 0;
    width += WIDE_RANGES.some(([start, end]) => code >= start && code <= end)
      ? 2
      : 1;
  }
  return width;
}

/** Truncate to `maxWidth` display columns, appending an ellipsis. */
export function truncateDisplay(text: string, maxWidth: number): string {
  const source = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!source) return "";
  if (displayWidth(source) <= maxWidth) return source;
  let width = 0;
  let result = "";
  for (const char of Array.from(source)) {
    const code = char.codePointAt(0) || 0;
    const charWidth = WIDE_RANGES.some(
      ([start, end]) => code >= start && code <= end,
    )
      ? 2
      : 1;
    if (width + charWidth > maxWidth - 1) break;
    result += char;
    width += charWidth;
  }
  return `${result.trimEnd()}…`;
}

function stripInlineMarkdown(text: string): string {
  return String(text || "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function cleanSlideTitle(value: unknown): string {
  let text = stripInlineMarkdown(asText(value));
  text = text
    .replace(/^(?:slide|幻灯片|第)\s*\d+\s*[.、:：-]?\s*/i, "")
    .replace(/^\d+\s*[.、)]\s*/, "");
  return truncateDisplay(text, PPT_MAX_TITLE_WIDTH);
}

function cleanBullet(value: unknown): string {
  let text = stripInlineMarkdown(asText(value));
  text = text.replace(/^\s*(?:[-*•·●▪◦]|\d+[.)、])\s*/, "");
  text = text.replace(/[。；;]+$/, "").trim();
  return truncateDisplay(text, PPT_MAX_BULLET_WIDTH);
}

/** Flatten nested arrays/objects into a list of bullet strings. */
function collectBulletStrings(value: unknown, depth = 0): string[] {
  if (value === null || value === undefined || depth > 3) return [];
  if (typeof value === "string") return value.split(/\n+/);
  if (typeof value === "number" && Number.isFinite(value)) {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectBulletStrings(item, depth + 1));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const candidate =
      record.text ??
      record.content ??
      record.point ??
      record.value ??
      record.title;
    if (candidate !== undefined) {
      return collectBulletStrings(candidate, depth + 1);
    }
  }
  return [];
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function normalizeSlide(
  raw: unknown,
  language: OutputLanguage,
): PptSlideOutline | null {
  if (typeof raw === "string") {
    const title = cleanSlideTitle(raw);
    return title ? { title, bullets: [] } : null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const title = cleanSlideTitle(
    record.title ??
      record.heading ??
      record.name ??
      record.slideTitle ??
      record.caption,
  );
  const bulletSource =
    record.bullets ??
    record.points ??
    record.items ??
    record.content ??
    record.list ??
    record.body ??
    [];
  const bullets = dedupe(
    collectBulletStrings(bulletSource).map(cleanBullet).filter(Boolean),
  ).slice(0, PPT_MAX_BULLETS);
  if (!title && !bullets.length) return null;
  const notesRaw =
    record.speakerNotes ?? record.notes ?? record.speaker_notes ?? record.note;
  const speakerNotes =
    typeof notesRaw === "string" ? truncateDisplay(notesRaw, 600) : undefined;
  return {
    title: title || (language === "zh" ? "要点" : "Key Points"),
    bullets,
    ...(speakerNotes ? { speakerNotes } : {}),
  };
}

function defaultSubtitle(meta: PaperMeta, language: OutputLanguage): string {
  const fromMeta = [meta.journal, meta.year].filter(Boolean).join(" · ");
  if (fromMeta) return truncateDisplay(fromMeta, 100);
  return language === "zh"
    ? "基于论文内容生成"
    : "Generated from paper content";
}

function splitSentences(text: string): string[] {
  const source = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!source) return [];
  const matches = source.match(/[^.!?。！？]+[.!?。！？]?/g) || [];
  return matches
    .map((sentence) => sentence.trim())
    .filter((sentence) => displayWidth(sentence) >= 12);
}

/**
 * Build a usable outline from metadata/abstract. Used when the model output
 * cannot be parsed or when the model returns an empty outline.
 */
export function buildFallbackOutline(
  meta: PaperMeta,
  slideCount: number,
  language: OutputLanguage,
): PptOutline {
  const zh = language === "zh";
  const title = truncateDisplay(
    meta.title || (zh ? "论文阅读" : "Paper Reading"),
    100,
  );
  const subtitle = defaultSubtitle(meta, language);
  const slides: PptSlideOutline[] = [];

  const overview: string[] = [];
  if (meta.authors) {
    overview.push(
      `${zh ? "作者" : "Authors"}: ${truncateDisplay(meta.authors, 90)}`,
    );
  }
  const publication = [meta.journal, meta.year].filter(Boolean).join(" · ");
  if (publication) overview.push(publication);
  if (meta.doi) overview.push(`DOI: ${truncateDisplay(meta.doi, 70)}`);
  if (!overview.length) overview.push(title);
  slides.push({
    title: zh ? "论文概况" : "Paper Overview",
    bullets: overview.slice(0, PPT_MAX_BULLETS),
  });

  const abstractBullets = splitSentences(meta.abstract)
    .slice(0, PPT_MAX_BULLETS)
    .map((sentence) => truncateDisplay(sentence, PPT_MAX_BULLET_WIDTH))
    .filter(Boolean);
  if (abstractBullets.length) {
    slides.push({
      title: zh ? "摘要要点" : "Abstract Highlights",
      bullets: dedupe(abstractBullets),
    });
  }

  slides.push({
    title: zh ? "阅读提示" : "Reading Notes",
    bullets: zh
      ? [
          "AI 未能生成结构化大纲，本页依据论文元数据自动生成。",
          "建议结合原文的方法与实验部分补充内容。",
        ]
      : [
          "Structured outline generation failed; this deck is built from paper metadata.",
          "Add methods and experiments from the paper manually.",
        ],
  });

  return {
    title,
    subtitle,
    slides: slides.slice(0, Math.max(1, Math.min(slideCount, 30))),
  };
}

export interface OutlineNormalizeOptions {
  meta: PaperMeta;
  slideCount: number;
  language: OutputLanguage;
}

/**
 * Coerce arbitrary parsed JSON into a valid outline. Never throws; falls back
 * to metadata when the shape is unusable.
 */
export function normalizeOutline(
  input: unknown,
  options: OutlineNormalizeOptions,
): PptOutline {
  const { meta, slideCount, language } = options;
  const limit = Math.max(1, Math.min(slideCount || 10, 30));

  let root: Record<string, unknown> | null = null;
  if (Array.isArray(input)) {
    root = { slides: input };
  } else if (input && typeof input === "object") {
    root = input as Record<string, unknown>;
  }
  if (!root) return buildFallbackOutline(meta, limit, language);

  const slidesRaw =
    root.slides ?? root.pages ?? root.outline ?? root.items ?? root.content;
  let raws: unknown[] = [];
  if (Array.isArray(slidesRaw)) {
    raws = slidesRaw;
  } else if (slidesRaw && typeof slidesRaw === "object") {
    raws = [slidesRaw];
  } else if (root.title !== undefined || root.bullets !== undefined) {
    // A single slide returned as a bare object.
    raws = [root];
  }

  const slides = raws
    .map((raw) => normalizeSlide(raw, language))
    .filter((slide): slide is PptSlideOutline => Boolean(slide))
    .slice(0, limit);

  const deckTitle =
    truncateDisplay(
      stripInlineMarkdown(asText(root.title ?? root.name ?? root.deckTitle)),
      100,
    ) ||
    truncateDisplay(
      meta.title || (language === "zh" ? "论文阅读" : "Paper Reading"),
      100,
    );
  const subtitleRaw = truncateDisplay(
    stripInlineMarkdown(asText(root.subtitle ?? root.description)),
    100,
  );
  const subtitle = subtitleRaw || defaultSubtitle(meta, language);

  if (!slides.length) return buildFallbackOutline(meta, limit, language);
  return { title: deckTitle, subtitle, slides };
}

function tryParseJson(candidate: string): unknown {
  const attempts = [
    candidate,
    repairJson(candidate),
    repairJsonWithSmartQuotes(candidate),
  ];
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // try next variant
    }
  }
  return undefined;
}

function repairJson(text: string): string {
  return stripControlCharacters(text).replace(/,\s*([}\]])/g, "$1");
}

/**
 * Some models emit curly quotes as JSON delimiters. Only try this after the
 * plain repairs failed, because curly quotes are valid string content.
 */
function repairJsonWithSmartQuotes(text: string): string {
  return repairJson(text)
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
}

function sliceBalanced(
  text: string,
  start: number,
  open: string,
  close: string,
): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * Extract the first balanced JSON object/array from a model answer.
 * Returns `null` when no valid JSON can be recovered.
 */
export function extractJsonValue(raw: string): unknown {
  const text = stripCodeFence(raw);
  if (!text) return null;

  const objectCandidates: string[] = [];
  const arrayCandidates: string[] = [];
  const objectStart = text.indexOf("{");
  if (objectStart >= 0) {
    const balanced = sliceBalanced(text, objectStart, "{", "}");
    if (balanced) objectCandidates.push(balanced);
    const lastBrace = text.lastIndexOf("}");
    if (lastBrace > objectStart) {
      objectCandidates.push(text.slice(objectStart, lastBrace + 1));
    }
  }
  const arrayStart = text.indexOf("[");
  if (arrayStart >= 0) {
    const balanced = sliceBalanced(text, arrayStart, "[", "]");
    if (balanced) arrayCandidates.push(balanced);
    const lastBracket = text.lastIndexOf("]");
    if (lastBracket > arrayStart) {
      arrayCandidates.push(text.slice(arrayStart, lastBracket + 1));
    }
  }

  // If the answer starts with an array, try the whole array before the first
  // inner object, otherwise `[{...}, {...}]` would be reduced to one slide.
  const arrayFirst =
    arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart);
  const candidates = arrayFirst
    ? [...arrayCandidates, ...objectCandidates]
    : [...objectCandidates, ...arrayCandidates];

  for (const candidate of dedupe(candidates)) {
    const parsed = tryParseJson(candidate.trim());
    if (parsed !== undefined) return parsed;
  }
  return null;
}

/**
 * Parse the LLM outline response into a usable outline, falling back to
 * metadata when the answer is not valid JSON.
 */
export function parsePptOutline(
  raw: string,
  options: OutlineNormalizeOptions,
): PptOutline {
  const parsed = extractJsonValue(raw);
  if (parsed === undefined || parsed === null) {
    return buildFallbackOutline(
      options.meta,
      options.slideCount,
      options.language,
    );
  }
  return normalizeOutline(parsed, options);
}
