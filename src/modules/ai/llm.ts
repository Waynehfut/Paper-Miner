import type {
  AiMessage,
  AiPurpose,
  LLMChatOptions,
  LLMRuntimeConfig,
} from "../../types";
import { createAbortController } from "../../utils/abort";
import { getPref } from "../../utils/prefs";
import { errorToString, log } from "../../utils/log";
import {
  getLLMConfig,
  getLLMConfigError,
  getLLMEndpoint,
  isLLMConfigured,
} from "./config";
import { getLLMPreset } from "./presets";

export type LLMErrorKind =
  | "config"
  | "auth"
  | "rate"
  | "network"
  | "server"
  | "parse"
  | "abort";

export class LLMError extends Error {
  kind: LLMErrorKind;
  status?: number;

  constructor(kind: LLMErrorKind, message: string, status?: number) {
    super(message);
    this.name = "LLMError";
    this.kind = kind;
    this.status = status;
  }
}

export interface DeltaPayload {
  content?: string;
  reasoning?: string;
  done?: boolean;
}

/**
 * Parse the JSON body of one SSE `data:` line from an OpenAI-compatible
 * stream. Exported for unit tests.
 */
export function parseSSEPayload(data: string): DeltaPayload | null {
  const trimmed = data.trim();
  if (!trimmed) return null;
  if (trimmed === "[DONE]") return { done: true };
  let json: any;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (json?.error) {
    const message =
      json.error?.message || json.error?.msg || "模型接口返回错误";
    throw new LLMError("server", String(message));
  }
  const choice = json?.choices?.[0];
  if (!choice) return null;
  const delta = choice.delta ?? choice.message ?? {};
  let content = delta.content;
  if (Array.isArray(content)) {
    content = content
      .map((part: any) =>
        typeof part === "string" ? part : part?.text || part?.content || "",
      )
      .join("");
  }
  const reasoning = delta.reasoning_content ?? delta.reasoning;
  if (
    (content === undefined || content === null || content === "") &&
    !reasoning &&
    choice.finish_reason
  ) {
    return { done: true };
  }
  return {
    content: typeof content === "string" ? content : "",
    reasoning: typeof reasoning === "string" ? reasoning : undefined,
    done: Boolean(choice.finish_reason),
  };
}

/** Parse a non-streaming chat completion body. */
export function parseCompletionBody(body: string): string {
  let json: any;
  try {
    json = JSON.parse(body);
  } catch {
    throw new LLMError("parse", "模型接口返回了无法解析的内容");
  }
  if (json?.error) {
    throw new LLMError(
      "server",
      String(json.error?.message || json.error?.msg || "模型接口返回错误"),
    );
  }
  const message = json?.choices?.[0]?.message;
  let content = message?.content;
  if (Array.isArray(content)) {
    content = content
      .map((part: any) =>
        typeof part === "string" ? part : part?.text || part?.content || "",
      )
      .join("");
  }
  if (typeof content !== "string" || !content) {
    throw new LLMError("parse", "模型没有返回任何内容");
  }
  return content;
}

function isAbortError(error: unknown): boolean {
  return (
    (error as { name?: string })?.name === "AbortError" ||
    /abort/i.test(errorToString(error))
  );
}

function httpError(status: number, body: string): LLMError {
  let detail = body;
  try {
    const json = JSON.parse(body);
    detail = json?.error?.message || json?.message || body;
  } catch {
    // Keep the raw body.
  }
  detail = String(detail || "").slice(0, 500);
  if (status === 401 || status === 403) {
    return new LLMError(
      "auth",
      `API Key 无效或没有权限（HTTP ${status}）`,
      status,
    );
  }
  if (status === 429) {
    return new LLMError(
      "rate",
      `请求太频繁或额度不足（HTTP 429）${detail ? `：${detail}` : ""}`,
      status,
    );
  }
  if (status >= 500) {
    return new LLMError(
      "server",
      `模型服务暂时不可用（HTTP ${status}）${detail ? `：${detail}` : ""}`,
      status,
    );
  }
  return new LLMError(
    "server",
    `模型接口请求失败（HTTP ${status}）${detail ? `：${detail}` : ""}`,
    status,
  );
}

function normalizeMessages(messages: AiMessage[]): AiMessage[] {
  return messages
    .filter((message) => message && typeof message.content === "string")
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
}

function buildRequestBody(
  config: LLMRuntimeConfig,
  messages: AiMessage[],
  stream: boolean,
  options: LLMChatOptions,
): Record<string, unknown> {
  const maxTokens = options.maxTokens ?? config.maxTokens;
  const temperature = options.temperature ?? config.temperature;
  const body: Record<string, unknown> = {
    model: options.model || config.model,
    messages: normalizeMessages(messages),
    stream,
  };
  if (Number.isFinite(temperature)) {
    body.temperature = Math.max(0, Math.min(2, temperature));
  }
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    body.max_tokens = Math.floor(maxTokens);
  }
  // Provider capability driven: only providers that document a switch get the
  // extra field. Everything else remains a plain OpenAI-compatible request.
  const thinkingControl = getLLMPreset(config.presetId).thinkingControl;
  const requestModel = String(options.model || config.model || "");
  if (
    thinkingControl &&
    getPref("llmDisableThinking") !== false &&
    (!thinkingControl.modelPattern ||
      thinkingControl.modelPattern.test(requestModel))
  ) {
    body[thinkingControl.field] = thinkingControl.disabledValue;
  }
  return body;
}

interface RequestContext {
  controller: AbortController;
  cleanup: () => void;
}

function createRequestContext(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): RequestContext {
  const controller = createAbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  if (timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  return {
    controller,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

/**
 * Send a chat completion request. Streams when `stream` is enabled and calls
 * `onDelta`; otherwise resolves with the full text.
 */
export async function chatCompletion(
  messages: AiMessage[],
  options: LLMChatOptions = {},
  configOverride?: LLMRuntimeConfig,
): Promise<string> {
  const purpose: AiPurpose = options.purpose || "chat";
  const config = configOverride || getLLMConfig(purpose);
  if (!configOverride && !isLLMConfigured(purpose)) {
    throw new LLMError("config", getLLMConfigError(purpose));
  }
  const endpoint = getLLMEndpoint(config);
  if (!endpoint) {
    throw new LLMError("config", "API Base URL 无效");
  }
  const stream = options.stream ?? config.stream;
  const request = createRequestContext(
    options.signal,
    options.timeoutMs ?? (stream ? 300_000 : 180_000),
  );
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(buildRequestBody(config, messages, stream, options)),
      signal: request.controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 404 || response.status === 405) {
        throw new LLMError(
          "config",
          "该服务商未提供模型列表接口，请手动填写模型名称",
        );
      }
      throw httpError(response.status, text);
    }
    const contentType = response.headers?.get?.("content-type") || "";
    if (!stream || !response.body || contentType.includes("application/json")) {
      const text = await response.text();
      // Some providers ignore `stream: true` and return a JSON body.
      const content = parseCompletionBody(text);
      options.onDelta?.(content, content);
      return content;
    }
    return await readStream(response, options);
  } catch (error) {
    if (error instanceof LLMError) throw error;
    if (isAbortError(error)) {
      if (options.signal?.aborted) {
        throw new LLMError("abort", "已取消");
      }
      throw new LLMError("network", "模型接口请求超时");
    }
    const message = errorToString(error);
    log("LLM request failed:", message);
    throw new LLMError("network", `无法连接模型接口：${message}`);
  } finally {
    request.cleanup();
  }
}

async function readStream(
  response: Response,
  options: LLMChatOptions,
): Promise<string> {
  const reader = (
    response.body as any
  ).getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let finished = false;

  const handleBlock = (block: string) => {
    if (!block || finished) return;
    const dataLines: string[] = [];
    for (const rawLine of block.replace(/\r/g, "").split("\n")) {
      if (!rawLine.startsWith("data:")) continue;
      const value = rawLine.slice(5).trim();
      if (value) dataLines.push(value);
    }
    if (!dataLines.length) return;
    const payload = parseSSEPayload(dataLines.join("\n"));
    if (!payload) return;
    if (payload.done && !payload.content) {
      finished = true;
    }
    if (payload.reasoning) {
      options.onReasoning?.(payload.reasoning);
    }
    if (payload.content) {
      full += payload.content;
      options.onDelta?.(payload.content, full);
    }
  };

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        handleBlock(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleBlock(buffer);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new LLMError("network", `读取模型响应失败：${errorToString(error)}`);
  } finally {
    try {
      await reader.releaseLock();
    } catch {
      // ignore
    }
  }
  if (!full.trim()) {
    throw new LLMError("parse", "模型没有返回任何内容");
  }
  return full;
}

/** Derive the `/models` endpoint from the configured chat endpoint. */
export function getModelsEndpoint(config: LLMRuntimeConfig): string {
  return getLLMEndpoint(config).replace(/\/chat\/completions$/i, "/models");
}

/**
 * Fetch the provider's model list using the configured key.
 * Supports the standard OpenAI `{ data: [{ id }] }` shape.
 */
export async function fetchAvailableModels(
  configOverride?: LLMRuntimeConfig,
): Promise<string[]> {
  const config = configOverride || getLLMConfig("chat");
  if (!config.baseURL) {
    throw new LLMError("config", "请先填写 API Base URL");
  }
  const endpoint = getModelsEndpoint(config);
  const request = createRequestContext(undefined, 20000);
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      signal: request.controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 404 || response.status === 405) {
        throw new LLMError(
          "config",
          "该服务商未提供模型列表接口，请手动填写模型名称",
        );
      }
      throw httpError(response.status, text);
    }
    const json: any = await response.json();
    const rawList = Array.isArray(json?.data)
      ? json.data
      : Array.isArray(json?.models)
        ? json.models
        : [];
    const ids: string[] = rawList
      .map((item: any) =>
        typeof item === "string" ? item : String(item?.id || item?.name || ""),
      )
      .map((id: string) => id.trim())
      .filter(Boolean);
    const unique: string[] = [...new Set(ids)];
    // Avoid accidentally selecting a reasoning model when a chat model exists.
    unique.sort((a, b) => {
      const aReason = /reason|think/i.test(a) ? 1 : 0;
      const bReason = /reason|think/i.test(b) ? 1 : 0;
      return aReason - bReason || a.localeCompare(b);
    });
    if (!unique.length) {
      throw new LLMError("parse", "接口没有返回模型列表，请手动填写模型名称");
    }
    return unique;
  } catch (error) {
    if (error instanceof LLMError) throw error;
    if (isAbortError(error)) {
      throw new LLMError("network", "获取模型列表超时");
    }
    throw new LLMError("network", `获取模型列表失败：${errorToString(error)}`);
  } finally {
    request.cleanup();
  }
}

export interface LLMTestResult {
  ok: boolean;
  latencyMs: number;
  model: string;
  message: string;
}

/** Test the configured endpoint with a minimal request. */
export async function testLLMConnection(
  configOverride?: LLMRuntimeConfig,
): Promise<LLMTestResult> {
  const config = configOverride || getLLMConfig("chat");
  const startedAt = Date.now();
  try {
    const reply = await chatCompletion(
      [
        {
          role: "user",
          content: "This is a connection test. Reply with the single word: OK",
        },
      ],
      {
        stream: false,
        maxTokens: 16,
        temperature: 0,
        purpose: "chat",
      },
      configOverride,
    );
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      model: config.model,
      message: `连接成功（${Date.now() - startedAt} ms）：${reply
        .trim()
        .slice(0, 60)}`,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      model: config.model,
      message: error instanceof LLMError ? error.message : errorToString(error),
    };
  }
}
