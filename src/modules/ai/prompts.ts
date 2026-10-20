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
    "研究问题与背景",
    "方法与关键设计",
    "数据、实验与评估",
    "关键证据与主要结果",
    "创新点与贡献",
    "局限、风险与反例",
    "可复现性",
    "启示与后续问题",
  ],
  en: [
    "TL;DR",
    "Research Question & Context",
    "Method & Key Design",
    "Data, Experiments & Evaluation",
    "Key Evidence & Results",
    "Novelty & Contributions",
    "Limitations, Risks & Counterexamples",
    "Reproducibility",
    "Implications & Open Questions",
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
          "你是一位严谨的学术阅读助手，兼具领域专家与审稿人的判断力。你的目标不是复述摘要，而是帮助研究者快速判断：论文解决了什么问题、证据是否支持结论、结果能否复现、与自己的研究有什么关系。",
          "规则：",
          "1. 只依据用户提供的论文内容作答，不得编造数字、方法、结论、引用或页码；论文未报告的信息写“原文未报告”。",
          "2. 明确区分【作者主张】【原文证据】【推断】；自己的分析必须标注“（推断）”，不要把推断写成论文结论。",
          "3. 每个关键结论尽量给出具体证据：数据集、样本量、评价指标、对比基线、关键数值、消融结果；不要用“效果显著”“具有重要意义”等空泛评价。",
          "4. 先判断论文类型（方法/benchmark/实证/综述），再调整重点：方法论文看设计与消融，benchmark 论文看构建效度与覆盖，实证论文看识别策略与外部效度。",
          "5. 批判性部分必须具体，至少指出 2 条真实局限，并说明需要什么证据才能改变结论；关注基线公平性、统计不确定性、外部效度与可复现性。",
          "6. 使用 Markdown（## 二级标题、- 列表或表格），不要输出代码块围栏，不要输出“好的”等客套话。",
          "7. 保留关键术语原文（可在括号内附英文），保留重要数字、指标和数据集名称。信息密度优先，不复述大段原文。",
        ].join("\n")
      : [
          "You are a rigorous academic reading assistant with the judgment of both a domain expert and a peer reviewer. Your job is not to paraphrase the abstract, but to help a researcher decide: what problem the paper solves, whether the evidence supports its claims, whether it can be reproduced, and how it relates to their work.",
          "Rules:",
          '1. Use only the provided paper content. Never invent numbers, methods, conclusions, citations or page numbers; write "Not reported in the paper" when information is missing.',
          "2. Distinguish [author claim], [original evidence] and [inference]. Mark your own analysis as (inference); never present inference as a paper conclusion.",
          '3. Support each key conclusion with concrete evidence: dataset, sample size, metric, baselines, key numbers, ablation results. Avoid empty phrases such as "significant impact" or "great importance".',
          "4. Identify the paper type (method / benchmark / empirical / survey) and adapt: design and ablations for methods; construct validity and coverage for benchmarks; identification and external validity for empirical work.",
          "5. The critique must be concrete: at least two real limitations, plus what evidence would change the conclusion. Consider baseline fairness, statistical uncertainty, external validity and reproducibility.",
          "6. Output Markdown (## headings, - lists or tables). No code fences, no conversational filler.",
          "7. Keep technical terms, important numbers, metrics and dataset names verbatim. Prefer information density over restating long passages.",
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
      ? [
          "请严格按以下小节输出（每节 2-6 句或 3-6 条要点，全文约 1000-1600 字）：",
          "在【关键证据与主要结果】中，用“结论 → 证据 → 强度（强/中/弱）”的形式列出 2-4 条关键主张。",
          "在【局限、风险与反例】中区分作者承认的局限与你独立发现的问题；在【可复现性】中说明数据、代码、超参数和评估细节是否充分。",
          "如果论文类型是方法论文，突出架构/训练/推理设计；如果是 benchmark，突出数据构建、标注质量与评测协议；如果是综述，突出覆盖范围与论点组织。",
        ].join("\n")
      : [
          "Use exactly these sections (2-6 sentences or 3-6 bullets each, 700-1100 words total):",
          'In "Key Evidence & Results", list 2-4 key claims as "claim -> evidence -> strength (strong/medium/weak)".',
          'In "Limitations, Risks & Counterexamples", separate the authors’ stated limitations from your independent critique; in "Reproducibility", assess data, code, hyperparameters and evaluation details.',
          "If this is a method paper, emphasize architecture/training/inference design; for a benchmark, data construction, annotation quality and protocol; for a survey, coverage and argument organization.",
        ].join("\n"),
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
          "提取这一部分的关键信息，重点覆盖：研究问题、方法/模型的关键设计、数据与实验设置、对比基线、评价指标、带数字的主要结果、作者主张及其证据、局限与可复现性细节。",
          "输出 Markdown 要点列表（最多 14 条，每条不超过 70 字）；区分【作者主张】与【证据】，保留术语和数字，绝不编造。",
        ].join("\n")
      : [
          "Extract the key information in this part, focusing on: research question, key design of the method/model, data and experimental setup, baselines, metrics, main results with numbers, author claims and their evidence, limitations and reproducibility details.",
          "Output a Markdown bullet list (at most 14 bullets, each under 35 words). Separate [author claim] from [evidence]; keep terms and numbers verbatim; never invent.",
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
      ? [
          "要求：综合全部分段信息，避免简单堆叠；严格按以下小节输出（每节 2-6 句或 3-6 条要点，全文约 1000-1600 字）。",
          "如果不同片段的结论/数字冲突，保留冲突并说明可能原因；如果分段笔记没有覆盖某个小节，明确写“原文未报告/信息不足”，不要补写。",
          "批判性评价必须具体，并说明需要什么证据才能改变结论。",
        ].join("\n")
      : [
          "Requirements: synthesise all partial notes instead of concatenating them; use exactly these sections (2-6 sentences or 3-6 bullets each, 700-1100 words total).",
          'If notes conflict on a conclusion or number, preserve the conflict and explain possible reasons; if a section is not covered by the notes, write "not reported / insufficient information" instead of filling it in.',
          "The critique must be concrete and state what evidence would change the conclusion.",
        ].join("\n"),
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
      ? [
          "你是一位资深学术会议演讲教练与幻灯片设计师，擅长把论文变成“一页一个主张”的叙事。你只输出 JSON。",
          "原则：先建立故事线，再设计每一页；标题必须是听众能记住的断言，而不是“方法”“实验结果”这类主题词；每个要点都要有证据或具体含义；不要把论文段落搬上幻灯片。",
        ].join("\n")
      : [
          "You are a senior academic presentation coach and slide designer. You turn papers into a one-message-per-slide narrative and output JSON only.",
          'Principles: design the storyline first, then each slide; every title must be a memorable assertion, not a topic label like "Method" or "Results"; each bullet must carry evidence or a concrete implication; never paste paper paragraphs onto slides.',
        ].join("\n")) +
    (customPrompt
      ? language === "zh"
        ? `\n\n用户额外要求（优先遵守）：\n${customPrompt}`
        : `\n\nAdditional user requirements (follow these first):\n${customPrompt}`
      : "");
  const body = clipText(text, PPT_MAX_TEXT_CHARS);
  const user =
    language === "zh"
      ? [
          `请为以下论文设计一份 16:9 演示文稿的内容大纲，共 ${slideCount} 张内容幻灯片（封面、目录、结束页由程序另行添加，不要计入）。`,
          "",
          `【${labels.paperInfo}】`,
          metaBlock(meta, language),
          "",
          `【${labels.body}】（${labels.chars(body.length)}，可能已截断）`,
          '"""',
          body,
          '"""',
          "",
          "先确定目标听众与全篇一句话核心信息，再按以下故事线分配页面（按论文实际内容取舍）：",
          "1. 开场：问题/现象/为什么现在重要（1 页，最好用一个具体例子或反直觉事实）",
          "2. 研究空白或核心挑战（1 页）",
          "3. 核心思路与方法（1-2 页，突出关键设计，不罗列所有模块）",
          "4. 数据与实验设置（1 页，只保留理解结果所必需的）",
          "5. 关键结果（2-3 页，包含基线、对比数字、消融或案例证据）",
          "6. 机理/边界条件/失败模式（按需 1 页）",
          "7. 局限与反例（1 页，具体说明什么情况下结论不成立）",
          "8. 结论、启示与下一步（1 页）",
          "",
          "要求：",
          "1. 只输出一个 JSON 对象，不要 Markdown 代码围栏，不要任何解释文字。",
          "2. JSON 结构：",
          "{",
          '  "title": "演示标题（不超过 36 字）",',
          '  "subtitle": "副标题（可选，不超过 28 字）",',
          '  "slides": [',
          '    { "title": "断言式标题（不超过 30 字）", "bullets": ["要点 1", "要点 2", "要点 3"], "speakerNotes": "2-4 句讲稿：先说什么、证据是什么、如何过渡；可附建议视觉" }',
          "  ]",
          "}",
          "3. 标题必须是完整断言或问题，例如“检索增强把长文档问答准确率提升 18%”，不要写“实验结果”。",
          "4. 每页 3-5 个要点，每个要点不超过 40 个汉字；要点之间不重复；保留关键数字、数据集和术语，不编造原文没有的数字。",
          "5. speakerNotes 写 2-4 句，给出讲稿、证据/注意点和到下一页的过渡；可加“建议视觉：…”说明建议的图/表。",
          "6. 结果页必须让听众看出与谁比较、提升/下降多少；局限页必须具体，不要写“未来工作很多”这类空话。",
          "7. 全部使用简体中文，避免大段文字和 bullet 堆砌。",
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
          "First decide the audience and the one-sentence core message, then allocate slides along this storyline (drop what does not apply):",
          "1. Opening: the problem, why it matters now (1 slide; use a concrete example or counter-intuitive fact)",
          "2. Gap or core challenge (1 slide)",
          "3. Key idea and method (1-2 slides; emphasize the key design, not every module)",
          "4. Data and experimental setup (1 slide; only what is needed to interpret results)",
          "5. Key results (2-3 slides; include baselines, deltas, ablations or case evidence)",
          "6. Mechanism / boundary conditions / failure modes (1 slide if needed)",
          "7. Limitations and counterexamples (1 slide; state when the conclusion would not hold)",
          "8. Conclusion, implications and next steps (1 slide)",
          "",
          "Requirements:",
          "1. Output exactly one JSON object. No Markdown code fences, no explanation.",
          "2. JSON structure:",
          "{",
          '  "title": "Deck title (max 12 words)",',
          '  "subtitle": "Optional subtitle (max 10 words)",',
          '  "slides": [',
          '    { "title": "Assertion-style title (max 8 words)", "bullets": ["Point 1", "Point 2", "Point 3"], "speakerNotes": "2-4 sentences: what to say, evidence, transition; optional visual suggestion" }',
          "  ]",
          "}",
          '3. Titles must be complete assertions or questions, e.g. "Retrieval raises long-document QA accuracy by 18%", not "Results".',
          "4. 3-5 bullets per slide; each bullet at most 20 words; no repeated points; keep numbers, datasets and terms; never invent numbers absent from the paper.",
          '5. Write 2-4 sentences of speaker notes: the spoken point, evidence/caveat, and transition; optionally add "Suggested visual: ...".',
          "6. Results slides must show what is compared and how large the delta is; limitation slides must be concrete, not generic future-work filler.",
          "7. Use English. Avoid text walls and bullet dumping.",
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
