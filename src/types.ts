/**
 * Shared types for PaperMiner.
 */

/* ------------------------------------------------------------------ */
/* Journal ranking                                                     */
/* ------------------------------------------------------------------ */

export type JournalStatus =
  | "idle"
  | "loading"
  | "ok"
  | "notfound"
  | "error"
  | "unconfigured";

export type BadgeTone = "good" | "warn" | "bad" | "neutral" | "info";

export type JournalBadgeCategory =
  | "quartile"
  | "metric"
  | "cn"
  | "index"
  | "ranking"
  | "warning";

export interface RankBadge {
  key: string;
  /** Full human readable label, e.g. "中科院分区（升级版）". */
  label: string;
  /** Compact category label shown in the pill, e.g. "中科院". */
  shortLabel: string;
  /** Formatted value, e.g. "1区 TOP", "Q1", "收录". */
  value: string;
  tone: BadgeTone;
  category: JournalBadgeCategory;
}

/**
 * Raw EasyScholar payload. `official` is `data.officialRank.all`, `select` is
 * `data.officialRank.select`; all values are strings (some may be empty).
 */
export interface JournalRankData {
  publication: string;
  queriedName: string;
  fetchedAt: number;
  official: Record<string, string>;
  select: Record<string, string>;
  custom?: {
    rank?: string[];
    rankInfo?: Array<Record<string, string>>;
  };
}

export interface JournalResult {
  status: JournalStatus;
  publication: string;
  data?: JournalRankData;
  badges: RankBadge[];
  /** True when the journal appears in an early-warning list. */
  warning: boolean;
  /** Compact text for item-tree columns, e.g. "1区 TOP · IF 12.3". */
  shortText: string;
  error?: string;
  fetchedAt: number;
}

/* ------------------------------------------------------------------ */
/* AI                                                                  */
/* ------------------------------------------------------------------ */

export type AiPurpose = "chat" | "summary" | "translation" | "ppt";

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMRuntimeConfig {
  presetId: string;
  baseURL: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  stream: boolean;
}

export interface LLMChatOptions {
  purpose?: AiPurpose;
  /** Overrides the configured model. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Called for every text delta while streaming. */
  onDelta?: (delta: string, fullText: string) => void;
  /** Called for reasoning/thinking deltas if the provider returns them. */
  onReasoning?: (delta: string) => void;
  /** Disable streaming for this call. */
  stream?: boolean;
}

/* ------------------------------------------------------------------ */
/* Paper content                                                       */
/* ------------------------------------------------------------------ */

export interface PaperMeta {
  itemID: number;
  key: string;
  title: string;
  doi: string;
  journal: string;
  year: string;
  authors: string;
  abstract: string;
  itemType: string;
}

export interface PaperContext extends PaperMeta {
  /** Extracted full text (may be truncated). */
  text: string;
  fullTextLength: number;
  truncated: boolean;
  attachmentID?: number;
}

/* ------------------------------------------------------------------ */
/* Progress reporting                                                  */
/* ------------------------------------------------------------------ */

export interface ProgressReporter {
  (message: string, progress?: number): void;
}

/* ------------------------------------------------------------------ */
/* UI helpers                                                          */
/* ------------------------------------------------------------------ */

export interface ReaderSelection {
  text: string;
  /** Section of the document the selection belongs to. */
  doc: Document;
  /** Screen/layout rectangle of the selection, relative to `doc`'s window. */
  rect: { left: number; top: number; right: number; bottom: number };
  pageIndex?: number;
}
