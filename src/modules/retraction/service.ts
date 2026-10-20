import type { RetractionResult } from "../../types";
import { pluginCache, CACHE_NAMESPACES } from "../../utils/cache";
import { t } from "../../utils/i18n";
import { getItemDOI, isPaperItem, normalizeDOI } from "../../utils/item";
import { errorToString, log } from "../../utils/log";
import { getNumberPref, getPref } from "../../utils/prefs";
import { getJSON } from "../journal/http";

/**
 * Retraction detection service.
 *
 * Sources, in order of authority:
 *   1. Zotero 10's built-in Retraction Watch database (`Zotero.Retractions`)
 *   2. OpenAlex (`is_retracted`)
 *   3. Crossref (`update-to` / `relation` pointing to a retraction notice)
 *
 * The service never throws: unresolvable situations are reported through
 * `RetractionResult.status` (`no-doi` / `unknown` / `error`), and any partial
 * conclusion is preserved.
 */

const CACHE_NS = CACHE_NAMESPACES.retraction;
const DEFAULT_CACHE_DAYS = 30;
/** Negative ("clear") answers are refreshed more often than retractions. */
const NEGATIVE_CACHE_MAX_DAYS = 7;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_PREFETCH = 20;

export const OPENALEX_WORK_URL = "https://api.openalex.org/works/doi:";
export const CROSSREF_WORK_URL = "https://api.crossref.org/works/";

export type RetractionSourceName = "zotero" | "openalex" | "crossref";

/** Result of querying a single source. */
export interface RetractionSourceOutcome {
  source: RetractionSourceName;
  /** False when the source had no data for this DOI (e.g. HTTP 404). */
  consulted: boolean;
  retracted: boolean;
  date?: string;
  reason?: string;
  details?: string;
  noticeDOI?: string;
  error?: string;
}

interface CachedRetraction {
  result: RetractionResult;
  at: number;
}

const inflight = new Map<string, Promise<RetractionResult>>();
const memoryCache = new Map<string, CachedRetraction>();

/**
 * Outbound OpenAlex/Crossref requests are serialized with a small gap so that
 * quickly browsing the item list cannot turn into a request storm.
 */
const MIN_REQUEST_INTERVAL_MS = 250;
let lastRequestAt = 0;
let requestQueue: Promise<unknown> = Promise.resolve();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scheduleSourceRequest<T>(task: () => Promise<T>): Promise<T> {
  const run = requestQueue.then(async () => {
    const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await delay(wait);
    lastRequestAt = Date.now();
    return task();
  });
  requestQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run as Promise<T>;
}

function cacheDays(): number {
  return getNumberPref("retractionCacheDays", DEFAULT_CACHE_DAYS, 1, 365, true);
}

function negativeCacheDays(): number {
  return Math.min(cacheDays(), NEGATIVE_CACHE_MAX_DAYS);
}

function isRetractionResult(value: unknown): value is RetractionResult {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as RetractionResult).status === "string",
  );
}

/* ------------------------------------------------------------------ */
/* Pure parsing helpers (exported for tests)                           */
/* ------------------------------------------------------------------ */

export function formatDateParts(value: unknown): string | undefined {
  // Crossref: { "date-parts": [[2020, 5, 1]] }
  if (value && typeof value === "object") {
    const parts = (value as { "date-parts"?: unknown })[
      "date-parts"
    ] as unknown;
    if (Array.isArray(parts) && Array.isArray(parts[0])) {
      const [year, month, day] = parts[0] as Array<number | undefined>;
      if (!year) return undefined;
      return [year, month ?? 1, day ?? 1]
        .map((part, index) =>
          index === 0
            ? String(part).padStart(4, "0")
            : String(part).padStart(2, "0"),
        )
        .join("-");
    }
    const timestamp = (value as { timestamp?: unknown }).timestamp;
    if (typeof timestamp === "number") {
      return new Date(timestamp).toISOString().slice(0, 10);
    }
  }
  if (typeof value === "string") {
    const match = value.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (match) return match[0];
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, "0"),
      String(value.getDate()).padStart(2, "0"),
    ].join("-");
  }
  return undefined;
}

export interface OpenAlexRetractionInfo {
  retracted: boolean;
  date?: string;
  openAlexId?: string;
}

/** Parse an OpenAlex `/works/doi:...` payload. Returns null when unusable. */
export function parseOpenAlexWork(raw: unknown): OpenAlexRetractionInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const work = raw as Record<string, unknown>;
  if (typeof work.is_retracted !== "boolean") return null;
  if (work.error) return null;
  const id = typeof work.id === "string" ? work.id : undefined;
  const date = formatDateParts(work.updated_date);
  return { retracted: work.is_retracted, date, openAlexId: id };
}

export interface CrossrefRetractionInfo {
  retracted: boolean;
  noticeDOI?: string;
  date?: string;
  reason?: string;
  noticeType?: string;
}

function isRetractionNoticeType(type: unknown): boolean {
  return /retract|withdraw|remov/i.test(String(type || ""));
}

/** Parse a Crossref `/works/{doi}` payload for retraction relations. */
export function parseCrossrefWork(raw: unknown): CrossrefRetractionInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const message = (raw as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const work = message as Record<string, unknown>;
  let retracted = false;
  let noticeDOI: string | undefined;
  let date: string | undefined;
  let noticeType: string | undefined;

  const updates = Array.isArray(work["update-to"])
    ? (work["update-to"] as Array<Record<string, unknown>>)
    : [];
  for (const update of updates) {
    if (!update || typeof update !== "object") continue;
    if (!isRetractionNoticeType(update.type)) continue;
    retracted = true;
    noticeType = noticeType || String(update.type || "");
    if (!noticeDOI && typeof update.DOI === "string") {
      noticeDOI = normalizeDOI(update.DOI) || undefined;
    }
    if (!date) date = formatDateParts(update.updated ?? update.created);
  }

  const relation = work.relation;
  if (relation && typeof relation === "object") {
    for (const [key, value] of Object.entries(
      relation as Record<string, unknown>,
    )) {
      if (!/retract|withdraw/i.test(key)) continue;
      retracted = true;
      const entries = Array.isArray(value) ? value : [value];
      for (const entry of entries) {
        const id =
          entry && typeof entry === "object"
            ? (entry as Record<string, unknown>).id
            : entry;
        if (typeof id === "string") {
          const normalized = normalizeDOI(id);
          if (normalized && !noticeDOI) noticeDOI = normalized;
        }
      }
    }
  }

  if (!retracted) return { retracted: false };
  const updatedDate = date || formatDateParts(work.updated) || undefined;
  return {
    retracted: true,
    noticeDOI,
    date: updatedDate,
    reason: noticeType ? String(noticeType) : undefined,
    noticeType,
  };
}

export interface ZoteroRetractionData {
  retracted: boolean;
  reasons: string[];
  date?: string;
  noticeDOI?: string;
  urls: string[];
}

/**
 * Interpret the object returned by `Zotero.Retractions.getData(item)`.
 * Shape: `{ doi, date, reasons: string[], urls: string[] }` where `doi` is the
 * DOI of the retraction notice.
 */
export function interpretZoteroData(data: unknown): ZoteroRetractionData {
  const result: ZoteroRetractionData = {
    retracted: Boolean(data),
    reasons: [],
    urls: [],
  };
  if (!data || typeof data !== "object") return result;
  const payload = data as Record<string, unknown>;
  if (Array.isArray(payload.reasons)) {
    result.reasons = payload.reasons
      .map((reason) => String(reason || "").trim())
      .filter(Boolean);
  }
  result.date = formatDateParts(payload.date ?? payload.originalDate);
  const noticeDOI = normalizeDOI(
    String(payload.doi || payload.retractionDOI || ""),
  );
  if (noticeDOI) result.noticeDOI = noticeDOI;
  if (Array.isArray(payload.urls)) {
    result.urls = payload.urls
      .map((url) => String(url || "").trim())
      .filter(Boolean);
  }
  return result;
}

/** Map reason codes to the Retraction Watch English descriptions. */
export function describeZoteroReasons(
  reasons: string[],
  describe: (reason: string) => string,
): string {
  const texts: string[] = [];
  for (const reason of reasons) {
    let description = "";
    try {
      description = describe(reason) || "";
    } catch {
      description = "";
    }
    texts.push(description || reason);
  }
  return texts.filter(Boolean).join("\n");
}

/** Merge the per-source outcomes into the public result shape. */
export function mergeRetractionOutcomes(
  doi: string,
  outcomes: RetractionSourceOutcome[],
): RetractionResult {
  const consulted = outcomes.filter((outcome) => outcome.consulted);
  const sources = consulted.map((outcome) => outcome.source);
  const retractedOutcome = consulted.find((outcome) => outcome.retracted);
  const checkedAt = Date.now();
  if (retractedOutcome) {
    const pick = <T>(key: keyof RetractionSourceOutcome): T | undefined => {
      const primary = retractedOutcome[key];
      if (primary) return primary as T;
      for (const outcome of consulted) {
        const value = outcome[key];
        if (value) return value as T;
      }
      return undefined;
    };
    return {
      status: "retracted",
      sources,
      retracted: true,
      doi,
      date: pick<string>("date"),
      reason: pick<string>("reason"),
      noticeDOI: pick<string>("noticeDOI"),
      details: pick<string>("details"),
      checkedAt,
    };
  }
  if (consulted.length) {
    return {
      status: "clear",
      sources,
      retracted: false,
      doi,
      checkedAt,
    };
  }
  const errors = outcomes
    .map((outcome) => outcome.error)
    .filter((error): error is string => Boolean(error));
  if (errors.length) {
    return {
      status: "error",
      sources: [],
      retracted: false,
      doi,
      error: errors[0],
      checkedAt,
    };
  }
  return { status: "unknown", sources: [], retracted: false, doi, checkedAt };
}

/* ------------------------------------------------------------------ */
/* Source queries                                                      */
/* ------------------------------------------------------------------ */

async function checkZotero(
  item: Zotero.Item,
): Promise<RetractionSourceOutcome> {
  const outcome: RetractionSourceOutcome = {
    source: "zotero",
    consulted: false,
    retracted: false,
  };
  const retractions = (Zotero as unknown as { Retractions?: any }).Retractions;
  if (!retractions || typeof retractions.isRetracted !== "function") {
    return outcome;
  }
  let retracted = false;
  try {
    retracted = Boolean(retractions.isRetracted(item));
  } catch (error) {
    outcome.error = `Zotero Retractions: ${errorToString(error)}`;
    return outcome;
  }
  outcome.consulted = true;
  outcome.retracted = retracted;
  if (!retracted) return outcome;
  let data: unknown = null;
  try {
    if (typeof retractions.getData === "function") {
      data = await retractions.getData(item);
    }
  } catch (error) {
    log("Zotero.Retractions.getData failed:", errorToString(error));
  }
  const info = interpretZoteroData(data);
  outcome.date = info.date;
  outcome.noticeDOI = info.noticeDOI;
  if (info.reasons.length) {
    outcome.reason = info.reasons.join("；");
    const details = describeZoteroReasons(info.reasons, (reason) => {
      try {
        return retractions.getReasonDescription?.(reason) || "";
      } catch {
        return "";
      }
    });
    outcome.details = details || undefined;
  } else if (info.urls.length) {
    outcome.details = info.urls[0];
  }
  return outcome;
}

async function checkOpenAlex(doi: string): Promise<RetractionSourceOutcome> {
  const outcome: RetractionSourceOutcome = {
    source: "openalex",
    consulted: false,
    retracted: false,
  };
  const response = await scheduleSourceRequest(() =>
    getJSON(OPENALEX_WORK_URL + doi, { timeoutMs: REQUEST_TIMEOUT_MS }),
  );
  if (response.status === 0) {
    outcome.error = response.timeout
      ? t("retraction-timeout", "OpenAlex 请求超时")
      : t("retraction-network", "网络请求失败，请检查网络连接");
    return outcome;
  }
  if (response.status === 404) return outcome;
  if (!response.ok) return outcome;
  const info = parseOpenAlexWork(response.json);
  if (!info) return outcome;
  outcome.consulted = true;
  outcome.retracted = info.retracted;
  outcome.date = info.date;
  if (info.retracted) {
    outcome.details = info.openAlexId
      ? `OpenAlex: ${info.openAlexId}`
      : "OpenAlex 标记为已撤稿";
  }
  return outcome;
}

async function checkCrossref(doi: string): Promise<RetractionSourceOutcome> {
  const outcome: RetractionSourceOutcome = {
    source: "crossref",
    consulted: false,
    retracted: false,
  };
  const response = await scheduleSourceRequest(() =>
    getJSON(CROSSREF_WORK_URL + encodeURIComponent(doi), {
      timeoutMs: REQUEST_TIMEOUT_MS,
    }),
  );
  if (response.status === 0) {
    outcome.error = response.timeout
      ? t("retraction-timeout", "Crossref 请求超时")
      : t("retraction-network", "网络请求失败，请检查网络连接");
    return outcome;
  }
  if (response.status === 404) return outcome;
  if (!response.ok) return outcome;
  const info = parseCrossrefWork(response.json);
  if (!info) return outcome;
  outcome.consulted = true;
  outcome.retracted = info.retracted;
  outcome.date = info.date;
  outcome.noticeDOI = info.noticeDOI;
  if (info.retracted) {
    outcome.reason =
      info.noticeType === "withdrawal"
        ? t("retraction-withdrawn", "论文已被撤稿/撤回")
        : t("retraction-retracted", "该论文已被撤稿");
  }
  return outcome;
}

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

async function readCacheEntry(
  key: string,
): Promise<RetractionResult | undefined> {
  const memory = memoryCache.get(key);
  const entry = memory;
  if (entry) {
    const allowed =
      entry.result.status === "retracted" ? cacheDays() : negativeCacheDays();
    if (Date.now() - entry.at <= allowed * 24 * 60 * 60 * 1000) {
      return entry.result;
    }
    memoryCache.delete(key);
  }
  const cached = await pluginCache.get<CachedRetraction>(CACHE_NS, key);
  if (!cached || !isRetractionResult(cached.result)) return undefined;
  const allowed =
    cached.result.status === "retracted" ? cacheDays() : negativeCacheDays();
  if (Date.now() - (cached.at || 0) > allowed * 24 * 60 * 60 * 1000) {
    void pluginCache.delete(CACHE_NS, key);
    return undefined;
  }
  memoryCache.set(key, cached);
  return cached.result;
}

/** Synchronous lookup in the in-memory cache (used by the item-tree column). */
export function getCachedRetractionStatus(
  doi: string,
): RetractionResult | undefined {
  const key = String(doi || "")
    .trim()
    .toLowerCase();
  if (!key) return undefined;
  const entry = memoryCache.get(key);
  if (!entry) return undefined;
  const allowed =
    entry.result.status === "retracted" ? cacheDays() : negativeCacheDays();
  if (Date.now() - entry.at > allowed * 24 * 60 * 60 * 1000) {
    memoryCache.delete(key);
    return undefined;
  }
  return entry.result;
}

async function writeCacheEntry(
  key: string,
  result: RetractionResult,
): Promise<void> {
  const entry: CachedRetraction = { result, at: Date.now() };
  memoryCache.set(key, entry);
  await pluginCache.set(CACHE_NS, key, entry);
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

async function detectRetraction(
  item: Zotero.Item,
  doi: string,
  options: { force?: boolean },
): Promise<RetractionResult> {
  const key = doi.toLowerCase();
  if (!options.force) {
    const cached = await readCacheEntry(key);
    if (cached) return { ...cached, doi, checkedAt: cached.checkedAt };
  } else {
    memoryCache.delete(key);
    await pluginCache.delete(CACHE_NS, key);
  }

  const pending = inflight.get(key);
  if (pending) return pending;

  const task = (async (): Promise<RetractionResult> => {
    const outcomes: RetractionSourceOutcome[] = [];
    const checks: Array<Promise<RetractionSourceOutcome>> = [];
    if (getPref("retractionUseZotero")) checks.push(checkZotero(item));
    if (getPref("retractionUseOpenAlex")) checks.push(checkOpenAlex(doi));
    if (getPref("retractionUseCrossref")) {
      checks.push(checkCrossref(doi));
    }
    if (!checks.length) {
      return {
        status: "unknown",
        sources: [],
        retracted: false,
        doi,
        error: t(
          "retraction-no-source",
          "未启用任何撤稿检测来源，请在设置中开启",
        ),
        checkedAt: Date.now(),
      };
    }
    const settled = await Promise.allSettled(checks);
    for (const result of settled) {
      if (result.status === "fulfilled") {
        outcomes.push(result.value);
      } else {
        log("retraction source failed:", errorToString(result.reason));
      }
    }
    const merged = mergeRetractionOutcomes(doi, outcomes);
    if (merged.status === "retracted" || merged.status === "clear") {
      await writeCacheEntry(key, merged);
    }
    return merged;
  })();

  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}

/** Retraction status for a Zotero item. */
export async function getRetractionStatus(
  item: Zotero.Item,
  options: { force?: boolean } = {},
): Promise<RetractionResult> {
  const empty: RetractionResult = {
    status: "idle",
    sources: [],
    retracted: false,
    checkedAt: 0,
  };
  if (!item || !item.isRegularItem() || !isPaperItem(item)) return empty;
  if (!getPref("retractionEnabled")) {
    return {
      status: "unknown",
      sources: [],
      retracted: false,
      error: t("retraction-disabled", "撤稿检测未启用"),
      checkedAt: 0,
    };
  }
  const doi = getItemDOI(item);
  if (!doi) {
    return {
      status: "no-doi",
      sources: [],
      retracted: false,
      error: t("journal-no-doi", "该条目没有 DOI，无法进行撤稿检测"),
      checkedAt: Date.now(),
    };
  }
  try {
    return await detectRetraction(item, doi, options);
  } catch (error) {
    log("getRetractionStatus failed:", doi, errorToString(error));
    return {
      status: "error",
      sources: [],
      retracted: false,
      doi,
      error: t("retraction-error", "撤稿检测失败，请稍后重试"),
      checkedAt: Date.now(),
    };
  }
}

/** Warm the retraction cache for a list of items (deduplicated by DOI). */
export async function prefetchRetractions(items: Zotero.Item[]): Promise<void> {
  if (!getPref("retractionEnabled")) return;
  if (!Array.isArray(items) || !items.length) return;
  const seen = new Set<string>();
  const targets: Zotero.Item[] = [];
  for (const item of items) {
    if (!item || !item.isRegularItem() || !isPaperItem(item)) continue;
    const doi = getItemDOI(item);
    if (!doi) continue;
    const key = doi.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(item);
    if (targets.length >= MAX_PREFETCH) break;
  }
  for (const item of targets) {
    try {
      await getRetractionStatus(item);
    } catch (error) {
      log("prefetch retraction failed:", errorToString(error));
    }
  }
}

export async function clearRetractionCache(): Promise<void> {
  inflight.clear();
  memoryCache.clear();
  try {
    await pluginCache.clear(CACHE_NS);
  } catch (error) {
    log("clearRetractionCache failed:", errorToString(error));
  }
}
