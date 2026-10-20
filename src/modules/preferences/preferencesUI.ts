import { config } from "../../../package.json";
import { getLLMConfig } from "../ai/config";
import { getDefaultTemplates } from "../chat/quickPhrases";
import { fetchAvailableModels, testLLMConnection } from "../ai/llm";
import { LLM_PRESETS, getLLMPreset } from "../ai/presets";
import { JOURNAL_FIELDS, DEFAULT_ENABLED_FIELDS } from "../journal/fields";
import {
  clearJournalCache,
  getJournalCacheStats,
  testEasyScholarKey,
} from "../journal/service";
import { clearRetractionCache } from "../retraction/service";
import {
  registerJournalColumn,
  unregisterJournalColumn,
} from "../ui/treeColumn";
import {
  registerJournalSection,
  unregisterJournalSection,
} from "../ui/journalSection";
import { pluginCache } from "../../utils/cache";
import { getDownloadsDir, getPluginDataDir, revealFile } from "../../utils/fs";
import { t } from "../../utils/i18n";
import { log } from "../../utils/log";
import { getPref, setPref } from "../../utils/prefs";

type PrefKey = keyof _ZoteroTypes.Prefs["PluginPrefsMap"];

function byId<T extends Element = HTMLElement>(
  win: Window,
  id: string,
): T | null {
  return win.document.getElementById(id) as T | null;
}

function setStatus(win: Window, id: string, text: string, ok?: boolean): void {
  const label = byId(win, id);
  if (!label) return;
  label.textContent = text;
  // XUL <label> renders its `value` attribute, not textContent.
  label.setAttribute("value", text);
  label.classList.remove(
    "pm-pref-status-ok",
    "pm-pref-status-error",
    "pm-pref-status-pending",
  );
  if (ok === true) label.classList.add("pm-pref-status-ok");
  else if (ok === false) label.classList.add("pm-pref-status-error");
  else label.classList.add("pm-pref-status-pending");
}

function bindCheckbox(win: Window, id: string, key: PrefKey): void {
  const checkbox = byId<HTMLInputElement & { checked: boolean }>(win, id);
  if (!checkbox) return;
  checkbox.checked = Boolean(getPref(key));
  const handler = () => setPref(key, checkbox.checked as never);
  checkbox.addEventListener("command", handler);
  checkbox.addEventListener("change", handler);
}

function bindText(win: Window, id: string, key: PrefKey): void {
  const input = byId<HTMLInputElement>(win, id);
  if (!input) return;
  input.value = String(getPref(key) ?? "");
  input.addEventListener("change", () => setPref(key, input.value as never));
  input.addEventListener("blur", () => setPref(key, input.value as never));
}

function bindNumber(win: Window, id: string, key: PrefKey, int = true): void {
  const input = byId<HTMLInputElement>(win, id);
  if (!input) return;
  input.value = String(getPref(key) ?? "");
  const min = Number(input.getAttribute("min"));
  const max = Number(input.getAttribute("max"));
  const sanitize = () => {
    let raw = input.value.replace(/[^\d.-]/g, "");
    if (int) raw = raw.replace(/\./g, "");
    if (raw.startsWith("-") && Number.isFinite(min) && min >= 0) {
      raw = raw.slice(1);
    }
    input.value = raw;
  };
  const save = () => {
    sanitize();
    const parsed = int ? parseInt(input.value, 10) : parseFloat(input.value);
    if (!Number.isFinite(parsed)) return;
    let value = parsed;
    if (Number.isFinite(min)) value = Math.max(min, value);
    if (Number.isFinite(max)) value = Math.min(max, value);
    if (int) value = Math.round(value);
    input.value = String(value);
    if (key === "llmTemperature" || key === "chatTemperature") {
      setPref(key, String(value) as never);
    } else {
      setPref(key, value as never);
    }
  };
  input.addEventListener("input", sanitize);
  input.addEventListener("change", save);
  input.addEventListener("blur", save);
}

function bindMenulist(win: Window, id: string, key: PrefKey): void {
  const menulist = byId<any>(win, id);
  if (!menulist) return;
  menulist.value = String(getPref(key) ?? "");
  const save = () => setPref(key, String(menulist.value) as never);
  menulist.addEventListener("command", save);
  menulist.addEventListener("change", save);
}

function bindTextarea(win: Window, id: string, key: PrefKey): void {
  const textarea = byId<HTMLTextAreaElement>(win, id);
  if (!textarea) return;
  textarea.value = String(getPref(key) ?? "");
  let timer: ReturnType<typeof setTimeout> | null = null;
  textarea.addEventListener("input", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      setPref(key, textarea.value as never);
    }, 300);
  });
}

function updateThinkingCapability(
  win: Window,
  preset = getLLMPreset(String(getPref("llmPreset") || "custom")),
): void {
  const checkbox = byId<HTMLInputElement>(win, "pm-llm-disable-thinking");
  if (!checkbox) return;
  const supported = Boolean(preset.thinkingControl);
  checkbox.disabled = !supported;
  checkbox.checked = supported ? Boolean(getPref("llmDisableThinking")) : false;
  checkbox.title = supported
    ? t(
        "pref-thinking-supported",
        "当前服务商支持关闭深度思考；请求会附带关闭推理的参数。",
      )
    : t(
        "pref-thinking-unsupported",
        "当前服务商未提供关闭深度思考的接口参数；此设置不会发送额外参数。",
      );
}

function populateModelOptions(
  win: Window,
  models: string[] = [],
  selected?: string,
): string {
  const menulist = byId<any>(win, "pm-llm-model");
  const popup = byId(win, "pm-llm-model-popup");
  if (!menulist || !popup) return "";
  const current = String(
    selected ?? menulist.value ?? getPref("llmModel") ?? "",
  ).trim();
  const list = [
    ...new Set([...models, current].map((model) => String(model || "").trim())),
  ].filter(Boolean);
  while (popup.firstChild) popup.removeChild(popup.firstChild);
  for (const model of list) {
    const item = win.document.createXULElement("menuitem");
    item.setAttribute("value", model);
    item.setAttribute("label", model);
    popup.appendChild(item);
  }
  if (current) menulist.value = current;
  return menulist.value || "";
}

function bindModelMenulist(win: Window): void {
  const menulist = byId<any>(win, "pm-llm-model");
  if (!menulist) return;
  const save = () => setPref("llmModel", String(menulist.value || "") as never);
  menulist.addEventListener("command", save);
  menulist.addEventListener("change", save);
  menulist.addEventListener("blur", save, true);
  try {
    const field = menulist.inputField;
    field?.addEventListener("input", () => {
      setPref("llmModel", String(field.value || "") as never);
    });
  } catch {
    // Non-editable menu; command/change still work.
  }
}

function populatePresets(win: Window): void {
  const menulist = byId<any>(win, "pm-llm-preset");
  const popup = byId(win, "pm-llm-preset-popup");
  if (!menulist || !popup) return;
  while (popup.firstChild) popup.removeChild(popup.firstChild);
  for (const preset of LLM_PRESETS) {
    const item = win.document.createXULElement("menuitem");
    item.setAttribute("value", preset.id);
    item.setAttribute("label", preset.label);
    popup.appendChild(item);
  }
  menulist.value = String(getPref("llmPreset") || "custom");
  menulist.addEventListener("command", () => {
    const preset = getLLMPreset(String(menulist.value));
    setPref("llmPreset", preset.id as never);
    const baseURL = byId<HTMLInputElement>(win, "pm-llm-baseurl");
    if (preset.id !== "custom") {
      setPref("llmBaseURL", preset.baseURL as never);
      setPref("llmModel", preset.defaultModel as never);
      if (baseURL) baseURL.value = preset.baseURL;
      populateModelOptions(win, [preset.defaultModel], preset.defaultModel);
    } else {
      setPref("llmBaseURL", "" as never);
      setPref("llmModel", "" as never);
      if (baseURL) baseURL.value = "";
      populateModelOptions(win, [], "");
    }
    updateThinkingCapability(win, preset);
    setStatus(
      win,
      "pm-llm-status",
      preset.hint ? `${preset.label} · ${preset.hint}` : preset.label,
    );
  });
  const preset = getLLMPreset(String(getPref("llmPreset") || "custom"));
  populateModelOptions(
    win,
    preset.defaultModel ? [preset.defaultModel] : [],
    String(getPref("llmModel") || preset.defaultModel || ""),
  );
  updateThinkingCapability(win, preset);
  if (preset.hint) {
    setStatus(win, "pm-llm-status", `${preset.label} · ${preset.hint}`);
  }
}

function renderTemplatePresets(win: Window): void {
  const container = byId(win, "pm-chat-template-presets");
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);
  for (const template of getDefaultTemplates()) {
    const row = win.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    row.className = "pm-pref-template";
    const name = win.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "span",
    ) as HTMLSpanElement;
    name.className = "pm-pref-template-name";
    name.textContent = template.label;
    const prompt = win.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "span",
    ) as HTMLSpanElement;
    prompt.className = "pm-pref-template-prompt";
    prompt.textContent = template.prompt;
    prompt.title = template.prompt;
    row.append(name, prompt);
    container.appendChild(row);
  }
}

function populateJournalFields(win: Window): void {
  const container = byId(win, "pm-journal-fields");
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);
  const enabled = new Set(
    String(getPref("journalFields") || DEFAULT_ENABLED_FIELDS.join(","))
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const updatePref = () => {
    const selected = JOURNAL_FIELDS.filter((field) =>
      enabled.has(field.key),
    ).map((field) => field.key);
    setPref("journalFields", selected.join(",") as never);
  };
  for (const field of JOURNAL_FIELDS) {
    const checkbox = win.document.createXULElement("checkbox") as any;
    checkbox.setAttribute("label", t(`pref-field-${field.key}`, field.label));
    checkbox.checked = enabled.has(field.key);
    checkbox.addEventListener("command", () => {
      if (checkbox.checked) enabled.add(field.key);
      else enabled.delete(field.key);
      updatePref();
    });
    checkbox.classList.add("pm-pref-field-checkbox");
    container.appendChild(checkbox);
  }
}

function updateTranslateEngineVisibility(win: Window): void {
  const engine = String(getPref("translateEngine") || "llm");
  byId(win, "pm-tr-deepl")?.toggleAttribute("hidden", engine !== "deepl");
  byId(win, "pm-tr-youdao")?.toggleAttribute("hidden", engine !== "youdao");
  byId(win, "pm-tr-tencent")?.toggleAttribute("hidden", engine !== "tencent");
}

function applyViewPreferences(): void {
  try {
    if (getPref("journalShowSection")) registerJournalSection();
    else unregisterJournalSection();
  } catch (error) {
    log("failed to toggle journal section", error);
  }
  void (async () => {
    try {
      if (getPref("journalShowColumn")) await registerJournalColumn();
      else await unregisterJournalColumn();
    } catch (error) {
      log("failed to toggle journal column", error);
    }
  })();
}

function flushTextPrefs(win: Window): void {
  const pairs: Array<[string, PrefKey]> = [
    ["pm-llm-baseurl", "llmBaseURL"],
    ["pm-llm-apikey", "llmApiKey"],
    ["pm-journal-secret", "journalSecretKey"],
    ["pm-tr-deepl-key", "translateDeepLKey"],
    ["pm-tr-deepl-endpoint", "translateDeepLEndpoint"],
    ["pm-tr-youdao-key", "translateYoudaoAppKey"],
    ["pm-tr-youdao-secret", "translateYoudaoAppSecret"],
    ["pm-tr-tencent-key", "translateTencentSecretId"],
    ["pm-tr-tencent-secret", "translateTencentSecretKey"],
    ["pm-tr-tencent-region", "translateTencentRegion"],
  ];
  for (const [id, key] of pairs) {
    const input = byId<HTMLInputElement>(win, id);
    if (input) setPref(key, input.value as never);
  }
  const modelMenu = byId<any>(win, "pm-llm-model");
  if (modelMenu) setPref("llmModel", String(modelMenu.value || "") as never);
}

async function bindActions(win: Window): Promise<void> {
  const testButton = byId<HTMLButtonElement>(win, "pm-llm-test");
  if (testButton) {
    testButton.addEventListener("command", async () => {
      flushTextPrefs(win);
      const cfg = getLLMConfig("chat");
      if (
        !cfg.baseURL ||
        !cfg.model ||
        (!cfg.apiKey && cfg.presetId !== "custom")
      ) {
        setStatus(
          win,
          "pm-llm-status",
          "请先填写 Base URL、API Key 和模型",
          false,
        );
        return;
      }
      testButton.disabled = true;
      setStatus(win, "pm-llm-status", "正在测试连接…");
      const result = await testLLMConnection();
      setStatus(win, "pm-llm-status", result.message, result.ok);
      testButton.disabled = false;
    });
  }

  const fetchModelsButton = byId<HTMLButtonElement>(win, "pm-llm-fetch-models");
  if (fetchModelsButton) {
    fetchModelsButton.addEventListener("command", async () => {
      flushTextPrefs(win);
      fetchModelsButton.disabled = true;
      setStatus(win, "pm-llm-status", "正在获取模型列表…");
      try {
        const models = await fetchAvailableModels();
        const currentModel = String(getPref("llmModel") || "").trim();
        const selected = currentModel || models[0];
        populateModelOptions(win, models, selected);
        if (selected) setPref("llmModel", selected as never);
        setStatus(
          win,
          "pm-llm-status",
          `已获取 ${models.length} 个模型：${models.slice(0, 6).join("、")}${
            models.length > 6 ? "…" : ""
          }`,
          true,
        );
      } catch (error) {
        setStatus(
          win,
          "pm-llm-status",
          String((error as Error)?.message || error),
          false,
        );
      } finally {
        fetchModelsButton.disabled = false;
      }
    });
  }

  const journalTestButton = byId<HTMLButtonElement>(win, "pm-journal-test");
  if (journalTestButton) {
    journalTestButton.addEventListener("command", async () => {
      flushTextPrefs(win);
      journalTestButton.disabled = true;
      setStatus(win, "pm-journal-status", "正在检测 EasyScholar 密钥…");
      try {
        const result = await testEasyScholarKey();
        if (result.ok) {
          setStatus(
            win,
            "pm-journal-status",
            `密钥有效：${result.message}`,
            true,
          );
        } else {
          setStatus(win, "pm-journal-status", result.message, false);
        }
      } catch (error) {
        setStatus(
          win,
          "pm-journal-status",
          String((error as Error)?.message || error),
          false,
        );
      } finally {
        journalTestButton.disabled = false;
      }
    });
  }

  const addTemplateButton = byId<HTMLButtonElement>(
    win,
    "pm-chat-add-template",
  );
  if (addTemplateButton) {
    addTemplateButton.addEventListener("command", () => {
      const textarea = byId<HTMLTextAreaElement>(win, "pm-chat-quick-phrases");
      if (!textarea) return;
      const prefix = textarea.value.trim() ? "\n" : "";
      textarea.value = `${textarea.value}${prefix}新模板 | `;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      setPref("chatQuickPhrases", textarea.value as never);
    });
  }

  const toggleKey = byId<HTMLButtonElement>(win, "pm-toggle-apikey");
  if (toggleKey) {
    toggleKey.addEventListener("command", () => {
      const input = byId<HTMLInputElement>(win, "pm-llm-apikey");
      if (!input) return;
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      toggleKey.setAttribute("label", show ? "隐藏" : "显示");
    });
  }

  byId<HTMLButtonElement>(win, "pm-journal-open-site")?.addEventListener(
    "command",
    () => Zotero.launchURL("https://www.easyscholar.cc/"),
  );

  byId<HTMLButtonElement>(win, "pm-journal-clear")?.addEventListener(
    "command",
    async () => {
      await clearJournalCache();
      setStatus(win, "pm-llm-status", "期刊缓存已清除", true);
      try {
        const { refreshJournalColumn } = await import("../ui/treeColumn");
        refreshJournalColumn();
      } catch {
        // ignore
      }
    },
  );

  byId<HTMLButtonElement>(win, "pm-retraction-clear")?.addEventListener(
    "command",
    async () => {
      await clearRetractionCache();
      setStatus(win, "pm-llm-status", "撤稿缓存已清除", true);
    },
  );

  byId<HTMLButtonElement>(win, "pm-chat-clear")?.addEventListener(
    "command",
    async () => {
      await pluginCache.clear("chat");
      setStatus(win, "pm-llm-status", "对话记录已清除", true);
    },
  );

  byId<HTMLButtonElement>(win, "pm-ppt-pick-dir")?.addEventListener(
    "command",
    async () => {
      try {
        const picker = new ztoolkit.FilePicker(
          t("pref-ppt-pick", "选择 PPT 输出目录"),
          "folder",
        );
        const folder = await picker.open();
        if (folder) {
          setPref("pptOutputDir", folder as never);
          const input = byId<HTMLInputElement>(win, "pm-ppt-dir");
          if (input) input.value = folder;
        }
      } catch (error) {
        log("pick folder failed", error);
      }
    },
  );

  byId<HTMLButtonElement>(win, "pm-open-datadir")?.addEventListener(
    "command",
    async () => {
      const dir = getPluginDataDir();
      try {
        await Zotero.File.createDirectoryIfMissingAsync(dir);
      } catch {
        // ignore
      }
      revealFile(dir);
    },
  );

  byId<HTMLButtonElement>(win, "pm-reset-prefs")?.addEventListener(
    "command",
    async () => {
      const confirmed = (
        win as Window & { confirm?: (msg: string) => boolean }
      ).confirm?.(t("pref-reset-confirm", "确定恢复 PaperMiner 默认设置？"));
      if (!confirmed) return;
      const { resetPrefs } = await import("./defaults");
      resetPrefs();
      try {
        (win as any).location?.reload();
      } catch {
        // Fall back to refreshing the visible values without rebinding.
        setStatus(win, "pm-llm-status", "已恢复默认设置", true);
      }
    },
  );

  const journalToggle = byId<HTMLInputElement>(win, "pm-journal-showsection");
  journalToggle?.addEventListener("command", () => applyViewPreferences());
  const columnToggle = byId<HTMLInputElement>(win, "pm-journal-showcolumn");
  columnToggle?.addEventListener("command", () => applyViewPreferences());

  const engineMenu = byId(win, "pm-tr-engine");
  engineMenu?.addEventListener("command", () =>
    updateTranslateEngineVisibility(win),
  );
}

export async function initPreferencesUI(
  win: Window,
  force = false,
): Promise<void> {
  const root = byId<HTMLElement & { dataset: DOMStringMap }>(
    win,
    "paperminer-prefpane",
  );
  if (!root) return;
  if (root.dataset.paperminerInitialized === "1" && !force) return;
  root.dataset.paperminerInitialized = "1";

  populatePresets(win);
  populateJournalFields(win);
  renderTemplatePresets(win);

  bindCheckbox(win, "pm-llm-stream", "llmStream");
  bindCheckbox(win, "pm-llm-disable-thinking", "llmDisableThinking");
  bindText(win, "pm-llm-baseurl", "llmBaseURL");
  bindText(win, "pm-llm-apikey", "llmApiKey");
  bindModelMenulist(win);
  bindNumber(win, "pm-llm-temperature", "llmTemperature", false);
  bindNumber(win, "pm-llm-maxtokens", "llmMaxTokens");
  bindText(win, "pm-llm-summarymodel", "llmSummaryModel");
  bindText(win, "pm-llm-translatemodel", "llmTranslateModel");
  bindText(win, "pm-llm-pptmodel", "llmPptModel");

  bindCheckbox(win, "pm-journal-enabled", "journalEnabled");
  bindText(win, "pm-journal-secret", "journalSecretKey");
  bindNumber(win, "pm-journal-cachedays", "journalCacheDays");
  bindCheckbox(win, "pm-journal-showsection", "journalShowSection");
  bindCheckbox(win, "pm-journal-showcolumn", "journalShowColumn");
  bindCheckbox(win, "pm-journal-showbanner", "journalShowReaderBanner");

  bindCheckbox(win, "pm-ret-enabled", "retractionEnabled");
  bindCheckbox(win, "pm-ret-zotero", "retractionUseZotero");
  bindCheckbox(win, "pm-ret-openalex", "retractionUseOpenAlex");
  bindCheckbox(win, "pm-ret-crossref", "retractionUseCrossref");
  bindNumber(win, "pm-ret-cachedays", "retractionCacheDays");
  bindCheckbox(win, "pm-ret-banner", "retractionShowReaderBanner");

  bindCheckbox(win, "pm-sum-auto", "summaryAuto");
  bindText(win, "pm-sum-tag", "summaryTag");
  bindMenulist(win, "pm-sum-lang", "summaryLanguage");
  bindTextarea(win, "pm-sum-prompt", "summaryPrompt");

  bindNumber(win, "pm-chat-context", "chatContextChars");
  bindNumber(win, "pm-chat-history", "chatMaxHistory");
  bindNumber(win, "pm-chat-temp", "chatTemperature", false);
  bindCheckbox(win, "pm-chat-persist", "chatPersist");
  bindTextarea(win, "pm-chat-system-prompt", "chatSystemPrompt");
  bindTextarea(win, "pm-chat-quick-phrases", "chatQuickPhrases");

  bindNumber(win, "pm-ppt-slides", "pptSlides");
  bindTextarea(win, "pm-ppt-prompt", "pptPrompt");
  bindMenulist(win, "pm-ppt-lang", "pptLanguage");
  bindCheckbox(win, "pm-ppt-open", "pptOpenAfter");
  bindText(win, "pm-ppt-dir", "pptOutputDir");

  bindMenulist(win, "pm-tr-engine", "translateEngine");
  bindMenulist(win, "pm-tr-target", "translateTarget");
  bindText(win, "pm-tr-deepl-key", "translateDeepLKey");
  bindText(win, "pm-tr-deepl-endpoint", "translateDeepLEndpoint");
  bindText(win, "pm-tr-youdao-key", "translateYoudaoAppKey");
  bindText(win, "pm-tr-youdao-secret", "translateYoudaoAppSecret");
  bindCheckbox(win, "pm-tr-showpopup", "translateShowPopup");
  bindTextarea(win, "pm-tr-prompt", "translatePrompt");
  bindText(win, "pm-tr-tencent-key", "translateTencentSecretId");
  bindText(win, "pm-tr-tencent-secret", "translateTencentSecretKey");
  bindText(win, "pm-tr-tencent-region", "translateTencentRegion");

  updateTranslateEngineVisibility(win);
  updateThinkingCapability(win);
  await bindActions(win);

  const versionLabel = byId(win, "pm-about-version");
  if (versionLabel) {
    const count = getJournalCacheStats().count;
    const buildVersion = (config as any).buildVersion || "dev";
    const versionText = `PaperMiner ${buildVersion} · 数据目录缓存 ${count} 条 · PPT 默认输出 ${getDownloadsDir()}/PaperMiner`;
    versionLabel.textContent = versionText;
    versionLabel.setAttribute("value", versionText);
  }
  log("preferences UI ready");
}
