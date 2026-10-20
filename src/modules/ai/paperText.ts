/**
 * Paper text extraction for AI features.
 *
 * Order of preference:
 *   1. the indexed full text of the item's PDF attachment;
 *   2. an on-demand `Zotero.PDFWorker` extraction when the index is missing;
 *   3. the abstract, when the item has no PDF attachment.
 *
 * Extracted text is cached per item for the whole session so a paper is only
 * parsed once, no matter how many AI actions the user triggers.
 */

import type { PaperContext, PaperMeta } from "../../types";
import { errorToString, log } from "../../utils/log";
import { getNumberPref, getPref } from "../../utils/prefs";
import {
  findPDFAttachment,
  getItemMeta,
  getItemTitle,
  getRegularItemForReader,
} from "../../utils/item";
import { stripControlCharacters } from "./prompts";

export interface PaperTextResult {
  text: string;
  attachmentID?: number;
  /** Always false: the extractor keeps the full text (callers truncate). */
  truncated: boolean;
  fullTextLength: number;
  /** Where the text came from, so callers can label the context. */
  source: "pdf" | "abstract";
}

/** Text result plus provenance; assignable to `PaperContext`. */
export type PaperContextWithSource = PaperContext & {
  source?: "pdf" | "abstract";
};

const textCache = new Map<string, Promise<PaperTextResult>>();
const DEFAULT_CONTEXT_CHARS = 60000;

interface ResolvedPaperItem {
  regular: Zotero.Item | null;
  attachment: Zotero.Item | null;
}

function resolvePaperItem(
  item: Zotero.Item | null | undefined,
): ResolvedPaperItem {
  if (!item) return { regular: null, attachment: null };
  if (item.isRegularItem()) return { regular: item, attachment: null };
  if (item.isAttachment()) {
    const regular = getRegularItemForReader(item);
    return { regular, attachment: null };
  }
  return { regular: null, attachment: null };
}

async function resolveAttachment(
  resolved: ResolvedPaperItem,
  original: Zotero.Item,
): Promise<Zotero.Item | null> {
  if (
    original.isAttachment() &&
    original.attachmentContentType === "application/pdf"
  ) {
    return original;
  }
  if (resolved.regular) return findPDFAttachment(resolved.regular);
  return null;
}

function buildMeta(
  regular: Zotero.Item | null,
  fallback: Zotero.Item,
): PaperMeta {
  if (regular) return getItemMeta(regular);
  return {
    itemID: fallback.id,
    key: fallback.key,
    title: getItemTitle(fallback),
    doi: "",
    journal: "",
    year: "",
    authors: "",
    abstract: "",
    itemType: fallback.isAttachment() ? "attachment" : "unknown",
  };
}

/** Abstract of a paper item, or "" when there is none. */
function getAbstract(regular: Zotero.Item | null): string {
  if (!regular) return "";
  try {
    return String(regular.getField("abstractNote") || "").trim();
  } catch {
    return "";
  }
}

/**
 * Clean PDF-extracted text: normalise line endings, undo hyphenation across
 * line breaks, drop page numbers and repeated running headers/footers, and
 * reflow hard-wrapped lines into readable paragraphs.
 */
export function cleanExtractedText(raw: string): string {
  let text = stripControlCharacters(
    String(raw || "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/\u00ad/g, ""),
  );

  // Join words hyphenated at a line break ("informa-\ntion").
  text = text.replace(/([a-zà-öø-ÿ])-\n([a-zà-öø-ÿ])/g, "$1$2");

  const lines = text.split("\n");
  const counts = new Map<string, number>();
  const isPageNumber = (line: string) =>
    /^\s*(?:page\s*)?\d{1,4}\s*$/i.test(line) ||
    /^\s*[-–—]\s*\d{1,4}\s*[-–—]\s*$/.test(line);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || isPageNumber(trimmed)) continue;
    const key = trimmed.toLowerCase().replace(/\s+/g, " ");
    if (key.length > 90) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const filtered: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      filtered.push("");
      continue;
    }
    if (isPageNumber(trimmed)) continue;
    const key = trimmed.toLowerCase().replace(/\s+/g, " ");
    const repeated = (counts.get(key) || 0) >= 4 && key.length <= 90;
    // Repeated running headers/footers are not sentences; keep sentence-like
    // repeated lines (e.g. a shared data-availability statement).
    if (repeated && !/[.!?。！？]$/.test(trimmed)) continue;
    filtered.push(trimmed);
  }

  // Reflow hard-wrapped body lines. Only join lines long enough to be body
  // text, so short headings stay separate.
  const reflowed: string[] = [];
  for (const line of filtered) {
    const previous = reflowed[reflowed.length - 1];
    if (
      previous !== undefined &&
      previous !== "" &&
      line !== "" &&
      previous.length >= 40 &&
      !/[.!?。！？:：;；)\]}"'”’]$/.test(previous) &&
      (/^\p{Ll}/u.test(line) || /^[\u4e00-\u9fff]/.test(line))
    ) {
      const joiner = /[\u4e00-\u9fff]$/.test(previous) ? "" : " ";
      reflowed[reflowed.length - 1] = `${previous}${joiner}${line}`;
    } else {
      reflowed.push(line);
    }
  }

  return reflowed
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractPaperText(
  regular: Zotero.Item | null,
  attachment: Zotero.Item | null,
): Promise<PaperTextResult> {
  if (attachment) {
    let raw = "";
    let failure: unknown = null;
    try {
      raw = String((await attachment.attachmentText) || "");
    } catch (error) {
      failure = error;
      log("attachmentText failed:", errorToString(error));
    }
    if (!raw.trim()) {
      try {
        const result = await Zotero.PDFWorker.getFullText(
          attachment.id,
          null,
          true,
        );
        raw = String(result?.text || "");
        if (raw.trim()) failure = null;
      } catch (error) {
        failure = error;
        log("PDFWorker.getFullText failed:", errorToString(error));
      }
    }
    const text = cleanExtractedText(raw);
    if (text.trim()) {
      return {
        text,
        attachmentID: attachment.id,
        truncated: false,
        fullTextLength: text.length,
        source: "pdf",
      };
    }

    const abstract = getAbstract(regular);
    if (abstract) {
      return {
        text: abstract,
        attachmentID: attachment.id,
        truncated: false,
        fullTextLength: abstract.length,
        source: "abstract",
      };
    }
    const detail = failure ? `（${errorToString(failure)}）` : "";
    throw new Error(
      `未能从 PDF 中提取到文本${detail}。可能是扫描版 PDF 或尚未建立全文索引，请在 Zotero 中右键该 PDF 选择“重建索引”后重试。`,
    );
  }

  const abstract = getAbstract(regular);
  if (abstract) {
    return {
      text: abstract,
      truncated: false,
      fullTextLength: abstract.length,
      source: "abstract",
    };
  }
  throw new Error(
    "该条目没有 PDF 附件，也没有摘要，无法进行 AI 阅读。请先为条目添加 PDF 文件。",
  );
}

function clipAtBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const boundary = Math.max(
    slice.lastIndexOf("\n\n"),
    slice.lastIndexOf("\n"),
    slice.lastIndexOf("。"),
    slice.lastIndexOf(". "),
  );
  if (boundary > maxChars * 0.8) return slice.slice(0, boundary).trimEnd();
  return slice.trimEnd();
}

/**
 * Extract the full text of a paper. The first call does the expensive work;
 * later calls return the same promise for the same item.
 */
export async function getPaperText(
  item: Zotero.Item,
): Promise<PaperTextResult> {
  const resolved = resolvePaperItem(item);
  if (!resolved.regular && !item?.isAttachment?.()) {
    throw new Error("请选择一个论文条目后再使用 AI 功能");
  }
  const cacheKey = resolved.regular?.libraryKey || item.libraryKey;
  const cached = textCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    const attachment = await resolveAttachment(resolved, item);
    return extractPaperText(resolved.regular, attachment);
  })();
  textCache.set(cacheKey, promise);
  try {
    return await promise;
  } catch (error) {
    textCache.delete(cacheKey);
    throw error;
  }
}

/**
 * Paper metadata + text for the chat context. `maxChars` defaults to the
 * `chatContextChars` preference; long texts are clipped at a paragraph
 * boundary and flagged with `truncated`.
 */
export async function getPaperContext(
  item: Zotero.Item,
  options: { maxChars?: number } = {},
): Promise<PaperContextWithSource> {
  const resolved = resolvePaperItem(item);
  if (!resolved.regular && !item?.isAttachment?.()) {
    throw new Error("请选择一个论文条目后再使用 AI 功能");
  }
  const meta = buildMeta(resolved.regular, item);
  const result = await getPaperText(item);

  const prefLimit = Number(
    getNumberPref(
      "chatContextChars",
      DEFAULT_CONTEXT_CHARS,
      1000,
      200000,
      true,
    ),
  );
  const requested = Number(options.maxChars);
  const maxChars =
    Number.isFinite(requested) && requested > 0
      ? requested
      : Number.isFinite(prefLimit) && prefLimit > 0
        ? prefLimit
        : DEFAULT_CONTEXT_CHARS;

  const truncated = result.text.length > maxChars;
  return {
    ...meta,
    text: truncated ? clipAtBoundary(result.text, maxChars) : result.text,
    fullTextLength: result.fullTextLength,
    truncated,
    attachmentID: result.attachmentID,
    source: result.source,
  };
}

/** Drop the per-item text cache (used by tests or after re-indexing a PDF). */
export function clearPaperTextCache(): void {
  textCache.clear();
}
