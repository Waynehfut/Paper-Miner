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
      "用不超过 3 条说清这篇论文：①要解决什么问题；②核心方法是什么；③最强的证据是什么（写出数据集、指标和关键数值）。最后用一句话判断结论可信度。不要复述摘要，不要编造原文没有的数字。",
  },
  {
    label: "三遍阅读法",
    prompt:
      "按三遍阅读法带我读这篇论文。第一遍：只看标题、摘要、图表，用 5 句话概括；第二遍：读方法和实验，判断证据是否支持结论；第三遍：尝试复现关键结果。每遍输出「已理解 / 仍不确定 / 下一步读哪里」。",
  },
  {
    label: "证据审计",
    prompt:
      "列出论文的 3-5 个关键主张，逐条给出：原文证据、证据强度（强/中/弱）、缺失的验证。最后指出哪些结论属于过度推断，需要什么额外实验才能成立。",
  },
  {
    label: "批判性审阅",
    prompt:
      "以严格审稿人的视角评价这篇论文：基线比较是否公平？消融是否足以支持每个设计选择？结论的外部效度如何？统计不确定性和可复现性是否充分？至少给出 3 条具体、可操作的批评。",
  },
  {
    label: "局限与改进",
    prompt:
      "区分作者主动承认的局限与你独立发现的问题。每条局限说明：影响哪个结论、需要什么实验/数据来改进、如果无法改进应如何限定结论。",
  },
  {
    label: "复现要点",
    prompt:
      "整理复现这篇论文所需的信息清单：数据与划分、代码/模型、环境与依赖、关键超参数、评价指标、随机种子、算力需求，以及最可能失败的地方。缺失的信息明确写“原文未报告”。",
  },
  {
    label: "方法拆解",
    prompt:
      "用「输入 → 关键步骤 → 输出」拆解论文方法，说明每个模块解决什么问题、核心假设是什么、时间/空间复杂度如何、在什么条件下会失败。不要只复述方法章节。",
  },
  {
    label: "关键图表",
    prompt:
      "逐个解释论文的关键图/表：横纵坐标或对比对象是什么、最重要的趋势/差异是什么、这个证据是否支持作者的主张、有没有被省略的基线或误差信息。",
  },
  {
    label: "与我研究的关系",
    prompt:
      "分析这篇论文与我当前研究的关系：给出 3 条可迁移的思路或方法，并为每条配一个可验证的小实验；明确区分论文事实与你的推断。",
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
