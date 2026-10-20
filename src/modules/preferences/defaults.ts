import { config } from "../../../package.json";
import { log } from "../../utils/log";

/**
 * Runtime defaults. Keep in sync with addon/prefs.js (scaffold writes those
 * defaults on install, this guards upgrades and test profiles).
 */
export const DEFAULT_PREFS: Record<string, string | number | boolean> = {
  enable: true,
  debug: false,

  llmPreset: "custom",
  llmBaseURL: "",
  llmApiKey: "",
  llmModel: "",
  llmTemperature: "0.3",
  llmMaxTokens: 4096,
  llmStream: true,
  llmDisableThinking: true,
  llmSummaryModel: "",
  llmTranslateModel: "",
  llmPptModel: "",

  journalEnabled: true,
  journalSecretKey: "",
  journalFields:
    "sciUp,sciUpTop,sci,sciif,sciWarning,cssci,pku,cscd,zhongguokejihexin,cju",
  journalCacheDays: 30,
  journalShowSection: true,
  journalShowColumn: true,
  journalShowReaderBanner: true,

  summaryAuto: false,
  summaryTag: "PaperMiner-AI阅读摘要",
  summaryLanguage: "auto",
  summaryPrompt: "",

  chatContextChars: 60000,
  chatMaxHistory: 20,
  chatPersist: true,
  chatTemperature: "0.3",
  chatSystemPrompt: "",
  chatQuickPhrases: "",
  chatSkills: "",

  pptSlides: 12,
  pptPrompt: "",
  pptLanguage: "auto",
  pptOutputDir: "",
  pptOpenAfter: true,

  translateEngine: "llm",
  translateTarget: "auto",
  translateDeepLKey: "",
  translateDeepLEndpoint: "https://api-free.deepl.com/v2/translate",
  translateYoudaoAppKey: "",
  translateYoudaoAppSecret: "",
  translateShowPopup: true,
  translatePrompt: "",
  translateTencentSecretId: "",
  translateTencentSecretKey: "",
  translateTencentRegion: "ap-guangzhou",
};

function prefPath(key: string): string {
  return `${config.prefsPrefix}.${key}`;
}

const LEGACY_JOURNAL_FIELDS = "sci,sciUp,sciif,sciWarning";
const NEW_JOURNAL_FIELDS =
  "sciUp,sciUpTop,sci,sciif,sciWarning,cssci,pku,cscd,zhongguokejihexin,cju";

/** Fill in any missing preferences. Safe to call on every startup. */
export function ensurePrefs(): void {
  // Existing installs used a default field set that omitted Chinese core
  // lists, which made domestic journals look like they had no data.
  try {
    if (
      String(Zotero.Prefs.get(prefPath("journalFields"), true) || "") ===
      LEGACY_JOURNAL_FIELDS
    ) {
      Zotero.Prefs.set(prefPath("journalFields"), NEW_JOURNAL_FIELDS, true);
    }
  } catch {
    // ignore
  }
  for (const [key, value] of Object.entries(DEFAULT_PREFS)) {
    try {
      const current = Zotero.Prefs.get(prefPath(key), true);
      if (current === undefined || current === null) {
        Zotero.Prefs.set(prefPath(key), value, true);
      }
    } catch (error) {
      log("ensurePrefs failed for", key, error);
    }
  }
}

export function resetPrefs(): void {
  for (const [key, value] of Object.entries(DEFAULT_PREFS)) {
    try {
      Zotero.Prefs.set(prefPath(key), value, true);
    } catch {
      // ignore
    }
  }
}
