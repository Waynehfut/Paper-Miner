/**
 * Prompt builders and pure text helpers for the AI features.
 *
 * Everything here is deterministic and side-effect free so it can be unit
 * tested without Zotero or a live API.
 */

import type { AiMessage, PaperMeta } from "../../types";

export type OutputLanguage = "zh" | "en";

/** Full text at or below this length is summarised in a single LLM call. */
export const SUMMARY_SINGLE_PASS_CHARS = 30000;
/** Target size of one map step for long papers. */
export const SUMMARY_CHUNK_CHARS = 12000;
/** Hard cap on LLM calls for one summary (map + reduce). */
export const SUMMARY_MAX_LLM_CALLS = 6;
export const SUMMARY_MAX_CHUNKS = SUMMARY_MAX_LLM_CALLS - 1;

/** How much paper text is sent to the slide-outline request. */
export const PPT_MAX_TEXT_CHARS = 30000;

/** Structured sections of the reading summary, per output language. */
export const SUMMARY_SECTIONS: Record<OutputLanguage, string[]> = {
  zh: [
    "一句话总结",
    "研究问题",
    "方法",
    "数据与实验",
    "主要结论",
    "创新点",
    "局限",
    "启示",
  ],
  en: [
    "TL;DR",
    "Research Question",
    "Method",
    "Data & Experiments",
    "Key Findings",
    "Novelty",
    "Limitations",
    "Implications",
  ],
};

const CJK_IDEOGRAPH = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const LETTER = /[^\p{L}]/gu;

export function countCjk(text: string): number {
  const matches = String(text || "").match(CJK_IDEOGRAPH);
  return matches ? matches.length : 0;
}

/**
 * Very small language detector used to decide the output language of
 * summaries/slides and the auto translation direction.
 * Returns "zh" for mostly Chinese/CJK text, "en" otherwise.
 */
export function detectTextLanguage(text: string): OutputLanguage {
  const sample = String(text || "").slice(0, 8000);
  if (!sample.trim()) return "en";
  const letters = sample.replace(LETTER, "").length;
  if (letters < 8) return "en";
  const ratio = countCjk(sample) / letters;
  return ratio >= 0.2 ? "zh" : "en";
}

/**
 * Map a preference value to an explicit output language. Returns null for
 * "auto"/unknown values, which have to be resolved against the paper text.
 */
export function languageFromSetting(
  setting: string | undefined,
): OutputLanguage | null {
  const normalized = String(setting ?? "auto")
    .trim()
    .toLowerCase();
  if (
    normalized === "zh" ||
    normalized === "zh-cn" ||
    normalized === "zh-hans" ||
    normalized === "zh_cn" ||
    normalized === "chinese"
  ) {
    return "zh";
  }
  if (
    normalized === "en" ||
    normalized === "en-us" ||
    normalized === "en_us" ||
    normalized === "english"
  ) {
    return "en";
  }
  return null;
}

/**
 * Resolve a `summaryLanguage` / `pptLanguage` preference ("auto" | "zh" |
 * "en" or an editable value) against the document language.
 */
export function resolveOutputLanguage(
  setting: string | undefined,
  sampleText: string,
): OutputLanguage {
  return languageFromSetting(setting) ?? detectTextLanguage(sampleText);
}

const LANGUAGE_NAMES: Record<string, string> = {
  zh: "简体中文",
  "zh-cn": "简体中文",
  "zh-hans": "简体中文",
  "zh-chs": "简体中文",
  "zh-tw": "繁體中文",
  "zh-hant": "繁體中文",
  en: "English",
  "en-us": "English",
  ja: "日本語",
  ko: "한국어",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  ru: "Русский",
  pt: "Português",
  it: "Italiano",
  ar: "العربية",
};

/** Human readable language name used inside translation prompts. */
export function languageDisplayName(code: string): string {
  const key = String(code || "")
    .trim()
    .toLowerCase();
  if (!key || key === "auto") return LANGUAGE_NAMES.zh;
  return (
    LANGUAGE_NAMES[key] ||
    LANGUAGE_NAMES[key.split(/[-_]/)[0]] ||
    String(code).trim() ||
    LANGUAGE_NAMES.zh
  );
}

/**
 * Resolve the translation target. "auto" translates Chinese to English and
 * everything else to Simplified Chinese.
 */
export function resolveTranslateTarget(
  targetSetting: string | undefined,
  text: string,
): string {
  const target = String(targetSetting ?? "auto").trim();
  if (!target || target.toLowerCase() === "auto") {
    return detectTextLanguage(text) === "zh" ? "en" : "zh-CN";
  }
  return target;
}

/**
 * Split text into chunks of at most `chunkChars` characters, preferring
 * paragraph/sentence boundaries. When `maxChunks` > 0 the function never
 * returns more chunks than that (the tail is merged), so callers can bound
 * the number of LLM requests.
 */
export function splitText(
  text: string,
  chunkChars: number,
  maxChunks = 0,
): string[] {
  const source = String(text || "").trim();
  if (!source) return [];
  const baseLimit = Math.max(500, Math.floor(chunkChars) || 12000);
  const limit =
    maxChunks > 0
      ? Math.max(baseLimit, Math.ceil(source.length / maxChunks))
      : baseLimit;

  const paragraphs = source
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > limit) {
      flush();
      const parts = hardSplit(paragraph, limit);
      const tail = parts.pop();
      chunks.push(...parts);
      current = tail || "";
      continue;
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > limit) {
      flush();
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  flush();

  if (maxChunks > 0 && chunks.length > maxChunks) {
    const kept = chunks.slice(0, maxChunks - 1);
    kept.push(chunks.slice(maxChunks - 1).join("\n\n"));
    return kept;
  }
  return chunks;
}

/** Chunks used by the summary map step, bounded by the call budget. */
export function chunkTextForSummary(text: string): string[] {
  if (String(text || "").length <= SUMMARY_SINGLE_PASS_CHARS) {
    return [String(text || "").trim()].filter(Boolean);
  }
  return splitText(text, SUMMARY_CHUNK_CHARS, SUMMARY_MAX_CHUNKS);
}

function hardSplit(text: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf("\n\n");
    if (cut < limit * 0.5) cut = window.lastIndexOf("\n");
    if (cut < limit * 0.5) {
      cut = Math.max(
        window.lastIndexOf(". "),
        window.lastIndexOf("。"),
        window.lastIndexOf("！"),
        window.lastIndexOf("？"),
        window.lastIndexOf("；"),
      );
    }
    if (cut <= 0) cut = limit;
    const piece = rest.slice(0, cut).trim();
    if (piece) parts.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts;
}

/** Remove C0 control characters while keeping tab/newline/carriage return. */
export function stripControlCharacters(text: string): string {
  let result = "";
  for (const char of String(text || "")) {
    const code = char.codePointAt(0) || 0;
    if (code < 9 || code === 11 || code === 12 || (code >= 14 && code <= 31)) {
      continue;
    }
    result += char;
  }
  return result;
}

/** Remove an outer ```json ... ``` fence, if the model added one. */
export function stripCodeFence(raw: string): string {
  const text = String(raw || "")
    .replace(/^\uFEFF/, "")
    .trim();
  if (!text) return "";
  const fenced = text.match(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/);
  if (fenced && fenced[1].trim()) return fenced[1].trim();
  return text
    .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
}

/**
 * Normalise a Markdown answer: strip fences and a leading conversational
 * sentence such as "好的，以下是摘要".
 */
export function cleanModelMarkdown(raw: string): string {
  const text = stripCodeFence(raw);
  if (!text) return "";
  const lines = text.split("\n");
  const first = (lines[0] || "").trim();
  if (
    lines.length > 1 &&
    first.length < 80 &&
    !first.startsWith("#") &&
    /^(好的|当然|没问题|以下是|Here is|Here's|Sure[,，])/i.test(first)
  ) {
    lines.shift();
    while (lines.length && !lines[0].trim()) lines.shift();
  }
  return lines.join("\n").trim();
}

/** Shorten text for prompt budgets without cutting in the middle of a word. */
export function clipText(text: string, maxChars: number): string {
  const source = String(text || "");
  if (source.length <= maxChars) return source;
  const slice = source.slice(0, maxChars);
  const boundary = Math.max(
    slice.lastIndexOf("\n\n"),
    slice.lastIndexOf("\n"),
    slice.lastIndexOf("。"),
    slice.lastIndexOf(". "),
  );
  if (boundary > maxChars * 0.7) return slice.slice(0, boundary).trimEnd();
  return slice.trimEnd();
}

function displayLabel(language: OutputLanguage): {
  title: string;
  authors: string;
  journal: string;
  year: string;
  doi: string;
  abstract: string;
  paperInfo: string;
  body: string;
  chars: (n: number) => string;
} {
  if (language === "zh") {
    return {
      title: "标题",
      authors: "作者",
      journal: "期刊",
      year: "年份",
      doi: "DOI",
      abstract: "摘要",
      paperInfo: "论文信息",
      body: "论文正文",
      chars: (n) => `共 ${n} 字`,
    };
  }
  return {
    title: "Title",
    authors: "Authors",
    journal: "Journal",
    year: "Year",
    doi: "DOI",
    abstract: "Abstract",
    paperInfo: "Paper information",
    body: "Paper text",
    chars: (n) => `${n} characters`,
  };
}

function metaBlock(meta: PaperMeta, language: OutputLanguage): string {
  const labels = displayLabel(language);
  const rows: Array<[string, string]> = [
    [labels.title, meta.title],
    [labels.authors, meta.authors],
    [labels.journal, meta.journal],
    [labels.year, meta.year],
    [labels.doi, meta.doi],
    [labels.abstract, clipText(meta.abstract, 1500)],
  ];
  return rows
    .filter(([, value]) => String(value || "").trim())
    .map(([label, value]) => `${label}: ${String(value).trim()}`)
    .join("\n");
}

function summarySystemPrompt(
  language: OutputLanguage,
  customPrompt?: string,
): string {
  const base =
    language === "zh"
      ? [
          "你是一位严谨的学术论文阅读助手，专门为研究者撰写结构化阅读笔记。",
          "规则：",
          "1. 只依据用户提供的论文内容作答，不得编造数字、方法或结论；论文未提及的信息写“论文未提及”。",
          "2. 使用 Markdown（## 二级标题、- 列表），不要输出代码块围栏，不要输出“好的”等客套话。",
          "3. 保留关键术语原文（可在括号内附英文），保留重要数字、指标和数据集名称。",
        ].join("\n")
      : [
          "You are a rigorous academic reading assistant producing structured reading notes for researchers.",
          "Rules:",
          '1. Use only the provided paper content. Never invent numbers, methods or conclusions; write "Not reported in the paper" when information is missing.',
          "2. Output Markdown (## headings, - lists). No code fences, no conversational filler.",
          "3. Keep technical terms, important numbers, metrics and dataset names verbatim.",
        ].join("\n");
  const extra = String(customPrompt || "").trim();
  if (!extra) return base;
  const label =
    language === "zh"
      ? `用户附加要求（优先遵循，但不得编造内容）：${extra}`
      : `Additional user instruction (follow it, but never fabricate): ${extra}`;
  return `${base}\n\n${label}`;
}

function sectionList(language: OutputLanguage): string {
  return SUMMARY_SECTIONS[language]
    .map((section) => `## ${section}`)
    .join("\n");
}

export interface SingleSummaryOptions {
  meta: PaperMeta;
  text: string;
  language: OutputLanguage;
  customPrompt?: string;
}

/** Prompt for a paper that fits into a single request. */
export function buildSingleSummaryMessages(
  options: SingleSummaryOptions,
): AiMessage[] {
  const { meta, text, language, customPrompt } = options;
  const labels = displayLabel(language);
  const target = language === "zh" ? "中文" : "English";
  const user = [
    language === "zh"
      ? `请阅读以下论文，输出结构化阅读摘要（${target}）。`
      : `Read the following paper and produce a structured reading summary (${target}).`,
    "",
    `【${labels.paperInfo}】`,
    metaBlock(meta, language),
    "",
    `【${labels.body}】（${labels.chars(text.length)}）`,
    '"""',
    text,
    '"""',
    "",
    language === "zh"
      ? `请严格按以下小节输出（每节 2-5 句或 3-6 条要点，全文约 800-1400 字）：`
      : `Use exactly these sections (2-5 sentences or 3-6 bullets each, 500-900 words total):`,
    sectionList(language),
  ].join("\n");
  return [
    { role: "system", content: summarySystemPrompt(language, customPrompt) },
    { role: "user", content: user },
  ];
}

export interface ChunkNotesOptions {
  meta: PaperMeta;
  chunk: string;
  index: number;
  total: number;
  language: OutputLanguage;
}

/** Prompt for one map step over a long paper. */
export function buildChunkNotesMessages(
  options: ChunkNotesOptions,
): AiMessage[] {
  const { meta, chunk, index, total, language } = options;
  const labels = displayLabel(language);
  const partLabel =
    language === "zh"
      ? `第 ${index} / ${total} 部分`
      : `part ${index} of ${total}`;
  const user = [
    language === "zh"
      ? `请阅读论文《${meta.title || "未命名论文"}》的${partLabel}（${labels.chars(chunk.length)}）。`
      : `Read ${partLabel} (${labels.chars(chunk.length)}) of the paper "${meta.title || "Untitled"}".`,
    "",
    language === "zh"
      ? [
          "提取这一部分的关键信息，覆盖：研究背景与问题、方法或模型、数据与实验设置、主要结果（含关键数字）、结论与贡献、局限。",
          "输出 Markdown 要点列表，最多 12 条，每条不超过 60 字；保留术语原文和关键数字，不要编造。",
        ].join("\n")
      : [
          "Extract the key information in this part, covering: background & problem, method/model, data & experimental setup, main results (with numbers), conclusions & contributions, limitations.",
          "Output a Markdown bullet list, at most 12 bullets, each under 30 words. Keep terms and numbers verbatim; never invent.",
        ].join("\n"),
    "",
    `【${language === "zh" ? "正文片段" : "Text"} ${index}/${total}】`,
    '"""',
    chunk,
    '"""',
  ].join("\n");
  return [
    { role: "system", content: summarySystemPrompt(language) },
    { role: "user", content: user },
  ];
}

export interface MergeSummaryOptions {
  meta: PaperMeta;
  notes: string[];
  language: OutputLanguage;
  customPrompt?: string;
}

/** Prompt for the reduce step of a chunked summary. */
export function buildMergeSummaryMessages(
  options: MergeSummaryOptions,
): AiMessage[] {
  const { meta, notes, language, customPrompt } = options;
  const labels = displayLabel(language);
  const chunks = notes
    .map(
      (note, index) =>
        `### ${language === "zh" ? "片段" : "Part"} ${index + 1}\n${note.trim()}`,
    )
    .join("\n\n");
  const user = [
    language === "zh"
      ? "下面是对同一篇论文不同部分的分段阅读笔记，请综合它们写出最终的结构化阅读摘要（中文）。"
      : "Below are partial reading notes for different parts of the same paper. Synthesise them into a final structured reading summary (English).",
    "",
    `【${labels.paperInfo}】`,
    metaBlock(meta, language),
    "",
    `【${language === "zh" ? "分段笔记" : "Partial notes"}】`,
    chunks,
    "",
    language === "zh"
      ? "要求：综合全部分段信息，避免简单堆叠；严格按以下小节输出（每节 2-5 句或 3-6 条要点，全文约 800-1400 字）："
      : "Requirements: combine all partial notes instead of concatenating them; use exactly these sections (2-5 sentences or 3-6 bullets each, 500-900 words total):",
    sectionList(language),
  ].join("\n");
  return [
    { role: "system", content: summarySystemPrompt(language, customPrompt) },
    { role: "user", content: user },
  ];
}

export interface PptOutlinePromptOptions {
  meta: PaperMeta;
  text: string;
  slideCount: number;
  language: OutputLanguage;
  /** Extra user instructions for the slide outline. */
  customPrompt?: string;
}

/** Prompt asking for a strict JSON slide outline. */
export function buildPptOutlineMessages(
  options: PptOutlinePromptOptions,
): AiMessage[] {
  const { meta, text, slideCount, language } = options;
  const labels = displayLabel(language);
  const customPrompt = String(options.customPrompt || "").trim();
  const system =
    (language === "zh"
      ? "你是一位学术会议演示文稿设计师，擅长把论文提炼成简洁、有逻辑的幻灯片大纲。你只输出 JSON。"
      : "You are an academic presentation designer who turns papers into concise, logical slide outlines. You output JSON only.") +
    (customPrompt
      ? language === "zh"
        ? `\n\n用户额外要求（优先遵守）：\n${customPrompt}`
        : `\n\nAdditional user requirements (follow these first):\n${customPrompt}`
      : "");
  const body = clipText(text, PPT_MAX_TEXT_CHARS);
  const user =
    language === "zh"
      ? [
          `请为以下论文设计一份 16:9 演示文稿的内容大纲，共 ${slideCount} 张内容幻灯片（不含封面、目录、结束页）。`,
          "",
          `【${labels.paperInfo}】`,
          metaBlock(meta, language),
          "",
          `【${labels.body}】（${labels.chars(body.length)}，可能已截断）`,
          '"""',
          body,
          '"""',
          "",
          "要求：",
          "1. 只输出一个 JSON 对象，不要 Markdown 代码围栏，不要任何解释文字。",
          "2. JSON 结构：",
          "{",
          '  "title": "演示标题（不超过 60 字）",',
          '  "subtitle": "副标题（可选，不超过 40 字）",',
          '  "slides": [',
          '    { "title": "幻灯片标题（不超过 30 字）", "bullets": ["要点 1", "要点 2", "要点 3"], "speakerNotes": "可选，80 字以内" }',
          "  ]",
          "}",
          "3. 每张幻灯片 3-6 个要点，每个要点不超过 45 个汉字；要点具体，保留关键数字和术语，不要编造。",
          "4. 内容逻辑：研究背景 → 研究问题 → 方法 → 数据与实验 → 结果 → 结论与创新 → 局限与启示（按论文实际内容取舍）。",
          "5. 全部使用简体中文。",
        ].join("\n")
      : [
          `Design a 16:9 slide outline for the following paper with ${slideCount} content slides (cover, agenda and closing slides are added separately).`,
          "",
          `【${labels.paperInfo}】`,
          metaBlock(meta, language),
          "",
          `【${labels.body}】（${labels.chars(body.length)}, may be truncated)`,
          '"""',
          body,
          '"""',
          "",
          "Requirements:",
          "1. Output exactly one JSON object. No Markdown code fences, no explanation.",
          "2. JSON structure:",
          "{",
          '  "title": "Deck title (max 12 words)",',
          '  "subtitle": "Optional subtitle (max 10 words)",',
          '  "slides": [',
          '    { "title": "Slide title (max 8 words)", "bullets": ["Point 1", "Point 2", "Point 3"], "speakerNotes": "optional, max 50 words" }',
          "  ]",
          "}",
          "3. 3-6 bullets per slide; each bullet at most 15 words. Be specific, keep numbers and terms, never invent.",
          "4. Storyline: background → problem → method → data & experiments → results → conclusions & novelty → limitations & implications (drop what does not apply).",
          "5. Use English.",
        ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export interface TranslatePromptOptions {
  targetLang: string;
  context?: string;
  /** Extra user instructions for AI translation. */
  customPrompt?: string;
}

/** Prompt for academic translation. Output must be the translation only. */
export function buildTranslateMessages(
  text: string,
  options: TranslatePromptOptions,
): AiMessage[] {
  const targetName = languageDisplayName(options.targetLang);
  const context = String(options.context || "").trim();
  const system = [
    `你是一位专业的学术论文翻译，精通中英文学术表达。请把用户给出的文本翻译成${targetName}。`,
    "要求：",
    "1. 只输出译文本身，不要解释、不要加引号或“译文：”前缀。",
    "2. 保留专业术语、缩写、数字、公式、变量名、引用编号与文献格式；必要时可在术语后用括号保留原文。",
    "3. 保持学术语体，语句通顺，不增删内容。",
  ];
  const customPrompt = String(options.customPrompt || "").trim();
  if (customPrompt) {
    system.push("", "用户额外要求（优先遵守）：", customPrompt);
  }
  const systemText = system.join("\n");
  const user = [
    context
      ? `上下文（仅用于理解术语，不要翻译）：\n"""\n${clipText(context, 2000)}\n"""\n`
      : "",
    `待翻译文本：\n"""\n${text}\n"""`,
  ]
    .filter(Boolean)
    .join("\n");
  return [
    { role: "system", content: systemText },
    { role: "user", content: user },
  ];
}
