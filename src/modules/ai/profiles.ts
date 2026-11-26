/**
 * Per-provider LLM profiles.
 *
 * Zotero stores only one active LLM configuration. To make switching between
 * DeepSeek, OpenAI, DashScope, etc. useful, remember the base URL, model and
 * API key for each preset and swap them atomically when the user changes the
 * provider.
 */

import { getPref, setPref } from "../../utils/prefs";
import { getLLMPreset, LLM_PRESETS } from "./presets";

export interface LLMProfile {
  baseURL: string;
  model: string;
  apiKey: string;
  summaryModel?: string;
  translateModel?: string;
  pptModel?: string;
  disableThinking?: boolean;
}

const PROFILES_PREF = "llmProfiles";

function stringPref(key: string): string {
  try {
    return String(getPref(key as never) || "").trim();
  } catch {
    return "";
  }
}

function currentProfile(): LLMProfile {
  return {
    baseURL: stringPref("llmBaseURL"),
    model: stringPref("llmModel"),
    apiKey: stringPref("llmApiKey"),
    summaryModel: stringPref("llmSummaryModel"),
    translateModel: stringPref("llmTranslateModel"),
    pptModel: stringPref("llmPptModel"),
    disableThinking: Boolean(getPref("llmDisableThinking")),
  };
}

export function loadLLMProfiles(): Record<string, LLMProfile> {
  const raw = stringPref(PROFILES_PREF);
  if (!raw) return {};
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const out: Record<string, LLMProfile> = {};
    for (const [id, value] of Object.entries(data)) {
      if (!value || typeof value !== "object") continue;
      const record = value as Partial<LLMProfile>;
      out[id] = {
        baseURL: String(record.baseURL || ""),
        model: String(record.model || ""),
        apiKey: String(record.apiKey || ""),
        ...(record.summaryModel
          ? { summaryModel: String(record.summaryModel) }
          : {}),
        ...(record.translateModel
          ? { translateModel: String(record.translateModel) }
          : {}),
        ...(record.pptModel ? { pptModel: String(record.pptModel) } : {}),
        ...(typeof record.disableThinking === "boolean"
          ? { disableThinking: record.disableThinking }
          : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function saveProfiles(profiles: Record<string, LLMProfile>): void {
  setPref(PROFILES_PREF, JSON.stringify(profiles) as never);
}

/** Save the currently active fields into the active provider's profile. */
export function saveCurrentLLMProfile(): string {
  const presetId = stringPref("llmPreset") || "custom";
  const profiles = loadLLMProfiles();
  profiles[presetId] = currentProfile();
  saveProfiles(profiles);
  return presetId;
}

/** Switch the active LLM to a saved provider profile. */
export function switchLLMProvider(presetId: string): {
  presetId: string;
  label: string;
  configured: boolean;
} {
  const currentId = stringPref("llmPreset") || "custom";
  const profiles = loadLLMProfiles();
  profiles[currentId] = currentProfile();

  const preset = getLLMPreset(presetId);
  const saved = profiles[preset.id];
  const profile: LLMProfile = saved || {
    baseURL: preset.baseURL,
    model: preset.defaultModel,
    apiKey: "",
  };
  if (!saved) profiles[preset.id] = profile;
  saveProfiles(profiles);

  setPref("llmPreset", preset.id as never);
  setPref("llmBaseURL", (profile.baseURL || preset.baseURL || "") as never);
  setPref("llmModel", (profile.model || preset.defaultModel || "") as never);
  setPref("llmApiKey", (profile.apiKey || "") as never);
  setPref("llmSummaryModel", (profile.summaryModel || "") as never);
  setPref("llmTranslateModel", (profile.translateModel || "") as never);
  setPref("llmPptModel", (profile.pptModel || "") as never);
  if (typeof profile.disableThinking === "boolean") {
    setPref("llmDisableThinking", profile.disableThinking as never);
  }
  return {
    presetId: preset.id,
    label: preset.label,
    configured: Boolean(
      profile.baseURL &&
      profile.model &&
      (profile.apiKey || preset.id === "custom"),
    ),
  };
}

/** Whether a provider has enough saved data to be selectable. */
export function isLLMProviderConfigured(presetId: string): boolean {
  const preset = getLLMPreset(presetId);
  const profiles = loadLLMProfiles();
  const active = (stringPref("llmPreset") || "custom") === preset.id;
  const profile = active ? currentProfile() : profiles[preset.id] || null;
  if (!profile) return false;
  return Boolean(
    (profile.baseURL || preset.baseURL) &&
    (profile.model || preset.defaultModel) &&
    (profile.apiKey || preset.id === "custom"),
  );
}

/** Presets that have saved credentials (for compact provider pickers). */
export function configuredLLMProviders(): string[] {
  return LLM_PRESETS.map((preset) => preset.id).filter(isLLMProviderConfigured);
}
