import type {
  JournalRankData,
  JournalResult,
  JournalStatus,
} from "../../types";
import { pluginCache, CACHE_NAMESPACES } from "../../utils/cache";
import { getPluginDataDir, joinPath, readJSONFile } from "../../utils/fs";
import { t } from "../../utils/i18n";
import {
  getItemPublication,
  getItemPublicationCandidates,
  isPaperItem,
} from "../../utils/item";
import { log, errorToString } from "../../utils/log";
import { getNumberPref, getPref } from "../../utils/prefs";
import {
  buildBadges,
  DEFAULT_ENABLED_FIELDS,
  formatShortText,
  getFieldValue,
  isWarningValue,
  JOURNAL_FIELDS,
  normalizePublicationName,
} from "./fields";
import { getJSON } from "./http";

/**
 * EasyScholar journal ranking service.
 *
 * The public API is intentionally defensive: every promise resolves with a
 * `JournalResult` whose `status` describes what happened, so UI code never
 * has to deal with raw HTTP errors or stacks.
 */

const CACHE_NS = CACHE_NAMESPACES.journal;
const NEGATIVE_PREFIX = "!";
const NEGATIVE_CACHE_DAYS = 7;
const REQUEST_TIMEOUT_MS = 20000;
/** Minimal spacing between two EasyScholar calls (free keys are rate limited). */
const MIN_REQUEST_INTERVAL_MS = 400;
const MAX_PREFETCH = 20;
const CACHE_FILE_NAME = "cache.json";

export const EASY_SCHOLAR_ENDPOINTS = [
  "https://www.easyscholar.cc/open/getPublicationRank",
  "https://easyscholar.cc/open/getPublicationRank",
] as const;

export interface ParsedJournalRank {
  official: Record<string, string>;
  select: Record<string, string>;
}

const memoryCache = new Map<string, JournalRankData>();
const inflight = new Map<string, Promise<JournalResult>>();

let statsCount = 0;
let statsLoaded = false;
let statsLoading = false;
let cacheGeneration = 0;

let requestQueue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isExpired(fetchedAt: number | undefined, ttlDays: number): boolean {
  if (!fetchedAt || ttlDays <= 0) return false;
  return Date.now() - fetchedAt > ttlDays * 24 * 60 * 60 * 1000;
}

function toStringRecord(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!value || typeof value !== "object") return result;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key === "select" || key === "all" || key === "officialRank") continue;
    if (
      typeof raw !== "string" &&
      typeof raw !== "number" &&
      typeof raw !== "boolean"
    ) {
      continue;
    }
    const text = String(raw).trim();
    if (!text) continue;
    result[key] = text;
  }
  return result;
}

/**
 * Parse an EasyScholar `open/getPublicationRank` payload.
 *
 * Supported shapes (API versions differ):
 *   { code: 200, data: { officialRank: { all: {...}, select: {...} } } }
 *   { code: 200, data: { all: {...}, select: {...} } }
 *   { code: 200, data: { sci: "1区", sciif: "12.3", ... } }
 *
 * Returns `null` when the response does not contain any rank data.
 */
export function parseEasyScholarResponse(
  raw: unknown,
): ParsedJournalRank | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as Record<string, unknown>;
  const code = payload.code ?? payload.status;
  if (code !== undefined && code !== null && String(code).trim() !== "") {
    if (Number(code) !== 200) return null;
  }
  const data = (payload.data as Record<string, unknown> | undefined) ?? payload;
  if (!data || typeof data !== "object") return null;
  const rankSource =
    (data.officialRank as Record<string, unknown> | undefined) ??
    (data.rank as Record<string, unknown> | undefined) ??
    data;
  if (!rankSource || typeof rankSource !== "object") return null;

  const rawOfficial = toStringRecord(
    (rankSource as Record<string, unknown>).all ?? rankSource,
  );
  const rawSelect = toStringRecord(
    (rankSource as Record<string, unknown>).select,
  );
  if (!Object.keys(rawOfficial).length && !Object.keys(rawSelect).length) {
    return null;
  }
  // Union both maps so a field that only exists in one of them is still
  // resolved by the badge helpers (EasyScholar moved fields between the two
  // maps across API versions).
  return {
    official: { ...rawSelect, ...rawOfficial },
    select: { ...rawOfficial, ...rawSelect },
  };
}

/** Extract the canonical journal name returned by EasyScholar, if any. */
export function extractPublicationName(raw: unknown): string {
  const data = (raw as { data?: Record<string, any> } | null)?.data;
  if (!data || typeof data !== "object") return "";
  const candidates = [
    data.publicationName,
    data.name,
    data.journalName,
    data.officialRank?.publicationName,
    data.officialRank?.name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

/** Field keys currently enabled in preferences (falls back to defaults). */
export function getEnabledFieldKeys(): string[] {
  const raw = String(getPref("journalFields") || "").trim();
  if (!raw) return [...DEFAULT_ENABLED_FIELDS];
  const known = new Set(JOURNAL_FIELDS.map((field) => field.key));
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => Boolean(item) && known.has(item));
}

/**
 * Whether the journal appears in an early-warning list. Independent of the
 * display preferences: a warning must never be hidden accidentally.
 */
export function detectJournalWarning(
  data: JournalRankData | undefined,
): boolean {
  if (!data) return false;
  for (const definition of JOURNAL_FIELDS) {
    if (!definition.warning) continue;
    if (isWarningValue(getFieldValue(data, definition))) return true;
  }
  for (const map of [data.official, data.select]) {
    if (!map) continue;
    for (const key of Object.keys(map)) {
      if (!/warn|alert|risk/i.test(key)) continue;
      if (isWarningValue(map[key])) return true;
    }
  }
  return false;
}

function buildShortText(data: JournalRankData, warning: boolean): string {
  const fields = getEnabledFieldKeys();
  let text = "";
  try {
    text = formatShortText(data, fields);
  } catch (error) {
    log("formatShortText failed:", errorToString(error));
  }
  if (warning && !text.includes("预警")) {
    text = text ? `${text} · 预警` : "预警";
  }
  return text;
}

/** Build an `ok` result from cached/fresh rank data. */
export function buildJournalResult(
  data: JournalRankData,
  publication?: string,
): JournalResult {
  const fields = getEnabledFieldKeys();
  const warning = detectJournalWarning(data);
  return {
    status: "ok",
    publication: publication || data.publication || data.queriedName || "",
    data,
    badges: buildBadges(data, fields),
    warning,
    shortText: buildShortText(data, warning),
    fetchedAt: data.fetchedAt || Date.now(),
  };
}

function emptyResult(
  publication: string,
  status: JournalStatus,
  error?: string,
  fetchedAt = 0,
): JournalResult {
  return {
    status,
    publication,
    badges: [],
    warning: false,
    shortText: "",
    fetchedAt,
    ...(error ? { error } : {}),
  };
}

/** Normalized cache key for a journal name. */
export function normalizeJournalKey(name: string): string {
  return normalizePublicationName(String(name || ""))
    .toLowerCase()
    .replace(/\s+/g, " ");
}

const PNAS_FULL_NAME =
  "PROCEEDINGS OF THE NATIONAL ACADEMY OF SCIENCES OF THE UNITED STATES OF AMERICA";

/**
 * Expand a few well-known abbreviations / short titles to the journal name
 * EasyScholar indexes under, so both forms share one cache entry.
 */
const JOURNAL_ALIASES: Array<{ test: RegExp; name: string }> = [
  { test: /^pnas$/i, name: PNAS_FULL_NAME },
  {
    test: /^proceedings of the national academy of sciences( of the united states of america)?$/i,
    name: PNAS_FULL_NAME,
  },
];

/** Expand a journal name alias (currently PNAS), otherwise normalize it. */
export function expandJournalAlias(name: string): string {
  const normalized = normalizePublicationName(String(name || ""));
  if (!normalized) return "";
  for (const alias of JOURNAL_ALIASES) {
    if (alias.test.test(normalized)) return alias.name;
  }
  return normalized;
}

/** Cache key including alias expansion; used by every lookup path. */
export function journalCacheKey(name: string): string {
  return normalizeJournalKey(expandJournalAlias(name));
}

/** Synchronous lookup in the in-memory cache (used by the item-tree column). */
export function getCachedJournalRank(
  publication: string,
): JournalResult | undefined {
  const key = journalCacheKey(publication);
  if (!key) return undefined;
  const data = memoryCache.get(key);
  if (!data) return undefined;
  const ttlDays = getNumberPref("journalCacheDays", 30, 1, 365, true);
  if (isExpired(data.fetchedAt, ttlDays)) {
    memoryCache.delete(key);
    return undefined;
  }
  return buildJournalResult(data);
}

function buildUrl(endpoint: string, secretKey: string, name: string): string {
  return (
    `${endpoint}?secretKey=${encodeURIComponent(secretKey)}` +
    `&publicationName=${encodeURIComponent(name)}`
  );
}

/** Serialize outbound EasyScholar requests with a small fixed delay. */
function scheduleEasyScholarRequest<T>(task: () => Promise<T>): Promise<T> {
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

interface EasyScholarFetchOutcome {
  status: JournalStatus;
  data?: JournalRankData;
  error?: string;
  /** Structured error kind so the UI can offer the right fix (e.g. settings). */
  errorKind?: EasyScholarErrorKind;
}

export type EasyScholarErrorKind = "key" | "rate" | "notfound";

/**
 * Classify an EasyScholar business code or an HTTP status code. Pure logic so
 * it can be unit tested without touching the network.
 *
 * EasyScholar returns HTTP 200 with a business `code` in the body, e.g.
 *   { "code": 40002, "msg": "Key错误", "data": null }
 *   40001-40005: key missing / invalid / expired / unauthorized
 *   40006-40009: quota or rate limited
 */
export function classifyErrorCode(
  code: unknown,
): EasyScholarErrorKind | undefined {
  const numeric = Number(code);
  if (!Number.isFinite(numeric)) return undefined;
  if (numeric === 429) return "rate";
  if (numeric === 404) return "notfound";
  if (numeric === 400 || numeric === 401 || numeric === 403) return "key";
  if (numeric >= 40001 && numeric <= 40005) return "key";
  if (numeric >= 40006 && numeric <= 40009) return "rate";
  return undefined;
}

function normalizeErrorMessage(message?: string): string {
  const text = String(message || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

function withDetail(hint: string, detail: string): string {
  if (!detail) return hint;
  if (hint.includes(detail) || detail.includes(hint)) return hint;
  return `${hint}（${detail}）`;
}

/**
 * Map an EasyScholar / HTTP error code to an actionable message. The raw
 * upstream `msg` is kept as a detail suffix, but the primary text is always a
 * Chinese instruction the user can act on.
 */
export function mapErrorCode(
  code: unknown,
  message?: string,
): string | undefined {
  const kind = classifyErrorCode(code);
  if (!kind) return undefined;
  const detail = normalizeErrorMessage(message);
  if (kind === "key") {
    return withDetail(
      t("journal-key-invalid", "EasyScholar 密钥无效或为空，请到设置中更新"),
      detail,
    );
  }
  if (kind === "rate") {
    return withDetail(
      t("journal-rate-limit", "EasyScholar 请求过于频繁或额度不足，请稍后再试"),
      detail,
    );
  }
  return withDetail(t("journal-notfound", "EasyScholar 未收录该期刊"), detail);
}

/** Read the human readable message from an EasyScholar payload. */
export function extractApiMessage(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const payload = raw as Record<string, unknown>;
  for (const key of ["msg", "message", "errorMsg", "errmsg", "error"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

async function requestEasyScholar(
  secretKey: string,
  name: string,
): Promise<EasyScholarFetchOutcome> {
  let lastError = "";
  for (const endpoint of EASY_SCHOLAR_ENDPOINTS) {
    const response = await getJSON(buildUrl(endpoint, secretKey, name), {
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (response.status === 0) {
      lastError = response.timeout
        ? t("journal-timeout", "EasyScholar 请求超时，请检查网络后重试")
        : t("journal-network", "网络请求失败，请检查网络连接");
      continue;
    }
    if (!response.ok) {
      const apiMessage = extractApiMessage(response.json);
      const mappedStatus = mapErrorCode(response.status, apiMessage);
      if (mappedStatus) {
        if (response.status === 404) {
          lastError = mappedStatus;
          continue;
        }
        return {
          status: "error",
          error: mappedStatus,
          errorKind: classifyErrorCode(response.status),
        };
      }
      lastError = `HTTP ${response.status}`;
      continue;
    }
    const parsed = parseEasyScholarResponse(response.json);
    if (
      parsed &&
      (Object.keys(parsed.official).length || Object.keys(parsed.select).length)
    ) {
      const apiCode = (response.json as { code?: unknown } | undefined)?.code;
      const mapped = mapErrorCode(apiCode, extractApiMessage(response.json));
      if (mapped) {
        return {
          status: "error",
          error: mapped,
          errorKind: classifyErrorCode(apiCode),
        };
      }
      const fetchedAt = Date.now();
      return {
        status: "ok",
        data: {
          publication: extractPublicationName(response.json) || name,
          queriedName: name,
          fetchedAt,
          official: parsed.official,
          select: parsed.select,
        },
      };
    }
    // HTTP 200 but no usable rank data: EasyScholar reports "not found" this
    // way for journals missing from its database.
    const apiCode = (response.json as { code?: unknown } | undefined)?.code;
    const mapped = mapErrorCode(apiCode, extractApiMessage(response.json));
    if (mapped) {
      const kind = classifyErrorCode(apiCode);
      if (kind === "notfound") return { status: "notfound" };
      return { status: "error", error: mapped, errorKind: kind };
    }
    if (apiCode === undefined || apiCode === null || Number(apiCode) === 200) {
      return { status: "notfound" };
    }
    lastError = `接口返回 ${String(apiCode)}`;
  }
  return {
    status: "error",
    error: lastError || t("journal-error", "获取期刊信息失败"),
  };
}

async function readFreshCache(
  key: string,
  ttlDays: number,
): Promise<JournalRankData | undefined> {
  const memory = memoryCache.get(key);
  if (memory) {
    if (!isExpired(memory.fetchedAt, ttlDays)) return memory;
    memoryCache.delete(key);
  }
  const cached = await pluginCache.get<JournalRankData>(CACHE_NS, key, ttlDays);
  if (!cached || typeof cached !== "object") return undefined;
  if (!cached.official && !cached.select) return undefined;
  memoryCache.set(key, cached);
  return cached;
}

/**
 * Look up journal ranking data by journal name.
 */
export async function getJournalRankByName(
  publication: string,
  options: { force?: boolean } = {},
): Promise<JournalResult> {
  const rawName = String(publication || "").trim();
  if (!getPref("journalEnabled")) {
    return emptyResult(
      rawName,
      "unconfigured",
      t("journal-disabled", "期刊分区功能未启用"),
    );
  }
  const secretKey = String(getPref("journalSecretKey") || "").trim();
  if (!secretKey) {
    return emptyResult(
      rawName,
      "unconfigured",
      t("journal-unconfigured", "尚未配置 EasyScholar 密钥，点击前往设置"),
    );
  }
  const name = expandJournalAlias(rawName);
  if (!name) {
    return emptyResult(rawName, "notfound", t("journal-empty", "无期刊信息"));
  }
  const key = normalizeJournalKey(name);
  const ttlDays = getNumberPref("journalCacheDays", 30, 1, 365, true);

  if (!options.force) {
    const cached = await readFreshCache(key, ttlDays);
    if (cached) return buildJournalResult(cached);
    const negative = await pluginCache.get<{ at: number }>(
      CACHE_NS,
      NEGATIVE_PREFIX + key,
      NEGATIVE_CACHE_DAYS,
    );
    if (negative) {
      return emptyResult(
        name,
        "notfound",
        t("journal-notfound", "EasyScholar 未收录该期刊"),
        negative.at || 0,
      );
    }
  } else {
    memoryCache.delete(key);
    await pluginCache.delete(CACHE_NS, key);
    await pluginCache.delete(CACHE_NS, NEGATIVE_PREFIX + key);
  }

  const pending = inflight.get(key);
  if (pending) return pending;

  const generation = cacheGeneration;
  const task = (async (): Promise<JournalResult> => {
    try {
      const outcome = await scheduleEasyScholarRequest(() =>
        requestEasyScholar(secretKey, name),
      );
      if (outcome.status === "ok" && outcome.data) {
        if (generation === cacheGeneration) {
          const isNew = !memoryCache.has(key);
          memoryCache.set(key, outcome.data);
          void pluginCache.set(CACHE_NS, key, outcome.data);
          void pluginCache.delete(CACHE_NS, NEGATIVE_PREFIX + key);
          if (isNew) statsCount = Math.max(statsCount, memoryCache.size);
        }
        return buildJournalResult(outcome.data, name);
      }
      if (outcome.status === "notfound") {
        void pluginCache.set(CACHE_NS, NEGATIVE_PREFIX + key, {
          at: Date.now(),
        });
        return emptyResult(
          name,
          "notfound",
          t("journal-notfound", "EasyScholar 未收录该期刊"),
          Date.now(),
        );
      }
      return emptyResult(
        name,
        outcome.errorKind === "key" ? "unconfigured" : "error",
        outcome.error || t("journal-error", "获取期刊信息失败"),
      );
    } catch (error) {
      log("EasyScholar lookup failed:", name, errorToString(error));
      return emptyResult(name, "error", t("journal-error", "获取期刊信息失败"));
    }
  })();

  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}

/** Look up ranking data for a Zotero item (regular paper items only). */
export async function getJournalRank(
  item: Zotero.Item,
  options: { force?: boolean } = {},
): Promise<JournalResult> {
  if (!item || !item.isRegularItem() || !isPaperItem(item)) {
    return emptyResult("", "idle");
  }
  const publications = getItemPublicationCandidates(item);
  if (!publications.length) {
    return emptyResult(
      "",
      "notfound",
      t("journal-no-publication", "无法确定期刊名称"),
    );
  }
  let last: JournalResult | null = null;
  for (const publication of publications) {
    const result = await getJournalRankByName(publication, options);
    if (result.status === "ok" || result.status === "error") {
      return result;
    }
    last = result;
  }
  return (
    last ||
    emptyResult(
      publications[0],
      "notfound",
      t("journal-notfound", "EasyScholar 未收录该期刊"),
    )
  );
}

/**
 * Warm the cache for a set of journals (used by the item-tree column and by
 * batch selection). Requests are serialized and deduplicated.
 */
export async function prefetchJournalRanksByPublication(
  publications: string[],
): Promise<void> {
  if (!getPref("journalEnabled")) return;
  if (!String(getPref("journalSecretKey") || "").trim()) return;
  const unique = new Map<string, string>();
  for (const publication of publications) {
    const name = expandJournalAlias(String(publication || ""));
    if (!name) continue;
    const key = normalizeJournalKey(name);
    if (!key || unique.has(key)) continue;
    if (getCachedJournalRank(name)) continue;
    unique.set(key, name);
  }
  const list = [...unique.values()].slice(0, MAX_PREFETCH);
  for (const name of list) {
    try {
      await getJournalRankByName(name);
    } catch (error) {
      log("prefetch journal failed:", name, errorToString(error));
    }
  }
}

export async function prefetchJournalRanks(
  items: Zotero.Item[],
): Promise<void> {
  if (!Array.isArray(items) || !items.length) return;
  const names: string[] = [];
  for (const item of items) {
    if (!item || !item.isRegularItem() || !isPaperItem(item)) continue;
    const publication = getItemPublication(item);
    if (publication) names.push(publication);
  }
  await prefetchJournalRanksByPublication(names);
}

export async function clearJournalCache(): Promise<void> {
  cacheGeneration += 1;
  inflight.clear();
  memoryCache.clear();
  statsCount = 0;
  statsLoaded = true;
  try {
    await pluginCache.clear(CACHE_NS);
  } catch (error) {
    log("clearJournalCache failed:", errorToString(error));
  }
}

async function refreshCacheStats(): Promise<void> {
  if (statsLoading) return;
  statsLoading = true;
  const generation = cacheGeneration;
  try {
    const path = joinPath(getPluginDataDir(), CACHE_FILE_NAME);
    const file = await readJSONFile<{
      namespaces?: Record<string, Record<string, unknown>>;
    }>(path, {});
    if (generation !== cacheGeneration) return;
    const journalEntries = file?.namespaces?.[CACHE_NS] || {};
    statsCount = Object.keys(journalEntries).filter(
      (key) => !key.startsWith(NEGATIVE_PREFIX),
    ).length;
    statsLoaded = true;
  } catch (error) {
    log("read journal cache stats failed:", errorToString(error));
  } finally {
    statsLoading = false;
  }
}

/** Number of cached (positive) journal entries. Synchronous by design. */
export function getJournalCacheStats(): { count: number } {
  if (!statsLoaded) void refreshCacheStats();
  return { count: statsCount };
}

// Warm the counter so the preferences pane shows a real value on first open.
void refreshCacheStats();

export interface EasyScholarTestResult {
  ok: boolean;
  status: JournalStatus;
  message: string;
  publication?: string;
  shortText?: string;
  warning?: boolean;
}

/**
 * Validate an EasyScholar key (or the configured one) with a known journal.
 * Used by the "检测密钥" button in preferences.
 */
export async function testEasyScholarKey(
  secretKey?: string,
): Promise<EasyScholarTestResult> {
  const key = String(secretKey ?? getPref("journalSecretKey") ?? "").trim();
  if (!key) {
    return {
      ok: false,
      status: "unconfigured",
      message: t(
        "journal-unconfigured",
        "尚未配置 EasyScholar 密钥，点击前往设置",
      ),
    };
  }
  const outcome = await requestEasyScholar(key, "Nature");
  if (outcome.status === "ok" && outcome.data) {
    const result = buildJournalResult(outcome.data, "Nature");
    return {
      ok: true,
      status: "ok",
      message: `Nature · ${
        result.shortText || t("journal-test-ok", "密钥有效，已成功获取期刊数据")
      }`,
      publication: result.publication,
      shortText: result.shortText,
      warning: result.warning,
    };
  }
  return {
    ok: false,
    status: outcome.status,
    message:
      outcome.error ||
      (outcome.status === "notfound"
        ? t("journal-notfound", "EasyScholar 未收录该期刊")
        : t("journal-error", "获取期刊信息失败")),
  };
}
