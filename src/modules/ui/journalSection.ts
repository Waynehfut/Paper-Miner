import { config } from "../../../package.json";
import { isLLMConfigured } from "../ai/config";
import { generatePpt } from "../ai/ppt";
import { generateSummary, openSummaryNote } from "../ai/summary";
import { prefetchJournalRanks, getJournalRank } from "../journal/service";
import { htmlEl, zoteroIconImg } from "../journal/dom";
import { clearChildren } from "../../utils/html";
import { t } from "../../utils/i18n";
import {
  findPDFAttachment,
  getRegularItemForReader,
  isPaperItem,
} from "../../utils/item";
import { errorToString, log } from "../../utils/log";
import { getPref } from "../../utils/prefs";
import { showProgress, toast } from "../../utils/ui";
import { openChatPanel } from "./chatPanel";
import { refreshJournalColumn } from "./treeColumn";

/**
 * Item pane section: AI action buttons. Journal badges live only in the
 * item-tree column now; this pane intentionally does not repeat them.
 * Owned by the journal UI module.
 */

export const JOURNAL_SECTION_ID = "paperminer-journal";

const ICON_URL = `chrome://${config.addonRef}/content/icons/header-16.png`;
const SIDENAV_ICON_URL = `chrome://${config.addonRef}/content/icons/sidenav-20.png`;
const NOTIFIER_ID = "paperminer-journal-section";

type SectionArgs = _ZoteroTypes.ItemPaneManagerSection.SectionHookArgs;
type InitArgs = _ZoteroTypes.ItemPaneManagerSection.SectionInitHookArgs;

let registeredKey: string | false | null = null;
let notifierID: string | false = false;
const sectionBodies = new Set<HTMLDivElement>();
const refreshByBody = new WeakMap<HTMLDivElement, () => Promise<void>>();
let selectionPrefetchTimer: ReturnType<typeof setTimeout> | null = null;

function resolveRegularItem(item: Zotero.Item | null | undefined) {
  return getRegularItemForReader(item);
}

function isApplicable(item: Zotero.Item | null | undefined): boolean {
  const regular = resolveRegularItem(item);
  return Boolean(regular && isPaperItem(regular));
}

function openPreferences(): void {
  try {
    Zotero.Utilities.Internal.openPreferences("paperminer-preference-pane");
  } catch (error) {
    log("openPreferences failed:", errorToString(error));
  }
}

function friendlyMessage(error: unknown): string {
  const message = errorToString(error);
  return message.length > 160 ? `${message.slice(0, 157)}…` : message;
}

function basename(path: string): string {
  const parts = String(path || "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

async function runSummary(item: Zotero.Item): Promise<void> {
  if (!isLLMConfigured("summary")) {
    toast(t("chat-not-configured", "尚未配置 AI 服务，点击前往设置"), "fail");
    openPreferences();
    return;
  }
  const progress = showProgress(
    t("summary-title", "AI 阅读摘要"),
    t("summary-generating", "正在生成 AI 摘要…"),
    5,
  );
  try {
    await generateSummary(item, {
      onProgress: (message, value) => progress.update(message, value),
    });
    progress.close(1200);
    toast(t("summary-done", "AI 摘要已保存为子笔记"), "success");
    openSummaryNote(item);
  } catch (error) {
    progress.close(0);
    toast(
      `${t("summary-failed", "生成 AI 摘要失败")}：${friendlyMessage(error)}`,
      "fail",
    );
  }
}

async function runChat(item: Zotero.Item): Promise<void> {
  try {
    await openChatPanel(item);
  } catch (error) {
    toast(`${t("chat-error", "对话失败")}：${friendlyMessage(error)}`, "fail");
  }
}

async function runPpt(item: Zotero.Item): Promise<void> {
  if (!isLLMConfigured("ppt")) {
    toast(t("chat-not-configured", "尚未配置 AI 服务，点击前往设置"), "fail");
    openPreferences();
    return;
  }
  const progress = showProgress(
    t("ppt-title", "生成汇报 PPT"),
    t("ppt-extracting", "正在提取论文正文…"),
    3,
  );
  try {
    const result = await generatePpt(item, {
      onProgress: (message, value) => progress.update(message, value),
    });
    progress.close(1500);
    toast(
      `${t("ppt-done", "PPT 已生成")}：${basename(result.filePath)}`,
      "success",
    );
  } catch (error) {
    progress.close(0);
    toast(
      `${t("ppt-failed", "生成 PPT 失败")}：${friendlyMessage(error)}`,
      "fail",
    );
  }
}

async function runTranslateEntry(item: Zotero.Item): Promise<void> {
  try {
    const attachment = await findPDFAttachment(item);
    if (!attachment) {
      toast(t("chat-no-pdf", "该条目没有 PDF 附件"), "fail");
      return;
    }
    // `Zotero.Reader.open` focuses the existing reader tab when one is open
    // and deduplicates otherwise.
    await Zotero.Reader.open(attachment.id);
    toast(
      t("translate-select-hint", "在 PDF 中选中文字，点击「翻译」"),
      "default",
      5000,
    );
  } catch (error) {
    toast(
      `${t("translate-error", "翻译失败")}：${friendlyMessage(error)}`,
      "fail",
    );
  }
}

function actionButton(
  doc: Document,
  iconName: string,
  label: string,
  onClick: () => void,
  extraClass = "",
): HTMLButtonElement {
  const button = htmlEl(doc, "button", {
    class: `pm-action pm-journal-action ${extraClass}`.trim(),
    attrs: { type: "button" },
    on: {
      click: (event: Event) => {
        event.preventDefault();
        onClick();
      },
    },
  });
  button.appendChild(zoteroIconImg(doc, iconName));
  button.appendChild(htmlEl(doc, "span", { text: label }));
  return button;
}

function buildActions(doc: Document, item: Zotero.Item): HTMLElement {
  const grid = htmlEl(doc, "div", {
    class: "pm-actions pm-journal-actions",
  });
  grid.appendChild(
    actionButton(doc, "abstract", t("action-summary", "AI 摘要"), () => {
      void runSummary(item);
    }),
  );
  grid.appendChild(
    actionButton(doc, "annotate-note", t("action-chat", "阅读对话"), () => {
      void runChat(item);
    }),
  );
  grid.appendChild(
    actionButton(doc, "page", t("action-ppt", "生成 PPT"), () => {
      void runPpt(item);
    }),
  );
  grid.appendChild(
    actionButton(doc, "refresh", t("action-refresh", "刷新信息"), () => {
      void refreshData(item);
    }),
  );
  grid.appendChild(
    actionButton(
      doc,
      "globe",
      t("action-translate", "划词翻译"),
      () => {
        void runTranslateEntry(item);
      },
      "pm-journal-action-wide",
    ),
  );
  return grid;
}

/* ------------------------------------------------------------------ */
/* Data loading                                                        */
/* ------------------------------------------------------------------ */

/** Force a refresh of the journal data used by the item-tree column. */
async function refreshData(item: Zotero.Item): Promise<void> {
  try {
    await getJournalRank(item, { force: true });
    refreshJournalColumn();
    toast(t("journal-refreshed", "已刷新期刊信息"), "success");
  } catch (error) {
    toast(
      `${t("journal-error", "获取期刊信息失败")}：${friendlyMessage(error)}`,
      "fail",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Section hooks                                                       */
/* ------------------------------------------------------------------ */

function renderSection(props: SectionArgs): void {
  const { doc, body, item, setEnabled, setSectionSummary } = props;
  const regular = resolveRegularItem(item);
  const applicable = Boolean(regular && isPaperItem(regular));
  try {
    setEnabled(applicable);
  } catch (error) {
    log("setEnabled failed:", errorToString(error));
  }
  clearChildren(body);
  try {
    setSectionSummary?.("");
  } catch {
    // ignore
  }
  if (!applicable || !regular) {
    body.dataset.pmItemId = "";
    return;
  }
  body.dataset.pmItemId = String(regular.id);
  const root = htmlEl(doc, "div", {
    class: "pm-root pm-journal-section",
  });
  root.appendChild(buildActions(doc, regular));
  body.appendChild(root);
}

function scheduleSelectionPrefetch(item: Zotero.Item | null | undefined): void {
  if (!item || !item.isRegularItem() || !isPaperItem(item)) return;
  if (selectionPrefetchTimer) clearTimeout(selectionPrefetchTimer);
  selectionPrefetchTimer = setTimeout(() => {
    selectionPrefetchTimer = null;
    const regular = resolveRegularItem(item);
    if (!regular) return;
    void prefetchJournalRanks([regular]);
  }, 500);
}

function registerNotifier(): void {
  if (notifierID) return;
  try {
    const observer = {
      notify: (
        event: string,
        type: string,
        ids: Array<number | string>,
      ): void => {
        if (type !== "item" || event !== "modify") return;
        if (!sectionBodies.size) return;
        const changed = new Set(ids.map((id) => Number(id)));
        for (const body of [...sectionBodies]) {
          const itemID = Number(body.dataset.pmItemId || 0);
          if (!itemID || !changed.has(itemID)) continue;
          const refresh = refreshByBody.get(body);
          if (!refresh) continue;
          void refresh().catch((error) => {
            log(
              "refresh section after item change failed:",
              errorToString(error),
            );
          });
        }
      },
    };
    notifierID = Zotero.Notifier.registerObserver(
      observer,
      ["item"],
      NOTIFIER_ID,
    );
  } catch (error) {
    log("register journal section notifier failed:", errorToString(error));
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export function registerJournalSection(): string | false {
  if (!getPref("journalShowSection")) return false;
  if (!getPref("journalEnabled")) {
    return false;
  }
  if (registeredKey) return registeredKey;
  try {
    const key = Zotero.ItemPaneManager.registerSection({
      paneID: JOURNAL_SECTION_ID,
      pluginID: config.addonID,
      header: {
        l10nID: "paperminer-section-head",
        icon: ICON_URL,
      },
      sidenav: {
        l10nID: "paperminer-section-sidenav",
        icon: SIDENAV_ICON_URL,
      },
      onInit: (props: InitArgs) => {
        sectionBodies.add(props.body);
        refreshByBody.set(props.body, props.refresh);
      },
      onDestroy: (props: { body: HTMLDivElement }) => {
        sectionBodies.delete(props.body);
        refreshByBody.delete(props.body);
      },
      onItemChange: (props: SectionArgs) => {
        try {
          props.setEnabled(isApplicable(props.item));
        } catch {
          // ignore
        }
        if (isApplicable(props.item)) {
          scheduleSelectionPrefetch(resolveRegularItem(props.item));
        }
      },
      onRender: (props: SectionArgs) => {
        renderSection(props);
      },
    });
    if (!key) {
      log("registerJournalSection returned false");
      return false;
    }
    registeredKey = key;
    registerNotifier();
    return key;
  } catch (error) {
    log("registerJournalSection failed:", errorToString(error));
    return false;
  }
}

export function unregisterJournalSection(): void {
  if (registeredKey) {
    try {
      Zotero.ItemPaneManager.unregisterSection(registeredKey);
    } catch (error) {
      log("unregisterJournalSection failed:", errorToString(error));
    }
  }
  registeredKey = null;
  sectionBodies.clear();
  if (notifierID) {
    try {
      Zotero.Notifier.unregisterObserver(notifierID);
    } catch (error) {
      log("unregister journal notifier failed:", errorToString(error));
    }
    notifierID = false;
  }
  if (selectionPrefetchTimer) {
    clearTimeout(selectionPrefetchTimer);
    selectionPrefetchTimer = null;
  }
}

/** Re-render every mounted PaperMiner section (called by preferences / menus). */
export function refreshJournalSection(): void {
  for (const body of [...sectionBodies]) {
    const refresh = refreshByBody.get(body);
    if (!refresh) continue;
    void refresh().catch((error) => {
      log("refreshJournalSection failed:", errorToString(error));
    });
  }
}
