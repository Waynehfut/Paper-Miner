/**
 * Google Scholar citation data.
 *
 * Google Scholar has no official API, so this module reads the public search
 * and "cited by" pages. Results are cached for a week; requests are made only
 * from the item-pane citation action (and optionally the summary line), never
 * for every item in the library.
 */

import { createAbortController } from "../../utils/abort";
import { pluginCache } from "../../utils/cache";
import { getItemDOI, getItemTitle } from "../../utils/item";
import { errorToString, log } from "../../utils/log";
import { getPref } from "../../utils/prefs";

export type CitationStatus = "ok" | "notfound" | "error";
export type CitationSource = "google" | "openalex" | "opencitations";

export interface CitationSummary {
  status: CitationStatus;
  /** Total number of citing works reported by Google Scholar. */
  count: number;
  clusterId: string;
  citesUrl: string;
  title: string;
  sourceUrl: string;
  /** Public page listing the citing works. */
  publicUrl?: string;
  source: CitationSource;
  fetchedAt: number;
  error?: string;
}

export interface CitationItem {
  title: string;
  url: string;
  meta: string;
  clusterId?: string;
}

export interface CitationDetails extends CitationSummary {
  items: CitationItem[];
  /** True when some pages could not be fetched. */
  partial?: boolean;
}

export class CitationError extends Error {
  constructor(
    public readonly code: "blocked" | "network" | "parse" | "notfound",
    message: string,
  ) {
    super(message);
    this.name = "CitationError";
  }
}

const CACHE_NAMESPACE = "citations";
const CACHE_TTL_DAYS = 7;
const MAX_ITEMS = 30;
const BASE_URL = "https://scholar.google.com";
const OPENALEX_API = "https://api.openalex.org";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function normalizeTitle(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const citationCounts = new Map<string, number>();

function rememberCount(item: Zotero.Item, summary: CitationSummary): void {
  if (summary.status !== "ok") return;
  const key = citationKey(item);
  if (key) citationCounts.set(key, summary.count);
}

/** Synchronous count lookup for item-tree columns; undefined means not fetched. */
export function getCitationCountSync(item: Zotero.Item): number | undefined {
  const key = citationKey(item);
  return key ? citationCounts.get(key) : undefined;
}

/** Warm the synchronous count index from the persistent cache. */
export async function hydrateCitationCounts(): Promise<void> {
  const entries = await pluginCache.entries<CitationSummary>(
    CACHE_NAMESPACE,
    CACHE_TTL_DAYS,
  );
  for (const [key, summary] of Object.entries(entries)) {
    if (!key.startsWith("summary:") || summary?.status !== "ok") continue;
    citationCounts.set(key.slice("summary:".length), summary.count);
  }
}

function citationKey(item: Zotero.Item): string {
  const doi = getItemDOI(item);
  if (doi) return `doi:${doi.toLowerCase()}`;
  const title = normalizeTitle(getItemTitle(item));
  return title ? `title:${title}` : "";
}

function absoluteUrl(href: string): string {
  try {
    return new URL(href, `${BASE_URL}/`).toString();
  } catch {
    return href;
  }
}

function parseCount(text: string): number {
  const match = String(text || "").match(/Cited by\s+([\d,]+)/i);
  if (!match) return 0;
  const value = Number.parseInt(match[1].replace(/,/g, ""), 10);
  return Number.isFinite(value) ? value : 0;
}

export interface ScholarSearchHit {
  title: string;
  url: string;
  meta: string;
  count: number;
  clusterId: string;
  citesUrl: string;
}

/** Parse the public Google Scholar search result page. */
export function parseScholarSearch(html: string): ScholarSearchHit[] {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  const rows = Array.from(
    doc.querySelectorAll(".gs_r.gs_or, .gs_r.gs_scl"),
  ) as Element[];
  const hits: ScholarSearchHit[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const titleLink = row.querySelector(".gs_rt a");
    const title = String(
      titleLink?.textContent || row.querySelector(".gs_rt")?.textContent || "",
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!title) continue;
    const citesLink = row.querySelector('a[href*="cites="]');
    const citesHref = citesLink?.getAttribute("href") || "";
    const clusterFromHref = /[?&]cites=([^&]+)/.exec(citesHref)?.[1] || "";
    const clusterId =
      row.getAttribute("data-cid") || decodeURIComponent(clusterFromHref);
    if (!clusterId || seen.has(clusterId)) continue;
    seen.add(clusterId);
    const countText = (
      Array.from(row.querySelectorAll(".gs_fl a")) as Element[]
    )
      .map((link) => String(link.textContent || ""))
      .find((text) => /Cited by/i.test(text));
    hits.push({
      title,
      url: absoluteUrl(titleLink?.getAttribute("href") || citesHref),
      meta: String(row.querySelector(".gs_a")?.textContent || "")
        .replace(/\s+/g, " ")
        .trim(),
      count: parseCount(countText || ""),
      clusterId,
      citesUrl: citesHref
        ? absoluteUrl(citesHref)
        : `${BASE_URL}/scholar?hl=en&cites=${encodeURIComponent(clusterId)}`,
    });
  }
  return hits;
}

/** Parse one page of the citing-works list. */
export function parseScholarCitations(html: string): CitationItem[] {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  const rows = Array.from(
    doc.querySelectorAll(".gs_r.gs_or, .gs_r.gs_scl"),
  ) as Element[];
  const items: CitationItem[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const titleLink = row.querySelector(".gs_rt a");
    const title = String(
      titleLink?.textContent || row.querySelector(".gs_rt")?.textContent || "",
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!title) continue;
    const href = titleLink?.getAttribute("href") || "";
    const clusterId = row.getAttribute("data-cid") || "";
    const key = href || `${title}|${clusterId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      title,
      url: href
        ? absoluteUrl(href)
        : `${BASE_URL}/scholar?hl=en&q=${encodeURIComponent(title)}`,
      meta: String(row.querySelector(".gs_a")?.textContent || "")
        .replace(/\s+/g, " ")
        .trim(),
      ...(clusterId ? { clusterId } : {}),
    });
  }
  return items;
}

function isBlockedPage(html: string): boolean {
  const sample = String(html || "").slice(0, 30000);
  return /unusual traffic|not a robot|enablejs|captcha|automated queries/i.test(
    sample,
  );
}

async function fetchScholar(url: string): Promise<string> {
  try {
    const xhr = await Zotero.HTTP.request("GET", url, {
      responseType: "text",
      timeout: 20_000,
      successCodes: false,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": USER_AGENT,
      },
    });
    const status = Number(xhr.status) || 0;
    const text = String(xhr.responseText || xhr.response || "");
    if (status < 200 || status >= 300) {
      throw new CitationError(
        "network",
        `Google Scholar 返回 HTTP ${status || "错误"}`,
      );
    }
    if (isBlockedPage(text)) {
      throw new CitationError(
        "blocked",
        "Google Scholar 要求人机验证，请稍后重试或在浏览器中打开一次 Google Scholar。",
      );
    }
    return text;
  } catch (error) {
    if (error instanceof CitationError) throw error;
    const message = errorToString(error);
    log("Google Scholar request failed:", message);
    throw new CitationError("network", `无法访问 Google Scholar：${message}`);
  }
}

function pickBestHit(
  hits: ScholarSearchHit[],
  item: Zotero.Item,
): ScholarSearchHit | undefined {
  if (!hits.length) return undefined;
  const doi = getItemDOI(item).toLowerCase();
  const title = normalizeTitle(getItemTitle(item));
  const exactTitle = hits.find((hit) => normalizeTitle(hit.title) === title);
  if (exactTitle) return exactTitle;
  if (doi) {
    const doiHit = hits.find((hit) =>
      hit.meta.toLowerCase().includes(doi.split("/").pop() || doi),
    );
    if (doiHit) return doiHit;
  }
  const prefix = title.slice(0, Math.min(40, title.length));
  return (
    hits.find((hit) => normalizeTitle(hit.title).includes(prefix)) || hits[0]
  );
}

function summaryFromHit(
  hit: ScholarSearchHit,
  item: Zotero.Item,
  sourceUrl: string,
): CitationSummary {
  return {
    status: "ok",
    count: hit.count,
    clusterId: hit.clusterId,
    citesUrl: hit.citesUrl,
    title: getItemTitle(item) || hit.title,
    sourceUrl,
    publicUrl: hit.citesUrl,
    source: "google",
    fetchedAt: Date.now(),
  };
}

function errorSummary(error: unknown, sourceUrl = ""): CitationSummary {
  const message =
    error instanceof CitationError
      ? error.message
      : `获取引用信息失败：${errorToString(error)}`;
  return {
    status: "error",
    count: 0,
    clusterId: "",
    citesUrl: "",
    title: "",
    sourceUrl,
    source: "google",
    fetchedAt: Date.now(),
    error: message,
  };
}

/* ------------------------------------------------------------------ */
/* OpenAlex fallback                                                   */
/* ------------------------------------------------------------------ */

interface OpenAlexWork {
  id?: string;
  display_name?: string;
  cited_by_count?: number;
  doi?: string;
  publication_year?: number;
  authorships?: Array<{ author?: { display_name?: string } }>;
  primary_location?: {
    landing_page_url?: string;
    source?: { display_name?: string };
  };
}

function openAlexURL(url: string): string {
  const target = new URL(url);
  const apiKey = String(getPref("citationOpenAlexApiKey") || "").trim();
  if (apiKey) target.searchParams.set("api_key", apiKey);
  return target.toString();
}

async function fetchOpenAlexJSON(url: string): Promise<any> {
  const controller = createAbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(openAlexURL(url), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new CitationError(
        "network",
        `OpenAlex 返回 HTTP ${response.status}`,
      );
    }
    return await response.json();
  } catch (error) {
    if (error instanceof CitationError) throw error;
    throw new CitationError(
      "network",
      `无法访问 OpenAlex：${errorToString(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function openAlexShortId(work: OpenAlexWork): string {
  return (
    String(work.id || "")
      .split("/")
      .pop() || ""
  );
}

function openAlexItemUrl(work: OpenAlexWork): string {
  const landing = String(work.primary_location?.landing_page_url || "").trim();
  if (landing) return landing;
  if (work.doi) return String(work.doi);
  const id = openAlexShortId(work);
  return id ? `https://openalex.org/${id}` : "";
}

function openAlexMeta(work: OpenAlexWork): string {
  const authors = (work.authorships || [])
    .slice(0, 3)
    .map((entry) => String(entry.author?.display_name || "").trim())
    .filter(Boolean);
  const venue = String(
    work.primary_location?.source?.display_name || "",
  ).trim();
  const year = work.publication_year ? String(work.publication_year) : "";
  return [...authors, venue, year].filter(Boolean).join(" · ");
}

async function getOpenAlexSummary(
  item: Zotero.Item,
): Promise<CitationSummary | null> {
  const doi = getItemDOI(item);
  const title = getItemTitle(item);
  try {
    let work: OpenAlexWork | null = null;
    if (doi) {
      try {
        work = (await fetchOpenAlexJSON(
          `${OPENALEX_API}/works/https://doi.org/${doi}`,
        )) as OpenAlexWork;
      } catch {
        work = null;
      }
    }
    if (!work?.id && title) {
      const search = await fetchOpenAlexJSON(
        `${OPENALEX_API}/works?search=${encodeURIComponent(title)}&per-page=1`,
      );
      work = (search?.results?.[0] as OpenAlexWork) || null;
    }
    const shortId = work ? openAlexShortId(work) : "";
    if (!work || !shortId) return null;
    const publicUrl = `https://openalex.org/works?filter=cites:${shortId}`;
    return {
      status: "ok",
      count: Number(work.cited_by_count) || 0,
      clusterId: shortId,
      citesUrl: publicUrl,
      title: title || String(work.display_name || ""),
      sourceUrl: `https://openalex.org/${shortId}`,
      publicUrl,
      source: "openalex",
      fetchedAt: Date.now(),
    };
  } catch (error) {
    log("OpenAlex citation fallback failed:", errorToString(error));
    return null;
  }
}

async function getOpenAlexDetails(
  summary: CitationSummary,
  options: { force?: boolean },
): Promise<CitationDetails> {
  const cacheKey = `details:openalex:${summary.clusterId}:${summary.count}`;
  if (!options.force) {
    const cached = await pluginCache.get<CitationDetails>(
      CACHE_NAMESPACE,
      cacheKey,
      CACHE_TTL_DAYS,
    );
    if (cached) return cached;
  }
  try {
    const pageUrl = `${OPENALEX_API}/works?filter=cites:${encodeURIComponent(
      summary.clusterId,
    )}&per-page=50&sort=publication_date:desc`;
    const json = await fetchOpenAlexJSON(pageUrl);
    const results = Array.isArray(json?.results)
      ? (json.results as OpenAlexWork[])
      : [];
    const items = results
      .map((work) => ({
        title: String(work.display_name || "").trim(),
        url: openAlexItemUrl(work),
        meta: openAlexMeta(work),
        ...(openAlexShortId(work) ? { clusterId: openAlexShortId(work) } : {}),
      }))
      .filter((entry) => entry.title && entry.url)
      .slice(0, MAX_ITEMS);
    const details: CitationDetails = {
      ...summary,
      items,
      ...(summary.count > items.length ? { partial: true } : {}),
      fetchedAt: Date.now(),
    };
    if (items.length) {
      await pluginCache.set(CACHE_NAMESPACE, cacheKey, details);
    }
    return details;
  } catch (error) {
    return {
      ...summary,
      status: "error",
      error:
        error instanceof CitationError
          ? error.message
          : `获取 OpenAlex 引用列表失败：${errorToString(error)}`,
      items: [],
    };
  }
}

/** Read a cached summary without performing any network request. */
export async function getCachedCitationSummary(
  item: Zotero.Item,
): Promise<CitationSummary | undefined> {
  const key = citationKey(item);
  if (!key) return undefined;
  const cached = await pluginCache.get<CitationSummary>(
    CACHE_NAMESPACE,
    `summary:${key}`,
    CACHE_TTL_DAYS,
  );
  if (!cached) return undefined;
  const summary = { ...cached, source: cached.source || "google" };
  rememberCount(item, summary);
  return summary;
}

/* ------------------------------------------------------------------ */
/* OpenCitations fallback (citation list only)                         */
/* ------------------------------------------------------------------ */

async function fetchOpenCitationsJSON(url: string): Promise<any> {
  const controller = createAbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new CitationError(
        "network",
        `OpenCitations 返回 HTTP ${response.status}`,
      );
    }
    return await response.json();
  } catch (error) {
    if (error instanceof CitationError) throw error;
    throw new CitationError(
      "network",
      `无法访问 OpenCitations：${errorToString(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function cleanOpenCitationsMeta(value: string): string {
  return String(value || "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function openCitationsMeta(record: any): string {
  const authors = String(record?.author || "")
    .split(";")
    .map(cleanOpenCitationsMeta)
    .filter(Boolean)
    .slice(0, 3);
  const venue = cleanOpenCitationsMeta(String(record?.venue || ""));
  const year = String(record?.pub_date || "").slice(0, 4);
  return [...authors, venue, year].filter(Boolean).join(" · ");
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  task: (value: T) => Promise<R>,
): Promise<R[]> {
  const output: R[] = [];
  let index = 0;
  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    async () => {
      while (index < values.length) {
        const current = index;
        index += 1;
        output[current] = await task(values[current]);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

async function getOpenCitationsDetails(
  summary: CitationSummary,
  item: Zotero.Item,
  options: { force?: boolean },
): Promise<CitationDetails | null> {
  const doi = getItemDOI(item);
  if (!doi) return null;
  const cacheKey = `details:opencitations:${doi}:${summary.count}`;
  if (!options.force) {
    const cached = await pluginCache.get<CitationDetails>(
      CACHE_NAMESPACE,
      cacheKey,
      CACHE_TTL_DAYS,
    );
    if (cached) return cached;
  }
  try {
    const refs = await fetchOpenCitationsJSON(
      `https://api.opencitations.net/index/v2/citations/doi:${encodeURIComponent(
        doi,
      )}`,
    );
    const citingDois = Array.from(
      new Set(
        (Array.isArray(refs) ? refs : [])
          .map((ref: any) => {
            const match = /(?:^|\s)doi:([^\s]+)/i.exec(
              String(ref?.citing || ""),
            );
            return match?.[1]?.trim() || "";
          })
          .filter(Boolean),
      ),
    ).slice(0, MAX_ITEMS);
    if (!citingDois.length) return null;
    const rows = await mapLimit(citingDois, 6, async (citingDoi) => {
      let record: any = null;
      try {
        const data = await fetchOpenCitationsJSON(
          `https://api.opencitations.net/meta/v1/metadata/doi:${encodeURIComponent(
            citingDoi,
          )}`,
        );
        record = Array.isArray(data) ? data[0] : data;
      } catch {
        record = null;
      }
      return {
        title: String(record?.title || "").trim() || `DOI ${citingDoi}`,
        url: `https://doi.org/${citingDoi}`,
        meta: openCitationsMeta(record) || `DOI ${citingDoi}`,
      };
    });
    const details: CitationDetails = {
      ...summary,
      source: "opencitations",
      citesUrl: summary.citesUrl,
      publicUrl: `https://opencitations.net/index/v2/citations/doi:${encodeURIComponent(
        doi,
      )}`,
      fetchedAt: Date.now(),
      items: rows.filter((row) => row.title && row.url),
      ...(summary.count > rows.length ? { partial: true } : {}),
    };
    if (details.items.length) {
      await pluginCache.set(CACHE_NAMESPACE, cacheKey, details);
    }
    return details;
  } catch (error) {
    log("OpenCitations citation fallback failed:", errorToString(error));
    return null;
  }
}

function unavailableDetails(
  summary: CitationSummary,
  detail: string,
): CitationDetails {
  return {
    ...summary,
    status: "ok",
    items: [],
    error: detail,
    fetchedAt: Date.now(),
  };
}

/** Search Google Scholar and return the cited-by count for an item. */
export async function getCitationSummary(
  item: Zotero.Item,
  options: { force?: boolean } = {},
): Promise<CitationSummary> {
  const key = citationKey(item);
  if (!key) {
    return errorSummary(
      new CitationError("notfound", "该条目没有 DOI 或标题，无法查询引用"),
    );
  }
  if (!options.force) {
    const cached = await pluginCache.get<CitationSummary>(
      CACHE_NAMESPACE,
      `summary:${key}`,
      CACHE_TTL_DAYS,
    );
    if (cached) {
      const summary = { ...cached, source: cached.source || "google" };
      // OpenAlex is the preferred source. Older caches may contain a Google
      // summary; try OpenAlex once before returning them.
      if (summary.source !== "google") {
        rememberCount(item, summary);
        return summary;
      }
      const openAlex = await getOpenAlexSummary(item);
      if (openAlex) {
        await pluginCache.set(CACHE_NAMESPACE, `summary:${key}`, openAlex);
        rememberCount(item, openAlex);
        return openAlex;
      }
      rememberCount(item, summary);
      return summary;
    }
  }
  const doi = getItemDOI(item);
  const title = getItemTitle(item);
  if (!doi && !title) {
    return errorSummary(
      new CitationError("notfound", "该条目没有 DOI 或标题，无法查询引用"),
    );
  }
  // Prefer OpenAlex (works without Google Scholar access and supports an
  // optional API key for higher rate limits).
  const openAlex = await getOpenAlexSummary(item);
  if (openAlex) {
    await pluginCache.set(CACHE_NAMESPACE, `summary:${key}`, openAlex);
    rememberCount(item, openAlex);
    return openAlex;
  }

  const query = doi ? `"${doi}"` : title;
  const searchUrl = `${BASE_URL}/scholar?hl=en&q=${encodeURIComponent(query)}`;
  try {
    let hits = parseScholarSearch(await fetchScholar(searchUrl));
    if (!hits.length && doi && title) {
      hits = parseScholarSearch(
        await fetchScholar(
          `${BASE_URL}/scholar?hl=en&q=${encodeURIComponent(title)}`,
        ),
      );
    }
    const hit = pickBestHit(hits, item);
    if (!hit) {
      return {
        status: "notfound",
        count: 0,
        clusterId: "",
        citesUrl: "",
        title,
        sourceUrl: searchUrl,
        source: "google",
        fetchedAt: Date.now(),
      };
    }
    const summary = summaryFromHit(hit, item, searchUrl);
    await pluginCache.set(CACHE_NAMESPACE, `summary:${key}`, summary);
    rememberCount(item, summary);
    return summary;
  } catch (error) {
    log("Google Scholar citation lookup failed:", errorToString(error));
    return errorSummary(error, searchUrl);
  }
}

async function getGoogleDetailsFromSummary(
  item: Zotero.Item,
  summary: CitationSummary,
  options: { force?: boolean },
): Promise<CitationDetails> {
  const cacheKey = `details:${summary.source}:${summary.clusterId}:${summary.count}`;
  if (!options.force) {
    const cached = await pluginCache.get<CitationDetails>(
      CACHE_NAMESPACE,
      cacheKey,
      CACHE_TTL_DAYS,
    );
    if (cached) return cached;
  }
  const items: CitationItem[] = [];
  const seen = new Set<string>();
  let partial = false;
  const pageCount = Math.min(
    3,
    Math.ceil(Math.min(summary.count, MAX_ITEMS) / 10),
  );
  for (let page = 0; page < pageCount; page += 1) {
    const url = new URL(summary.citesUrl);
    url.searchParams.set("start", String(page * 10));
    try {
      const pageItems = parseScholarCitations(
        await fetchScholar(url.toString()),
      );
      for (const entry of pageItems) {
        const dedupe = entry.url || entry.title;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        items.push(entry);
        if (items.length >= MAX_ITEMS) break;
      }
      if (!pageItems.length) break;
    } catch (error) {
      if (page === 0) {
        return unavailableDetails(
          summary,
          error instanceof CitationError
            ? error.message
            : `获取引用列表失败：${errorToString(error)}`,
        );
      }
      partial = true;
      break;
    }
    if (items.length >= MAX_ITEMS) break;
  }
  const details: CitationDetails = {
    ...summary,
    items,
    ...(partial ? { partial: true } : {}),
    fetchedAt: Date.now(),
  };
  if (items.length) {
    await pluginCache.set(CACHE_NAMESPACE, cacheKey, details);
  }
  return details;
}

async function getGoogleDetailsForItem(
  item: Zotero.Item,
  options: { force?: boolean },
): Promise<CitationDetails | null> {
  const doi = getItemDOI(item);
  const title = getItemTitle(item);
  if (!doi && !title) return null;
  const query = doi ? `"${doi}"` : title;
  const searchUrl = `${BASE_URL}/scholar?hl=en&q=${encodeURIComponent(query)}`;
  try {
    let hits = parseScholarSearch(await fetchScholar(searchUrl));
    if (!hits.length && doi && title) {
      hits = parseScholarSearch(
        await fetchScholar(
          `${BASE_URL}/scholar?hl=en&q=${encodeURIComponent(title)}`,
        ),
      );
    }
    const hit = pickBestHit(hits, item);
    if (!hit) return null;
    return await getGoogleDetailsFromSummary(
      item,
      summaryFromHit(hit, item, searchUrl),
      options,
    );
  } catch (error) {
    log("Google citation list fallback failed:", errorToString(error));
    return null;
  }
}

/** Fetch the citing-works list (up to 30 entries, 3 Scholar pages). */
export async function getCitationDetails(
  item: Zotero.Item,
  options: { force?: boolean } = {},
): Promise<CitationDetails> {
  const summary = await getCitationSummary(item, options);
  if (summary.status !== "ok" || !summary.count || !summary.clusterId) {
    return { ...summary, items: [] };
  }
  if (summary.source === "openalex") {
    const details = await getOpenAlexDetails(summary, options);
    if (details.status === "ok" && details.items.length) return details;
    const google = await getGoogleDetailsForItem(item, options);
    if (google?.items.length) return google;
    const fallback = await getOpenCitationsDetails(summary, item, options);
    if (fallback) return fallback;
    return unavailableDetails(
      summary,
      details.error || "OpenAlex 暂时无法返回引用列表",
    );
  }
  if (summary.source === "google") {
    return getGoogleDetailsFromSummary(item, summary, options);
  }
  return { ...summary, items: [] };
}
