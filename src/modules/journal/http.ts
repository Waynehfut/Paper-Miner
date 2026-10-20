/**
 * Small JSON-over-HTTP helper shared by the journal (EasyScholar) and
 * journal service.
 *
 * Zotero plugins run in a privileged sandbox, so plain `fetch` is available
 * on modern Zotero versions. When it is missing (or `AbortController` is not
 * exposed) we fall back to `Zotero.HTTP.request`, which supports a native
 * timeout. Every call is resolved — never rejected — so callers can map the
 * failure to a friendly message instead of leaking a raw stack trace.
 */

import { errorToString, log } from "../../utils/log";

export interface JsonResponse {
  /** True for HTTP 2xx responses. */
  ok: boolean;
  /** HTTP status code, 0 when the request itself failed. */
  status: number;
  /** Parsed JSON body (undefined when the body is not JSON). */
  json: unknown;
  /** Human readable failure reason for status === 0 / parse errors. */
  error?: string;
  /** True when the failure was a client side timeout. */
  timeout?: boolean;
}

export interface JsonRequestOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Only used by tests / advanced callers. */
  signal?: AbortSignal;
}

type AnyGlobal = typeof globalThis & {
  fetch?: (input: string, init?: any) => Promise<any>;
  AbortController?: new () => { signal: unknown; abort: () => void };
};

const DEFAULT_TIMEOUT_MS = 20000;

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class TimeoutError extends Error {
  constructor() {
    super("请求超时");
    this.name = "TimeoutError";
  }
}

async function fetchWithFetch(
  url: string,
  options: JsonRequestOptions,
): Promise<JsonResponse> {
  const g = globalThis as AnyGlobal;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = g.fetch;
  if (!fetchFn) return { ok: false, status: 0, json: undefined };

  let controller: { signal: unknown; abort: () => void } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const init: Record<string, unknown> = {
      headers: { Accept: "application/json", ...(options.headers || {}) },
    };
    if (options.signal) init.signal = options.signal;
    if (!options.signal && typeof g.AbortController === "function") {
      const AbortCtor = g.AbortController;
      controller = new AbortCtor();
      init.signal = controller.signal;
      timer = setTimeout(() => {
        try {
          controller?.abort();
        } catch {
          // ignore
        }
      }, timeoutMs);
    }
    const request = fetchFn(url, init) as Promise<any>;
    const response = controller
      ? await request
      : await withTimeout(request, timeoutMs);
    const text = await withTimeout(
      Promise.resolve(response.text()).then((value: unknown) =>
        String(value ?? ""),
      ),
      timeoutMs,
    );
    const json = parseJson(text);
    const status = Number(response.status) || 0;
    if (!response.ok && json === undefined) {
      return {
        ok: false,
        status,
        json: undefined,
        error: `HTTP ${status}`,
      };
    }
    return { ok: Boolean(response.ok), status, json };
  } catch (error) {
    const name = (error as { name?: string } | undefined)?.name;
    const timeout = name === "AbortError" || error instanceof TimeoutError;
    return {
      ok: false,
      status: 0,
      json: undefined,
      timeout,
      error: timeout ? "请求超时" : errorToString(error),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchWithZotero(
  url: string,
  options: JsonRequestOptions,
): Promise<JsonResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const xhr = await Zotero.HTTP.request("GET", url, {
      responseType: "json",
      timeout: timeoutMs,
      successCodes: false,
      headers: { Accept: "application/json", ...(options.headers || {}) },
    });
    const status = Number(xhr.status) || 0;
    let json = xhr.response;
    if (typeof json === "string") json = parseJson(json);
    return { ok: status >= 200 && status < 300, status, json };
  } catch (error) {
    const message = errorToString(error);
    const timeout = /timeout|timed out|超时/i.test(message);
    log("HTTP request failed:", url, message);
    return {
      ok: false,
      status: 0,
      json: undefined,
      timeout,
      error: timeout ? "请求超时" : message,
    };
  }
}

/** Perform a GET request and resolve to parsed JSON, never rejecting. */
export async function getJSON(
  url: string,
  options: JsonRequestOptions = {},
): Promise<JsonResponse> {
  const g = globalThis as AnyGlobal;
  if (typeof g.fetch === "function") {
    return fetchWithFetch(url, options);
  }
  return fetchWithZotero(url, options);
}

export const __testing = { delay, TimeoutError };
