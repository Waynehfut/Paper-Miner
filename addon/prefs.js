/* PaperMiner preferences. Keep in sync with src/modules/preferences/defaults.ts */
pref("enable", true);
pref("debug", false);

/* AI service */
pref("llmPreset", "custom");
pref("llmBaseURL", "");
pref("llmApiKey", "");
pref("llmModel", "");
pref("llmTemperature", "0.3");
pref("llmMaxTokens", 4096);
pref("llmStream", true);
pref("llmDisableThinking", true);
pref("llmSummaryModel", "");
pref("llmTranslateModel", "");
pref("llmPptModel", "");

/* Journal ranking (EasyScholar) */
pref("journalEnabled", true);
pref("journalSecretKey", "");
pref(
  "journalFields",
  "sciUp,sciUpTop,sci,sciif,sciWarning,cssci,pku,cscd,zhongguokejihexin,cju",
);
pref("journalCacheDays", 30);
pref("journalShowSection", true);
pref("journalShowColumn", true);
pref("journalShowReaderBanner", true);

/* AI summary */
pref("summaryAuto", false);
pref("summaryTag", "PaperMiner-AI阅读摘要");
pref("summaryLanguage", "auto");
pref("summaryPrompt", "");

/* Chat */
pref("chatContextChars", 60000);
pref("chatMaxHistory", 20);
pref("chatPersist", true);
pref("chatTemperature", "0.3");
pref("chatSystemPrompt", "");
pref("chatQuickPhrases", "");
pref("chatSkills", "");

/* Presentation */
pref("pptSlides", 12);
pref("pptPrompt", "");
pref("pptLanguage", "auto");
pref("pptOutputDir", "");
pref("pptOpenAfter", true);

/* Selection translation */
pref("translateEngine", "llm");
pref("translateTarget", "auto");
pref("translateDeepLKey", "");
pref("translateDeepLEndpoint", "https://api-free.deepl.com/v2/translate");
pref("translateYoudaoAppKey", "");
pref("translateYoudaoAppSecret", "");
pref("translateShowPopup", true);
pref("translatePrompt", "");
pref("translateTencentSecretId", "");
pref("translateTencentSecretKey", "");
pref("translateTencentRegion", "ap-guangzhou");
pref("translateMyMemoryEmail", "");
