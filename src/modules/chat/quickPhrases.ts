/**
 * User-configurable conversation templates ("quick phrases").
 *
 * Templates are stored one per line in the `chatQuickPhrases` preference.
 * A line may be `名称 | 提示词` or just a prompt. Defaults inspired by the
 * paper-chat plugin are always offered first; user lines are appended.
 */

import { getPref } from "../../utils/prefs";

export interface QuickPhrase {
  label: string;
  prompt: string;
}

export const MAX_QUICK_PHRASES = 12;

const DEFAULT_TEMPLATES: QuickPhrase[] = [
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

/** Defaults plus the user's custom templates, deduplicated by prompt. */
export function loadQuickPhrases(): QuickPhrase[] {
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

export function getDefaultTemplates(): QuickPhrase[] {
  return DEFAULT_TEMPLATES.map((phrase) => ({ ...phrase }));
}
