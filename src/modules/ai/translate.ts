/**
 * Selection translation. Supports the configured OpenAI-compatible LLM,
 * DeepL and Youdao (v3 signature). Only the translation is returned.
 */

import { getPref } from "../../utils/prefs";
import { errorToString, log } from "../../utils/log";
import { t } from "../../utils/i18n";
import { isLLMConfigured } from "./config";
import { chatCompletion, LLMError } from "./llm";
import {
  buildTranslateMessages,
  detectTextLanguage,
  resolveTranslateTarget,
  splitText,
} from "./prompts";

export interface TranslateOptions {
  signal?: AbortSignal;
  /** Streaming callback; may be called many times. */
  onDelta?: (delta: string, fullText: string) => void;
  /** Surrounding paper context to disambiguate terminology. */
  context?: string;
  /** Target language code; defaults to the preference. */
  targetLang?: string;
}

export type TranslateEngine = "llm" | "deepl" | "youdao" | "tencent";

const DEFAULT_DEEPL_ENDPOINT = "https://api-free.deepl.com/v2/translate";
const YOUDAO_ENDPOINT = "https://openapi.youdao.com/api";
const TENCENT_ENDPOINT = "https://tmt.tencentcloudapi.com";
const TENCENT_HOST = "tmt.tencentcloudapi.com";
const TENCENT_SERVICE = "tmt";
const TENCENT_VERSION = "2018-03-21";
const TENCENT_MAX_CHARS = 1800;
const MAX_TRANSLATE_CHARS = 30000;
const NOT_CONFIGURED = "请先在 PaperMiner 设置中配置 AI 服务";

/** Translate text into the target language; empty input returns "". */
export async function translateText(
  text: string,
  options: TranslateOptions = {},
): Promise<string> {
  const source = String(text || "").trim();
  if (!source) return "";
  if (source.length > MAX_TRANSLATE_CHARS) {
    throw new LLMError(
      "config",
      `选中文本过长（超过 ${MAX_TRANSLATE_CHARS} 字），请分段翻译`,
    );
  }
  throwIfAborted(options.signal);

  const engine = getTranslateEngine();
  const target = resolveTranslateTarget(
    options.targetLang || getTranslateTargetLanguage(),
    source,
  );

  try {
    switch (engine) {
      case "deepl":
        return await translateWithDeepL(source, target, options);
      case "youdao":
        return await translateWithYoudao(source, target, options);
      case "tencent":
        return await translateWithTencent(source, target, options);
      default:
        return await translateWithLLM(source, target, options);
    }
  } catch (error) {
    throw normalizeTranslateError(error, options.signal);
  }
}

/**
 * UI code checks `error.name === "AbortError"` (the DOM convention) when the
 * user cancels, so expose cancellations under that name while keeping the
 * LLMError type/kind for callers that prefer it.
 */
function normalizeTranslateError(
  error: unknown,
  signal: AbortSignal | undefined,
): unknown {
  if (error instanceof LLMError && error.kind === "abort") {
    error.name = "AbortError";
    return error;
  }
  if (signal?.aborted) {
    const abortError = new Error("已取消");
    abortError.name = "AbortError";
    return abortError;
  }
  return error;
}

/** Configured translation engine ("llm" | "deepl" | "youdao"). */
export function getTranslateEngine(): TranslateEngine {
  const raw = String(getPref("translateEngine") || "llm")
    .trim()
    .toLowerCase();
  if (
    raw === "deepl" ||
    raw === "youdao" ||
    raw === "tencent" ||
    raw === "llm"
  ) {
    return raw;
  }
  return "llm";
}

/** Currently selected target language preference ("auto" by default). */
export function getTranslateTargetLanguage(): string {
  const target = String(getPref("translateTarget") || "auto").trim();
  return target || "auto";
}

/** Whether the engine selected in preferences has all required credentials. */
export function isTranslationConfigured(): boolean {
  try {
    const engine = getTranslateEngine();
    if (engine === "deepl") {
      return Boolean(String(getPref("translateDeepLKey") || "").trim());
    }
    if (engine === "youdao") {
      return Boolean(
        String(getPref("translateYoudaoAppKey") || "").trim() &&
        String(getPref("translateYoudaoAppSecret") || "").trim(),
      );
    }
    if (engine === "tencent") {
      return Boolean(
        String(getPref("translateTencentSecretId") || "").trim() &&
        String(getPref("translateTencentSecretKey") || "").trim(),
      );
    }
    return isLLMConfigured("translation");
  } catch (error) {
    log("isTranslationConfigured failed:", errorToString(error));
    return false;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new LLMError("abort", "已取消");
    error.name = "AbortError";
    throw error;
  }
}

/** `译文：` / code-fence cleanup for LLM answers. */
export function cleanTranslation(raw: string): string {
  let text = String(raw || "").trim();
  const fenced = text.match(/```[a-zA-Z]*\s*([\s\S]*?)```/);
  if (fenced && fenced[1].trim()) text = fenced[1].trim();
  text = text.replace(/^(?:译文|翻译|Translation)\s*[:：]\s*/i, "");
  return text.trim();
}

async function translateWithLLM(
  text: string,
  target: string,
  options: TranslateOptions,
): Promise<string> {
  if (!isLLMConfigured("translation")) {
    throw new LLMError("config", NOT_CONFIGURED);
  }
  const result = await chatCompletion(
    buildTranslateMessages(text, {
      targetLang: target,
      context: options.context,
      customPrompt: String(getPref("translatePrompt") || ""),
    }),
    {
      purpose: "translation",
      temperature: 0.2,
      signal: options.signal,
      timeoutMs: 90_000,
      onDelta: options.onDelta,
    },
  );
  const translated = cleanTranslation(result);
  if (!translated) {
    throw new LLMError("parse", "模型没有返回译文，请重试");
  }
  return translated;
}

async function fetchTranslation(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  service: string,
): Promise<Response> {
  throwIfAborted(signal);
  try {
    return await fetch(url, { ...init, signal });
  } catch (error) {
    if (
      signal?.aborted ||
      (error as { name?: string })?.name === "AbortError"
    ) {
      throw new LLMError("abort", "已取消");
    }
    throw new LLMError(
      "network",
      `无法连接${service}：${errorToString(error)}`,
    );
  }
}

async function readJsonBody(response: Response, service: string): Promise<any> {
  try {
    return await response.json();
  } catch {
    throw new LLMError("parse", `${service}返回了无法解析的内容`);
  }
}

/* ------------------------------------------------------------------ */
/* Tencent Cloud TMT (TencentCloud API v3, TC3-HMAC-SHA256)            */
/* ------------------------------------------------------------------ */

/** Map an internal language code to Tencent TMT target codes. */
export function mapTencentTarget(target: string): string {
  const code = String(target || "")
    .trim()
    .toLowerCase();
  if (code.startsWith("zh")) return "zh";
  const supported = new Set([
    "en",
    "ja",
    "ko",
    "fr",
    "es",
    "it",
    "de",
    "tr",
    "ru",
    "pt",
    "vi",
    "id",
    "th",
    "ms",
    "ar",
    "hi",
  ]);
  return supported.has(code) ? code : "en";
}

function getSubtleCrypto(): SubtleCrypto {
  const globalCrypto = (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (globalCrypto?.subtle) return globalCrypto.subtle;
  try {
    const win = Zotero.getMainWindow() as unknown as { crypto?: Crypto };
    if (win?.crypto?.subtle) return win.crypto.subtle;
  } catch {
    // Zotero not ready.
  }
  throw new LLMError("config", "当前环境不支持加密接口，无法使用腾讯云翻译");
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await getSubtleCrypto().digest("SHA-256", utf8(text));
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256(
  key: string | Uint8Array,
  data: string,
): Promise<Uint8Array> {
  const rawKey = typeof key === "string" ? utf8(key) : key;
  const cryptoKey = await getSubtleCrypto().importKey(
    "raw",
    rawKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await getSubtleCrypto().sign("HMAC", cryptoKey, utf8(data));
  return new Uint8Array(signature);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Build the TC3-HMAC-SHA256 Authorization header (exported for tests). */
export async function buildTencentAuthorization(options: {
  secretId: string;
  secretKey: string;
  payload: string;
  timestamp: number;
}): Promise<string> {
  const { secretId, secretKey, payload, timestamp } = options;
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalHeaders =
    "content-type:application/json; charset=utf-8\n" + `host:${TENCENT_HOST}\n`;
  const signedHeaders = "content-type;host";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    await sha256Hex(payload),
  ].join("\n");
  const credentialScope = `${date}/${TENCENT_SERVICE}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(timestamp),
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const secretDate = await hmacSha256(`TC3${secretKey}`, date);
  const secretService = await hmacSha256(secretDate, TENCENT_SERVICE);
  const secretSigning = await hmacSha256(secretService, "tc3_request");
  const signature = bytesToHex(await hmacSha256(secretSigning, stringToSign));
  return (
    `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  );
}

function tencentError(code: string, message: string): LLMError {
  const detail = `${code}${message ? `：${message}` : ""}`;
  if (/^AuthFailure/i.test(code)) {
    return new LLMError("auth", `腾讯云密钥无效或没有权限（${detail}）`);
  }
  if (
    /LimitExceeded|RequestLimit|NoFreeAmount|ResourceInsufficient/i.test(code)
  ) {
    return new LLMError(
      "rate",
      `腾讯云翻译额度不足或请求过于频繁（${detail}）`,
    );
  }
  return new LLMError("server", `腾讯云翻译失败（${detail}）`);
}

async function translateWithTencent(
  text: string,
  target: string,
  options: TranslateOptions,
): Promise<string> {
  const secretId = String(getPref("translateTencentSecretId") || "").trim();
  const secretKey = String(getPref("translateTencentSecretKey") || "").trim();
  const region =
    String(getPref("translateTencentRegion") || "ap-guangzhou").trim() ||
    "ap-guangzhou";
  if (!secretId || !secretKey) {
    throw new LLMError(
      "config",
      "请先在 PaperMiner 设置中填写腾讯云 SecretId 与 SecretKey",
    );
  }
  const targetCode = mapTencentTarget(target);
  const chunks = splitText(text, TENCENT_MAX_CHARS);
  const outputs: string[] = [];
  for (const chunk of chunks) {
    throwIfAborted(options.signal);
    const body = JSON.stringify({
      SourceText: chunk,
      Source: "auto",
      Target: targetCode,
      ProjectId: 0,
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const authorization = await buildTencentAuthorization({
      secretId,
      secretKey,
      payload: body,
      timestamp,
    });
    const response = await fetchTranslation(
      TENCENT_ENDPOINT,
      {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json; charset=utf-8",
          Host: TENCENT_HOST,
          "X-TC-Action": "TextTranslate",
          "X-TC-Version": TENCENT_VERSION,
          "X-TC-Timestamp": String(timestamp),
          "X-TC-Region": region,
        },
        body,
      },
      options.signal,
      "腾讯云翻译",
    );
    const json = await readJsonBody(response, "腾讯云翻译");
    const result = json?.Response;
    if (result?.Error) {
      throw tencentError(
        String(result.Error.Code || ""),
        String(result.Error.Message || ""),
      );
    }
    const translated = String(result?.TargetText || "").trim();
    if (!translated) {
      throw new LLMError("parse", "腾讯云翻译没有返回译文");
    }
    outputs.push(translated);
    options.onDelta?.(translated, outputs.join("\n"));
  }
  return outputs.join("\n");
}

/** Map an internal language code to DeepL's `target_lang` values. */
export function mapDeepLTarget(target: string): string {
  const code = String(target || "")
    .trim()
    .toLowerCase();
  if (
    code === "zh" ||
    code === "zh-cn" ||
    code === "zh-hans" ||
    code === "zh-chs"
  ) {
    return "ZH-HANS";
  }
  if (code === "zh-tw" || code === "zh-hant" || code === "zh-cht") {
    return "ZH-HANT";
  }
  if (code === "en" || code === "en-us" || code === "en-gb") {
    return code === "en-gb" ? "EN-GB" : code === "en-us" ? "EN-US" : "EN";
  }
  return code.toUpperCase();
}

function deeplError(status: number, detail: string): LLMError {
  const suffix = detail ? `：${detail.slice(0, 300)}` : "";
  if (status === 403) {
    return new LLMError(
      "auth",
      `DeepL API Key 无效或没有权限（HTTP 403）${suffix}`,
      status,
    );
  }
  if (status === 456) {
    return new LLMError(
      "rate",
      `DeepL 翻译额度已用完（HTTP 456）${suffix}`,
      status,
    );
  }
  if (status === 429) {
    return new LLMError(
      "rate",
      `DeepL 请求过于频繁，请稍后再试（HTTP 429）${suffix}`,
      status,
    );
  }
  if (status >= 500) {
    return new LLMError(
      "server",
      `DeepL 服务暂时不可用（HTTP ${status}）${suffix}`,
      status,
    );
  }
  return new LLMError(
    "server",
    `DeepL 翻译失败（HTTP ${status}）${suffix}`,
    status,
  );
}

async function translateWithDeepL(
  text: string,
  target: string,
  options: TranslateOptions,
): Promise<string> {
  const apiKey = String(getPref("translateDeepLKey") || "").trim();
  if (!apiKey) {
    throw new LLMError("config", "请先在 PaperMiner 设置中填写 DeepL API Key");
  }
  const endpoint =
    String(getPref("translateDeepLEndpoint") || "").trim() ||
    DEFAULT_DEEPL_ENDPOINT;

  // DeepL accepts multiple `text` parameters in one request; split very long
  // selections so one request stays well under the size limit.
  const chunks = splitText(text, 30000);
  const body = new URLSearchParams();
  body.set("auth_key", apiKey);
  body.set("target_lang", mapDeepLTarget(target));
  body.set("preserve_formatting", "1");
  for (const chunk of chunks) body.append("text", chunk);

  const response = await fetchTranslation(
    endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: body.toString(),
    },
    options.signal,
    " DeepL 翻译服务",
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw deeplError(response.status, detail);
  }
  const json = await readJsonBody(response, "DeepL");
  const translations = json?.translations;
  if (!Array.isArray(translations) || !translations.length) {
    throw new LLMError("parse", "DeepL 没有返回译文");
  }
  const result = translations
    .map((item: any) => String(item?.text || ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!result) throw new LLMError("parse", "DeepL 没有返回译文");
  options.onDelta?.(result, result);
  return result;
}

/** Map an internal language code to Youdao's `to` values. */
export function mapYoudaoTarget(target: string): string {
  const code = String(target || "")
    .trim()
    .toLowerCase();
  if (
    code === "zh" ||
    code === "zh-cn" ||
    code === "zh-hans" ||
    code === "zh-chs"
  ) {
    return "zh-CHS";
  }
  if (code === "zh-tw" || code === "zh-hant" || code === "zh-cht") {
    return "zh-CHT";
  }
  return code || "en";
}

/**
 * Youdao v3 truncation rule: keep the first/last 10 characters and the
 * original length when the text is longer than 20 characters.
 */
export function truncateYoudaoText(text: string): string {
  const source = String(text || "");
  if (source.length <= 20) return source;
  return `${source.slice(0, 10)}${source.length}${source.slice(-10)}`;
}

/** The exact string that is SHA-256 hashed for the Youdao v3 signature. */
export function youdaoSignInput(
  appKey: string,
  text: string,
  salt: string,
  curtime: string,
  appSecret: string,
): string {
  return `${appKey}${truncateYoudaoText(text)}${salt}${curtime}${appSecret}`;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256 hex signature used by the Youdao v3 API. */
export async function computeYoudaoSign(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new LLMError(
      "config",
      "当前环境不支持 SHA-256，无法使用有道翻译，请改用其他翻译引擎",
    );
  }
  const data = new TextEncoder().encode(input);
  const digest = await subtle.digest("SHA-256", data);
  return toHex(digest);
}

function randomSalt(): string {
  const values = new Uint32Array(1);
  try {
    globalThis.crypto?.getRandomValues(values);
  } catch {
    values[0] = Math.floor(Math.random() * 0xffffffff);
  }
  if (!values[0]) values[0] = Date.now() % 0xffffffff;
  return String(values[0]);
}

const YOUDAO_ERRORS: Record<string, string> = {
  "101": "缺少必填参数",
  "102": "不支持的语言类型",
  "103": "翻译文本过长",
  "108": "App Key 无效",
  "110": "无相关权限",
  "111": "账号欠费或额度不足",
  "112": "请求频率受限",
  "113": "请求文本过长",
  "202": "签名校验失败，请检查 App Secret",
  "401": "账户未授权",
  "411": "访问频率受限",
};

async function translateWithYoudao(
  text: string,
  target: string,
  options: TranslateOptions,
): Promise<string> {
  const appKey = String(getPref("translateYoudaoAppKey") || "").trim();
  const appSecret = String(getPref("translateYoudaoAppSecret") || "").trim();
  if (!appKey || !appSecret) {
    throw new LLMError(
      "config",
      "请先在 PaperMiner 设置中填写有道翻译 App Key 和 App Secret",
    );
  }

  const to = mapYoudaoTarget(target);
  const chunks = splitText(text, 4000);
  const results: string[] = [];
  for (const chunk of chunks) {
    throwIfAborted(options.signal);
    const salt = randomSalt();
    const curtime = String(Math.floor(Date.now() / 1000));
    const sign = await computeYoudaoSign(
      youdaoSignInput(appKey, chunk, salt, curtime, appSecret),
    );
    const body = new URLSearchParams();
    body.set("q", chunk);
    body.set("from", "auto");
    body.set("to", to);
    body.set("appKey", appKey);
    body.set("salt", salt);
    body.set("sign", sign);
    body.set("signType", "v3");
    body.set("curtime", curtime);

    const response = await fetchTranslation(
      YOUDAO_ENDPOINT,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body: body.toString(),
      },
      options.signal,
      "有道翻译服务",
    );
    if (!response.ok) {
      throw new LLMError(
        response.status === 403 ? "auth" : "server",
        `有道翻译请求失败（HTTP ${response.status}）`,
        response.status,
      );
    }
    const json = await readJsonBody(response, "有道翻译");
    const errorCode = String(json?.errorCode ?? "0");
    if (errorCode !== "0") {
      const reason = YOUDAO_ERRORS[errorCode] || "未知错误";
      throw new LLMError(
        errorCode === "108" || errorCode === "401" ? "auth" : "server",
        `有道翻译失败（错误码 ${errorCode}）：${reason}`,
        undefined,
      );
    }
    const translation = json?.translation;
    if (!Array.isArray(translation) || !translation.length) {
      throw new LLMError("parse", "有道翻译没有返回译文");
    }
    const piece = translation
      .map((item: any) => String(item || ""))
      .filter(Boolean)
      .join("\n");
    if (piece) results.push(piece);
  }
  const result = results.join("\n").trim();
  if (!result) {
    throw new LLMError("parse", "有道翻译没有返回译文");
  }
  options.onDelta?.(result, result);
  return result;
}

/**
 * Re-exported so UI code can show the resolved direction without importing
 * the prompt module.
 */
export { detectTextLanguage, resolveTranslateTarget };

/** Localised error text for the selection-popup UI. */
export function getTranslateErrorMessage(error: unknown): string {
  if (error instanceof LLMError) return error.message;
  return `${t("translate-error", "翻译失败")}：${errorToString(error)}`;
}
