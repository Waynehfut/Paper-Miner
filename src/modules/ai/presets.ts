/** Built-in OpenAI-compatible API presets. */

/**
 * Optional provider capability: how to switch off "deep thinking" mode.
 * Providers without this capability simply ignore the preference; the UI
 * stays provider-neutral and never assumes a specific vendor.
 */
export interface LLMThinkingControl {
  /** Request body field, e.g. `thinking` or `enable_thinking`. */
  field: string;
  /** Value that disables reasoning. */
  disabledValue: unknown;
  /** Only send the switch for matching model families (some APIs reject it). */
  modelPattern?: RegExp;
}

export interface LLMPreset {
  id: string;
  label: string;
  baseURL: string;
  defaultModel: string;
  /** Extra hint shown in preferences. */
  hint?: string;
  /** Supported by some providers only; absent means "no known API switch". */
  thinkingControl?: LLMThinkingControl;
}

export const LLM_PRESETS: LLMPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    hint: "https://platform.deepseek.com/api_keys",
    // DeepSeek V4 enables thinking by default; this is the documented switch.
    thinkingControl: {
      field: "thinking",
      disabledValue: { type: "disabled" },
    },
  },
  {
    id: "openai",
    label: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    hint: "https://platform.openai.com/api-keys",
  },
  {
    id: "moonshot",
    label: "Kimi / Moonshot",
    baseURL: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-8k",
    hint: "https://platform.moonshot.cn/console/api-keys",
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-flash",
    hint: "https://open.bigmodel.cn/usercenter/apikeys",
    thinkingControl: {
      field: "thinking",
      disabledValue: { type: "disabled" },
      modelPattern: /glm-4\.[5-9]|glm-4-plus|glm-z1/i,
    },
  },
  {
    id: "qwen",
    label: "通义千问 / DashScope",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    hint: "https://bailian.console.aliyun.com/",
    // DashScope uses enable_thinking:false for Qwen3 thinking models.
    thinkingControl: {
      field: "enable_thinking",
      disabledValue: false,
      modelPattern: /qwen3|qwen-plus|qwen-max|qwen-turbo/i,
    },
  },
  {
    id: "siliconflow",
    label: "SiliconFlow 硅基流动",
    baseURL: "https://api.siliconflow.cn/v1",
    defaultModel: "Qwen/Qwen2.5-7B-Instruct",
    hint: "https://cloud.siliconflow.cn/account/ak",
    thinkingControl: {
      field: "enable_thinking",
      disabledValue: false,
      modelPattern: /qwen3/i,
    },
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    hint: "https://openrouter.ai/keys",
  },
  {
    id: "gemini",
    label: "Google Gemini (OpenAI 兼容)",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.0-flash",
    hint: "https://aistudio.google.com/apikey",
  },
  {
    id: "claude",
    label: "Anthropic Claude (OpenAI 兼容)",
    baseURL: "https://api.anthropic.com/v1",
    defaultModel: "claude-3-5-haiku-latest",
    hint: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "custom",
    label: "自定义 / 本地模型",
    baseURL: "",
    defaultModel: "",
    hint: "填写完整的 OpenAI 兼容 Base URL，例如 http://127.0.0.1:11434/v1",
  },
];

export function getLLMPreset(id: string): LLMPreset {
  return (
    LLM_PRESETS.find((preset) => preset.id === id) ??
    LLM_PRESETS.find((preset) => preset.id === "custom") ??
    LLM_PRESETS[0]
  );
}

/**
 * Normalize a user supplied base URL into a `…/chat/completions` endpoint.
 * Accepts with or without a trailing slash, and either a base URL or a full
 * chat-completions URL.
 */
export function normalizeChatEndpoint(baseURL: string): string {
  const url = (baseURL || "").trim().replace(/\/+$/, "");
  if (!url) {
    return "";
  }
  if (/\/chat\/completions$/i.test(url)) {
    return url;
  }
  if (
    /\/v\d+(?:beta)?$|\/api\/paas\/v\d+$|\/compatible-mode\/v\d+$/i.test(url) ||
    // Gemini's OpenAI-compatible base ends with `/openai`.
    /\/openai$/i.test(url)
  ) {
    return `${url}/chat/completions`;
  }
  // Most OpenAI-compatible providers expose the API under /v1.
  return `${url}/v1/chat/completions`;
}
