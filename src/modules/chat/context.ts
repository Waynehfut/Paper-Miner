/**
 * Paper context construction for the reading chat.
 *
 * Everything in this file is a pure function so it can be unit-tested without
 * Zotero or a network connection: tokenisation (English words + Chinese
 * bigrams, stop words removed), paragraph splitting, keyword retrieval, prompt
 * building and history trimming.
 */

import type { AiMessage, PaperMeta } from "../../types";

export const DEFAULT_CONTEXT_CHARS = 60000;
export const DEFAULT_MAX_HISTORY = 20;
/** Hard cap for a single history message sent back to the model. */
export const MAX_HISTORY_MESSAGE_CHARS = 6000;
/** Total character budget for history in one request (~6k tokens). */
export const DEFAULT_MAX_HISTORY_CHARS = 24000;

const EN_STOPWORDS = new Set(
  (
    "a about above after again against all am an and any are aren't as at be " +
    "because been before being below between both but by can cannot could " +
    "did do does doing don't down during each few for from further had has " +
    "have having he her here hers herself him himself his how i if in into " +
    "is isn't it its itself just me more most my myself no nor not of off on " +
    "once only or other ought our ours ourselves out over own same shan't she " +
    "should so some such than that the their theirs them themselves then " +
    "there these they this those through to too under until up very was " +
    "wasn't we were weren't what when where which while who whom why will " +
    "with won't would you your yours yourself yourselves also may might must " +
    "using used use based paper study results result method methods " +
    "however therefore thus show shows shown propose proposed approach " +
    "figure table section et al e g i e vs via"
  )
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Function words and generic academic filler that carries no retrieval
 * signal. Only multi-character entries are listed: a single Chinese character
 * is never a token (tokens are bigrams), so removing one would be a no-op.
 */
const ZH_STOPWORDS = new Set(
  (
    "我们 你们 他们 她们 它们 自己 这个 那个 这些 那些 这样 那样 这种 那种 " +
    "一个 一种 一些 一样 一直 以及 及其 并且 而且 然而 但是 可是 因为 " +
    "所以 因此 由于 如果 虽然 尽管 即使 无论 不管 只是 就是 还是 或者 而是 " +
    "不是 没有 不能 不会 可以 可能 应该 需要 已经 正在 通过 对于 关于 根据 " +
    "按照 除了 其它 其他 其中 之间 之后 之前 以上 以下 如下 上述 本文 " +
    "论文 文章 作者 时候 过程 方式 具有 进行 提出 给出 表明 显示 发现 认为 " +
    "指出 说明 如何 什么 哪些 哪个 怎样 怎么 是否 能够 为了 使用 采用 基于"
  )
    .split(/\s+/)
    .filter(Boolean),
);

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const EN_WORD_RE = /[a-z][a-z0-9][a-z0-9_-]*/g;

export interface ContextParagraph {
  /** 0-based index in the original document, kept for citations. */
  index: number;
  text: string;
}

export interface ChatContextBuildInput {
  meta: PaperMeta;
  text: string;
  fullTextLength?: number;
}

export interface ChatContextBuildOptions {
  question?: string;
  /** Total character budget for the context block (including metadata). */
  maxChars?: number;
}

export interface ChatContextResult {
  /** Ready-to-embed context block (metadata + excerpts). */
  contextText: string;
  /** "full" when the whole text fit, "retrieved" when paragraphs were picked. */
  mode: "full" | "retrieved";
  paragraphCount: number;
  usedParagraphs: number;
  totalChars: number;
  truncated: boolean;
}

/* ------------------------------------------------------------------ */
/* Tokenisation                                                        */
/* ------------------------------------------------------------------ */

export function isCJK(text: string): boolean {
  return CJK_RE.test(text);
}

/**
 * Extract retrieval tokens: lowercased English/number words (length >= 2)
 * and 2-grams of Chinese character runs, minus stop words. Order is
 * preserved so callers can build a stable query signature.
 */
export function tokenize(text: string): string[] {
  const source = String(text || "").toLowerCase();
  const tokens: string[] = [];
  const seen = new Set<string>();
  const push = (token: string) => {
    if (!token || seen.has(token)) return;
    seen.add(token);
    tokens.push(token);
  };
  for (const match of source.matchAll(EN_WORD_RE)) {
    const word = match[0];
    if (word.length < 2) continue;
    if (EN_STOPWORDS.has(word)) continue;
    push(word);
  }
  for (const match of source.matchAll(CJK_RUN_RE)) {
    const run = match[0];
    if (run.length === 1) {
      push(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i += 1) {
      const gram = run.slice(i, i + 2);
      if (ZH_STOPWORDS.has(gram)) continue;
      push(gram);
    }
  }
  return tokens;
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (from <= haystack.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    count += 1;
    from = index + needle.length;
  }
  return count;
}

/* ------------------------------------------------------------------ */
/* Paragraph splitting                                                 */
/* ------------------------------------------------------------------ */

const SENTENCE_SPLIT_RE = /(?<=[。！？；!?;])\s*|(?<=\.)\s+(?=[A-Z0-9(])/;
const BLANK_LINE_RE = /\n{2,}|\f/;

function joinSentences(sentences: string[]): string {
  let out = "";
  for (const sentence of sentences) {
    if (!out) {
      out = sentence;
      continue;
    }
    const last = out[out.length - 1] || "";
    const next = sentence[0] || "";
    // Chinese text never needs a joining space; English does.
    const needsSpace = !isCJK(last) && !isCJK(next) && /\S/.test(last);
    out += (needsSpace ? " " : "") + sentence;
  }
  return out;
}

function chunkBlock(block: string, maxChars: number): string[] {
  const sentences = block
    .split(SENTENCE_SPLIT_RE)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  if (!sentences.length) return block ? [block] : [];
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  const flush = () => {
    if (!current.length) return;
    chunks.push(joinSentences(current));
    current = [];
    length = 0;
  };
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      flush();
      for (let i = 0; i < sentence.length; i += maxChars) {
        chunks.push(sentence.slice(i, i + maxChars));
      }
      continue;
    }
    if (length + sentence.length > maxChars) flush();
    current.push(sentence);
    length += sentence.length;
  }
  flush();
  return chunks;
}

/**
 * Drop control characters that make PDF text unreadable, keeping tabs,
 * newlines and form feeds (page breaks) intact.
 */
export function stripControlChars(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) || 0;
    if (code === 9 || code === 10 || code === 12 || code === 13) {
      out += char;
    } else if (code < 32 || code === 127) {
      continue;
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * Split extracted PDF text into retrieval-sized paragraphs.
 *
 * PDF text layers vary a lot: some documents produce one paragraph per blank
 * line, others one line per visual line. Both are handled by first splitting
 * on blank lines / form feeds and then sentence-chunking any oversized block.
 */
export function splitParagraphs(text: string, maxChars = 1000): string[] {
  const limit = Math.max(200, Math.floor(maxChars));
  const normalized = stripControlChars(
    String(text || "").replace(/\r\n?/g, "\n"),
  ).replace(/[ \t\u00a0]+/g, " ");
  const blocks = normalized
    .split(BLANK_LINE_RE)
    .map((block) => block.trim())
    .filter(Boolean);
  const paragraphs: string[] = [];
  for (const block of blocks) {
    if (block.length <= limit) {
      paragraphs.push(block);
      continue;
    }
    paragraphs.push(...chunkBlock(block, limit));
  }
  return paragraphs;
}

/** Parse paragraphs into indexed records, dropping empty ones. */
export function toContextParagraphs(
  text: string,
  maxChars = 1000,
): ContextParagraph[] {
  return splitParagraphs(text, maxChars).map((paragraph, index) => ({
    index,
    text: paragraph,
  }));
}

/* ------------------------------------------------------------------ */
/* Keyword scoring / retrieval                                         */
/* ------------------------------------------------------------------ */

/** Weight longer tokens (more specific) and cap the per-token contribution. */
function tokenWeight(token: string): number {
  if (isCJK(token)) return token.length >= 2 ? 1.2 : 1;
  if (token.length >= 7) return 2;
  if (token.length >= 4) return 1.5;
  return 1;
}

export function scoreParagraph(
  paragraph: string,
  queryTokens: readonly string[],
): number {
  if (!paragraph || !queryTokens.length) return 0;
  const haystack = paragraph.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    const count = countOccurrences(haystack, token);
    if (!count) continue;
    // Cap repeated words so boilerplate ("method method method") can't win.
    score += Math.min(count, 4) * tokenWeight(token);
  }
  return score;
}

/**
 * Pick the paragraphs that best answer `question` within `budget` characters.
 *
 * The first and last paragraphs are always preferred when they fit (abstract /
 * introduction and conclusion carry most of the answers), and the remaining
 * budget is filled with the highest scoring paragraphs in document order so
 * the excerpt still reads naturally.
 */
export function selectRelevantParagraphs(
  paragraphs: readonly ContextParagraph[],
  question: string,
  budget: number,
): ContextParagraph[] {
  const textBudget = Math.max(0, Math.floor(budget));
  if (!paragraphs.length || textBudget < 80) return [];
  const queryTokens = tokenize(question);
  const selected = new Map<number, ContextParagraph>();
  let used = 0;
  const add = (paragraph: ContextParagraph): boolean => {
    if (selected.has(paragraph.index)) return false;
    const separator = selected.size ? 2 : 0;
    const cost = paragraph.text.length + separator;
    if (used + cost > textBudget) return false;
    selected.set(paragraph.index, paragraph);
    used += cost;
    return true;
  };

  // Guaranteed head/tail first, but never spend the whole budget on them.
  const headBudget = Math.floor(textBudget * 0.35);
  const head = paragraphs[0];
  if (head && head.text.length <= headBudget) add(head);
  const tail = paragraphs[paragraphs.length - 1];
  if (
    tail &&
    tail.index !== head?.index &&
    tail.text.length <= textBudget * 0.4
  ) {
    add(tail);
  }

  if (queryTokens.length) {
    const ranked = paragraphs
      .filter((paragraph) => !selected.has(paragraph.index))
      .map((paragraph) => ({
        paragraph,
        score: scoreParagraph(paragraph.text, queryTokens),
      }))
      .filter((entry) => entry.score > 0)
      .sort(
        (a, b) => b.score - a.score || a.paragraph.index - b.paragraph.index,
      );
    for (const entry of ranked) add(entry.paragraph);
  }

  // A question that shares no tokens with the paper (or one that only had
  // generic words) still needs some body text: fill forward in order.
  if (selected.size < 2) {
    for (const paragraph of paragraphs) {
      if (used >= textBudget) break;
      add(paragraph);
    }
  }

  return Array.from(selected.values()).sort((a, b) => a.index - b.index);
}

/* ------------------------------------------------------------------ */
/* Context block + prompts                                             */
/* ------------------------------------------------------------------ */

export function buildMetaHeader(meta: PaperMeta, maxChars = 3000): string {
  const lines: string[] = [];
  const push = (label: string, value: string) => {
    const text = String(value || "").trim();
    if (text) lines.push(`${label}：${text}`);
  };
  push("标题", meta.title);
  push("作者", meta.authors);
  push("期刊/会议", meta.journal);
  push("年份", meta.year);
  push("DOI", meta.doi);
  let header = "【论文信息】\n" + lines.join("\n");
  const abstract = String(meta.abstract || "").trim();
  if (abstract) {
    const room = Math.max(0, maxChars - header.length - 8);
    const clipped =
      room > 40
        ? abstract.slice(0, room) + (abstract.length > room ? "…" : "")
        : "";
    if (clipped) header += `\n摘要：${clipped}`;
  }
  return header;
}

/**
 * Build the context block handed to the model. When the extracted text fits
 * the budget it is included verbatim; otherwise relevant paragraphs are
 * selected and marked with their document index so answers can cite them.
 */
export function buildChatContext(
  input: ChatContextBuildInput,
  options: ChatContextBuildOptions = {},
): ChatContextResult {
  const maxChars = Math.max(
    1000,
    Math.floor(options.maxChars || DEFAULT_CONTEXT_CHARS),
  );
  const header = buildMetaHeader(input.meta, Math.min(3000, maxChars / 4));
  const fullBudget = Math.max(400, maxChars - header.length - 20);
  // Retrieved excerpts carry a trailing note about how much was omitted.
  const retrievedBudget = Math.max(400, maxChars - header.length - 240);
  const rawText = String(input.text || "").trim();
  const paragraphs = toContextParagraphs(rawText, 1000);
  const fullTextLength = Math.max(
    rawText.length,
    input.fullTextLength || rawText.length,
  );

  if (!rawText) {
    const contextText =
      header +
      "\n\n【正文】\n（未能提取到 PDF 正文，请仅依据上述元数据与摘要回答，并明确说明这一点。）";
    return {
      contextText,
      mode: "full",
      paragraphCount: 0,
      usedParagraphs: 0,
      totalChars: contextText.length,
      truncated: false,
    };
  }

  if (rawText.length <= fullBudget) {
    const contextText = `${header}\n\n【正文】\n${rawText}`;
    return {
      contextText,
      mode: "full",
      paragraphCount: paragraphs.length,
      usedParagraphs: paragraphs.length,
      totalChars: contextText.length,
      truncated: false,
    };
  }

  const question = String(options.question || "");
  const selected = selectRelevantParagraphs(
    paragraphs,
    question,
    retrievedBudget,
  );
  const excerpts = selected
    .map((paragraph) => `[段 ${paragraph.index + 1}] ${paragraph.text}`)
    .join("\n\n");
  const note =
    selected.length < paragraphs.length
      ? `\n\n（原文共 ${paragraphs.length} 段、约 ${fullTextLength} 字符；以上按与问题相关度摘录了 ${selected.length} 段。未摘录的内容不要臆测。）`
      : "";
  const contextText = `${header}\n\n【正文摘录】\n${excerpts}${note}`;
  return {
    contextText,
    mode: "retrieved",
    paragraphCount: paragraphs.length,
    usedParagraphs: selected.length,
    totalChars: contextText.length,
    truncated: selected.length < paragraphs.length,
  };
}

/** The system prompt for the reading chat. */
export function buildSystemPrompt(
  contextText: string,
  extraInstructions = "",
): string {
  const extra = String(extraInstructions || "").trim();
  return [
    "你是 PaperMiner 的论文阅读助手，帮助研究者读懂、评估并复述一篇论文。",
    "",
    "回答规则：",
    "1. 只依据下面给出的论文信息与原文回答。原文没有明确写出的内容，直接说“论文中未提及”，不要编造。",
    "2. 严格区分【原文事实】（有原文依据）与【推断】（你的分析或外部知识），推断必须标注“（推断）”。",
    "3. 引用原文时用 [段 N] 标注段落编号（见正文摘录）；没有段落编号时不要编造页码。",
    "4. 用户用中文提问就用中文回答，用英文提问就用英文回答；术语可保留英文原词。",
    "5. 回答用 Markdown 组织：先给结论，再给依据；复杂内容用列表或小标题；公式用 $...$ 或代码块。",
    "6. 如果问题需要论文之外的知识，先说明这属于外部知识，再简要补充。",
    ...(extra ? ["", "用户自定义提示词（优先遵守）：", extra] : []),
    "",
    "===== 论文上下文开始 =====",
    contextText,
    "===== 论文上下文结束 =====",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
  incomplete?: boolean;
}

/** Keep only the most recent `maxCount` messages (0 / negative = keep all). */
export function trimHistory<T extends { content: string }>(
  messages: readonly T[],
  maxCount: number = DEFAULT_MAX_HISTORY,
): T[] {
  const usable = messages.filter(
    (message) => String(message.content || "").trim().length > 0,
  );
  if (!Number.isFinite(maxCount) || maxCount <= 0) return usable.slice();
  return usable.slice(-Math.floor(maxCount));
}

/** Middle-truncate a long message so the beginning and end both survive. */
export function truncateMiddle(text: string, maxChars: number): string {
  const source = String(text || "");
  if (!Number.isFinite(maxChars) || maxChars <= 0) return source;
  if (source.length <= maxChars) return source;
  if (maxChars < 12) return source.slice(0, maxChars);
  const head = Math.ceil(maxChars * 0.6);
  const tail = maxChars - head;
  return `${source.slice(0, head)}\n…\n${source.slice(-tail)}`;
}

export interface BuildChatMessagesOptions {
  systemPrompt: string;
  history?: readonly ChatHistoryMessage[];
  /** The new question; omitted when it is already the last history item. */
  question?: string;
  maxHistory?: number;
  maxCharsPerMessage?: number;
  /** Total character budget for the history; newest messages win. */
  maxHistoryChars?: number;
}

/**
 * Assemble the request messages: system prompt, trimmed history, then the new
 * question (deduplicated when the caller already pushed it into the history).
 */
export function buildChatMessages(
  options: BuildChatMessagesOptions,
): AiMessage[] {
  const maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
  const maxCharsPerMessage =
    options.maxCharsPerMessage ?? MAX_HISTORY_MESSAGE_CHARS;
  const history = trimHistory(options.history || [], maxHistory);
  const maxHistoryChars = options.maxHistoryChars ?? DEFAULT_MAX_HISTORY_CHARS;
  const messages: AiMessage[] = [
    { role: "system", content: options.systemPrompt },
  ];
  // Keep the newest history that fits the budget; always keep at least one.
  const kept: AiMessage[] = [];
  let usedChars = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    const content = truncateMiddle(
      String(message.content || "").trim(),
      maxCharsPerMessage,
    );
    if (!content) continue;
    if (kept.length && usedChars + content.length > maxHistoryChars) break;
    kept.push({ role: message.role, content });
    usedChars += content.length;
  }
  kept.reverse();
  messages.push(...kept);
  const question = String(options.question || "").trim();
  if (question) {
    const last = messages[messages.length - 1];
    const alreadyIncluded =
      last &&
      last.role === "user" &&
      String(last.content).trim() ===
        truncateMiddle(question, maxCharsPerMessage);
    if (!alreadyIncluded) messages.push({ role: "user", content: question });
  }
  return messages;
}
