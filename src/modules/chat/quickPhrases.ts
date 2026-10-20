/**
 * Conversation skills.
 *
 * A skill has a name and an instruction. Rows marked `global` are appended to
 * the system prompt on every turn; the others become one-off conversation
 * templates. Keeping both in one list avoids duplicating the same instruction
 * in two separate settings.
 *
 * The list is stored as JSON in `chatSkills`; the old `chatQuickPhrases` line
 * format and the old `chatSystemPrompt` preference are still migrated when
 * loading an existing install.
 */

import { getPref, setPref } from "../../utils/prefs";

export interface QuickPhrase {
  label: string;
  prompt: string;
  /** True: always sent as a system rule; false/undefined: one-off template. */
  global?: boolean;
}

export const MAX_QUICK_PHRASES = 50;

export const DEFAULT_TEMPLATES: QuickPhrase[] = [
  {
    label: "总结核心贡献",
    prompt:
      "请用 3-5 句话总结这篇论文的核心贡献：它解决了什么问题、提出了什么方法、最重要的结论是什么。",
  },
  {
    label: "通俗解释方法",
    prompt:
      "请用通俗易懂的语言解释这篇论文的方法，假设读者不是该领域的专家；必要时给出一个类比。",
  },
  {
    label: "批判性审阅",
    prompt:
      "请从审稿人的角度批判性评价这篇论文：研究问题是否重要、方法是否严谨、实验是否充分、结论是否有过度推断？",
  },
  {
    label: "局限与改进",
    prompt:
      "这篇论文有哪些局限性？如果让你继续这项研究，你会如何改进实验设计或补充哪些证据？",
  },
  {
    label: "复现要点",
    prompt:
      "请提炼复现这篇论文所需的关键信息：数据、模型/方法、超参数、评价指标、以及可能影响复现的细节。",
  },
  {
    label: "与我研究的关系",
    prompt:
      "请分析这篇论文可能与我当前研究的关系，并给出 2-3 条可以借鉴或继续推进的研究想法。",
  },
];

export function parseQuickPhrases(text: string): QuickPhrase[] {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const result: QuickPhrase[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const match = line.match(/^(.{1,40}?)\s*[|｜]\s*(.+)$/);
    const label = match
      ? match[1].trim()
      : line.length > 18
        ? `${line.slice(0, 18)}…`
        : line;
    const prompt = (match ? match[2] : line).trim();
    if (!prompt || seen.has(prompt)) continue;
    seen.add(prompt);
    result.push({ label: label || prompt.slice(0, 18), prompt });
    if (result.length >= MAX_QUICK_PHRASES) break;
  }
  return result;
}

function hasGlobalFlag(record: Record<string, unknown>): boolean {
  return (
    record.global === true ||
    record.system === true ||
    record.scope === "system" ||
    record.mode === "system"
  );
}

/** Parse a JSON skill list, or fall back to the legacy `名称 | 提示词` text. */
export function parseSkillsPayload(text: string): QuickPhrase[] {
  const raw = String(text || "").trim();
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return parseQuickPhrases(raw);
  }
  let items: unknown[] = [];
  if (Array.isArray(data)) {
    items = data;
  } else if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const candidate = record.skills ?? record.templates ?? record.items;
    if (Array.isArray(candidate)) items = candidate;
  }
  const result: QuickPhrase[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    let label = "";
    let prompt = "";
    let global = false;
    if (typeof item === "string") {
      const parsed = parseQuickPhrases(item)[0];
      if (parsed) {
        label = parsed.label;
        prompt = parsed.prompt;
      }
    } else if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      label = String(record.label ?? record.name ?? "").trim();
      prompt = String(
        record.prompt ?? record.instruction ?? record.content ?? "",
      ).trim();
      global = hasGlobalFlag(record);
    }
    if (!prompt || seen.has(prompt)) continue;
    seen.add(prompt);
    result.push({
      label: label || prompt.slice(0, 18),
      prompt,
      ...(global ? { global: true } : {}),
    });
    if (result.length >= MAX_QUICK_PHRASES) break;
  }
  return result;
}

function legacyRows(): QuickPhrase[] {
  let custom: QuickPhrase[] = [];
  try {
    custom = parseQuickPhrases(String(getPref("chatQuickPhrases") || ""));
  } catch {
    custom = [];
  }
  const result: QuickPhrase[] = [];
  const seen = new Set<string>();
  for (const phrase of [...DEFAULT_TEMPLATES, ...custom]) {
    if (!phrase.prompt || seen.has(phrase.prompt)) continue;
    seen.add(phrase.prompt);
    result.push(phrase);
    if (result.length >= MAX_QUICK_PHRASES) break;
  }
  return result;
}

/**
 * All skill rows, including global system rules. Existing installs that used
 * the separate `chatSystemPrompt` box get that text as one visible global row.
 */
export function loadSkillRows(): QuickPhrase[] {
  let rows: QuickPhrase[] = [];
  try {
    const raw = String(getPref("chatSkills") || "").trim();
    rows = raw ? parseSkillsPayload(raw) : legacyRows();
  } catch {
    rows = legacyRows();
  }
  const systemPrompt = String(getPref("chatSystemPrompt") || "").trim();
  if (systemPrompt && !rows.some((row) => row.global)) {
    rows.unshift({
      label: "自定义系统提示词",
      prompt: systemPrompt,
      global: true,
    });
  }
  return rows.slice(0, MAX_QUICK_PHRASES);
}

/** Only the one-off templates shown in the chat panel. */
export function loadQuickPhrases(): QuickPhrase[] {
  return loadSkillRows().filter((row) => !row.global);
}

/** Global rows, joined into the extra system instructions. */
export function getSystemInstructions(): string {
  return loadSkillRows()
    .filter((row) => row.global && row.prompt.trim())
    .map((row) => row.prompt.trim())
    .join("\n\n");
}

/**
 * Save all rows. `chatSystemPrompt` is kept in sync for compatibility with
 * older builds and with users who inspect their preferences.
 */
export function saveSkillRows(rows: QuickPhrase[]): void {
  const normalized = rows
    .map((row) => ({
      label: String(row.label || "").trim() || "未命名技能",
      prompt: String(row.prompt || "").trim(),
      ...(row.global ? { global: true } : {}),
    }))
    .filter((row) => row.prompt)
    .slice(0, MAX_QUICK_PHRASES);
  setPref("chatSkills", JSON.stringify(normalized) as never);
  setPref(
    "chatSystemPrompt",
    normalized
      .filter((row) => row.global)
      .map((row) => row.prompt)
      .join("\n\n") as never,
  );
}

/** Backwards-compatible helper for tests/extensions. */
export function saveQuickPhrases(phrases: QuickPhrase[]): void {
  saveSkillRows(phrases);
}

export function getDefaultTemplates(): QuickPhrase[] {
  return DEFAULT_TEMPLATES.map((phrase) => ({ ...phrase }));
}
