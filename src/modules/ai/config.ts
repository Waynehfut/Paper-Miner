import { config } from "../../../package.json";
import type { AiPurpose, LLMRuntimeConfig } from "../../types";
import { getNumberPref, getPref } from "../../utils/prefs";
import { getLLMPreset, normalizeChatEndpoint } from "./presets";

/** Resolve the effective runtime configuration for an AI purpose. */
export function getLLMConfig(purpose: AiPurpose = "chat"): LLMRuntimeConfig {
  const presetId = String(getPref("llmPreset") || "custom");
  const preset = getLLMPreset(presetId);
  const baseURL = String(getPref("llmBaseURL") || preset.baseURL || "").trim();
  const apiKey = String(getPref("llmApiKey") || "").trim();
  const modelFromPref = String(getPref("llmModel") || "").trim();
  let model = modelFromPref || preset.defaultModel || "";
  if (purpose === "summary") {
    model = String(getPref("llmSummaryModel") || "").trim() || model;
  } else if (purpose === "translation") {
    model = String(getPref("llmTranslateModel") || "").trim() || model;
  } else if (purpose === "ppt") {
    model = String(getPref("llmPptModel") || "").trim() || model;
  }
  return {
    presetId,
    baseURL,
    apiKey,
    model,
    temperature: getNumberPref("llmTemperature", 0.3, 0, 2),
    maxTokens: getNumberPref("llmMaxTokens", 4096, 128, 65536, true),
    stream: Boolean(getPref("llmStream")),
  };
}

export function isLLMConfigured(purpose: AiPurpose = "chat"): boolean {
  const cfg = getLLMConfig(purpose);
  // Custom endpoints (e.g. a local Ollama server) may not require a key.
  const hasCredential = Boolean(cfg.apiKey) || cfg.presetId === "custom";
  return Boolean(cfg.baseURL && cfg.model && hasCredential);
}

export function getLLMConfigError(purpose: AiPurpose = "chat"): string {
  const cfg = getLLMConfig(purpose);
  if (!cfg.baseURL) return "请先在 PaperMiner 设置中填写 API Base URL";
  if (!cfg.apiKey && cfg.presetId !== "custom") {
    return "请先在 PaperMiner 设置中填写 API Key";
  }
  if (!cfg.model) return "请先在 PaperMiner 设置中填写模型名称";
  return "";
}

export function getLLMEndpoint(config: LLMRuntimeConfig): string {
  return normalizeChatEndpoint(config.baseURL);
}

/** Preferences key for the API key, kept in one place for tests/docs. */
export const LLM_API_KEY_PREF = `${config.prefsPrefix}.llmApiKey`;
