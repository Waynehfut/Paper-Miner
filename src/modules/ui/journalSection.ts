import { config } from "../../../package.json";
import type { JournalResult, RetractionResult } from "../../types";
import { isLLMConfigured } from "../ai/config";
import { generatePpt } from "../ai/ppt";
import { generateSummary, openSummaryNote } from "../ai/summary";
import {
  prefetchJournalRanks,
  getCachedJournalRank,
  getJournalRank,
} from "../journal/service";
import {
  iconButton,
  htmlEl,
  loadingRow,
  statusText,
  zoteroIconImg,
} from "../journal/dom";
import {
  prefetchRetractions,
  getCachedRetractionStatus,
  getRetractionStatus,
} from "../retraction/service";
import { clearChildren } from "../../utils/html";
import { t } from "../../utils/i18n";
import {
  findPDFAttachment,
  getItemDOI,
  getItemPublication,
  getRegularItemForReader,
  isPaperItem,
} from "../../utils/item";
import { errorToString, log } from "../../utils/log";
import { getPref } from "../../utils/prefs";
import { openURL, showProgress, toast } from "../../utils/ui";
import { openChatPanel } from "./chatPanel";
import { refreshJournalColumn } from "./treeColumn";

/**
 * Item pane section: journal badges, retraction status and AI action buttons.
 * Owned by the journal/retraction UI module.
 */

export const JOURNAL_SECTION_ID = "paperminer-journal";

const ICON_URL = "chrome://zotero/skin/itempane/16/info.svg";
const SIDENAV_ICON_URL = "chrome://zotero/skin/itempane/20/info.svg";
const NOTIFIER_ID = "paperminer-journal-section";

type SectionArgs = _ZoteroTypes.ItemPaneManagerSection.SectionHookArgs;
type InitArgs = _ZoteroTypes.ItemPaneManagerSection.SectionInitHookArgs;

let registeredKey: string | false | null = null;
let notifierID: string | false = false;
const sectionBodies = new Set<HTMLDivElement>();
const refreshByBody = new WeakMap<HTMLDivElement, () => Promise<void>>();
const tokens = new WeakMap<HTMLDivElement, number>();
let selectionPrefetchTimer: ReturnType<typeof setTimeout> | null = null;

function resolveRegularItem(item: Zotero.Item | null | undefined) {
  return getRegularItemForReader(item);
}

function isApplicable(item: Zotero.Item | null | undefined): boolean {
  const regular = resolveRegularItem(item);
  return Boolean(regular && isPaperItem(regular));
}

function bumpToken(body: HTMLDivElement): number {
  const next = (tokens.get(body) || 0) + 1;
  tokens.set(body, next);
  return next;
}

function currentToken(body: HTMLDivElement): number {
  return tokens.get(body) || 0;
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

function buildActions(
  doc: Document,
  item: Zotero.Item,
  body: HTMLDivElement,
): HTMLElement {
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
      void refreshData(doc, body, item);
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

async function loadJournal(
  item: Zotero.Item,
  force = false,
): Promise<JournalResult | null> {
  if (!getPref("journalEnabled")) return null;
  try {
    return await getJournalRank(item, force ? { force: true } : {});
  } catch (error) {
    log("loadJournal failed:", errorToString(error));
    return {
      status: "error",
      publication: "",
      badges: [],
      warning: false,
      shortText: "",
      fetchedAt: 0,
      error: t("journal-error", "获取期刊信息失败"),
    };
  }
}

async function loadRetraction(
  item: Zotero.Item,
  force = false,
): Promise<RetractionResult | null> {
  if (!getPref("retractionEnabled")) return null;
  try {
    return await getRetractionStatus(item, force ? { force: true } : {});
  } catch (error) {
    log("loadRetraction failed:", errorToString(error));
    return {
      status: "error",
      sources: [],
      retracted: false,
      checkedAt: 0,
      error: t("retraction-error", "撤稿检测失败，请稍后重试"),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function blockHeader(
  doc: Document,
  title: string,
  onRefresh: () => void,
): HTMLElement {
  const row = htmlEl(doc, "div", { class: "pm-row pm-journal-block-head" });
  row.appendChild(
    htmlEl(doc, "span", { class: "pm-section-title", text: title }),
  );
  row.appendChild(htmlEl(doc, "span", { class: "pm-spacer" }));
  row.appendChild(
    iconButton(doc, "refresh", {
      title: t("refresh", "刷新"),
      className: "pm-journal-refresh",
      onClick: onRefresh,
    }),
  );
  return row;
}

function linkButton(
  doc: Document,
  label: string,
  url: string,
): HTMLButtonElement {
  return htmlEl(doc, "button", {
    class: "pm-link pm-journal-link-btn",
    text: label,
    attrs: { type: "button" },
    on: {
      click: (event: Event) => {
        event.preventDefault();
        openURL(url);
      },
    },
  });
}

const SOURCE_LABELS: Record<string, string> = {
  zotero: "Zotero",
  openalex: "OpenAlex",
  crossref: "Crossref",
};

function sourcesText(sources: string[]): string {
  if (!sources || !sources.length) return "";
  const labels = sources.map((source) => SOURCE_LABELS[source] || source);
  return `${t("retraction-sources", "来源")}：${labels.join(" / ")}`;
}

function renderJournalBlock(
  doc: Document,
  container: HTMLElement,
  result: JournalResult | null,
  item: Zotero.Item,
  body: HTMLDivElement,
): void {
  clearChildren(container);
  container.appendChild(
    blockHeader(doc, t("journal-title", "期刊信息"), () => {
      void refreshData(doc, body, item);
    }),
  );
  if (!result) {
    container.appendChild(statusText(doc, t("journal-empty", "无期刊信息")));
    return;
  }
  switch (result.status) {
    case "ok": {
      const badges = htmlEl(doc, "div", {
        class: "pm-journal-badges",
      });
      const categoryLabels: Record<string, string> = {
        quartile: t("journal-cat-quartile", "分区"),
        metric: t("journal-cat-metric", "指标"),
        cn: t("journal-cat-cn", "中文核心"),
        index: t("journal-cat-index", "索引"),
        ranking: t("journal-cat-ranking", "榜单"),
        warning: t("journal-cat-warning", "预警"),
      };
      let currentCategory = "";
      let group: HTMLElement | null = null;
      for (const badge of result.badges) {
        if (badge.category !== currentCategory) {
          currentCategory = badge.category;
          group = htmlEl(doc, "div", {
            class: `pm-journal-badge-group pm-journal-badge-group-${badge.category}`,
          });
          group.appendChild(
            htmlEl(doc, "span", {
              class: "pm-journal-group-label",
              text: categoryLabels[badge.category] || "",
            }),
          );
          badges.appendChild(group);
        }
        const pill = htmlEl(doc, "span", {
          class: `pm-journal-badge pm-journal-badge-${badge.category}`,
          title: `${badge.label}: ${badge.value}`,
        });
        pill.appendChild(
          htmlEl(doc, "span", {
            class:
              badge.value === "收录"
                ? "pm-journal-badge-cat pm-journal-badge-solo"
                : "pm-journal-badge-cat",
            text: badge.shortLabel,
          }),
        );
        if (badge.value !== "收录") {
          pill.appendChild(
            htmlEl(doc, "span", {
              class: "pm-journal-badge-val",
              text: badge.value,
            }),
          );
        }
        group!.appendChild(pill);
      }
      if (!result.badges.length) {
        badges.appendChild(
          htmlEl(doc, "span", {
            class: "pm-muted",
            text: t("journal-empty", "无期刊信息"),
          }),
        );
      }
      container.appendChild(badges);
      if (result.warning) {
        const banner = htmlEl(doc, "div", {
          class: "pm-banner pm-banner-warning pm-journal-warning-banner",
        });
        banner.appendChild(zoteroIconImg(doc, "retracted"));
        banner.appendChild(
          htmlEl(doc, "span", {
            class: "pm-banner-title",
            text: t("journal-warning", "中科院预警期刊"),
          }),
        );
        container.appendChild(banner);
      }
      if (result.publication) {
        container.appendChild(
          htmlEl(doc, "div", {
            class: "pm-muted pm-journal-publication",
            text: result.publication,
            title: result.publication,
          }),
        );
      }
      break;
    }
    case "unconfigured":
      container.appendChild(
        statusText(
          doc,
          result.error ||
            t(
              "journal-unconfigured",
              "尚未配置 EasyScholar 密钥，点击前往设置",
            ),
          {
            tone: "warn",
            actionLabel: t("action-settings", "打开设置"),
            onAction: openPreferences,
          },
        ),
      );
      break;
    case "notfound":
      container.appendChild(
        statusText(
          doc,
          result.error || t("journal-notfound", "EasyScholar 未收录该期刊"),
          {
            actionLabel: t("retry", "重试"),
            onAction: () => {
              void refreshData(doc, body, item);
            },
          },
        ),
      );
      break;
    case "error":
      container.appendChild(
        statusText(
          doc,
          `${t("journal-error", "获取期刊信息失败")}：${result.error || ""}`,
          {
            tone: "danger",
            actionLabel: t("retry", "重试"),
            onAction: () => {
              void refreshData(doc, body, item);
            },
          },
        ),
      );
      break;
    default:
      container.appendChild(
        loadingRow(doc, t("journal-loading", "正在查询期刊信息…")),
      );
      break;
  }
}

function renderRetractionBlock(
  doc: Document,
  container: HTMLElement,
  result: RetractionResult | null,
  item: Zotero.Item,
  body: HTMLDivElement,
): void {
  clearChildren(container);
  container.appendChild(
    blockHeader(doc, t("retraction-title", "撤稿检测"), () => {
      void refreshData(doc, body, item);
    }),
  );
  if (!result) {
    container.appendChild(
      statusText(doc, t("retraction-unknown", "暂未获取到撤稿数据")),
    );
    return;
  }
  switch (result.status) {
    case "retracted": {
      const banner = htmlEl(doc, "div", {
        class: "pm-banner pm-banner-retracted pm-journal-retracted",
      });
      banner.appendChild(zoteroIconImg(doc, "retracted"));
      const content = htmlEl(doc, "div", {
        class: "pm-col pm-journal-banner-content",
      });
      content.appendChild(
        htmlEl(doc, "div", {
          class: "pm-banner-title",
          text: t("retraction-retracted", "该论文已被撤稿"),
        }),
      );
      if (result.date) {
        content.appendChild(
          htmlEl(doc, "div", {
            class: "pm-journal-line",
            text: `${t("retraction-date", "撤稿日期")}：${result.date}`,
          }),
        );
      }
      if (result.reason) {
        content.appendChild(
          htmlEl(doc, "div", {
            class: "pm-journal-line",
            text: `${t("retraction-reason", "撤稿原因")}：${result.reason}`,
          }),
        );
      }
      if (result.details && result.details !== result.reason) {
        content.appendChild(
          htmlEl(doc, "div", {
            class: "pm-muted pm-journal-details",
            text: result.details,
          }),
        );
      }
      if (result.noticeDOI) {
        content.appendChild(
          linkButton(
            doc,
            t("retraction-notice", "查看撤稿声明"),
            `https://doi.org/${result.noticeDOI}`,
          ),
        );
      }
      const sources = sourcesText(result.sources);
      if (sources) {
        content.appendChild(
          htmlEl(doc, "div", {
            class: "pm-muted pm-journal-sources",
            text: sources,
          }),
        );
      }
      banner.appendChild(content);
      container.appendChild(banner);
      break;
    }
    case "clear": {
      const row = statusText(
        doc,
        `✓ ${t("retraction-clear", "未发现撤稿记录")}`,
      );
      row.classList.add("pm-journal-clear");
      container.appendChild(row);
      const sources = sourcesText(result.sources);
      if (sources) {
        container.appendChild(
          htmlEl(doc, "div", {
            class: "pm-muted pm-journal-sources",
            text: sources,
          }),
        );
      }
      break;
    }
    case "no-doi":
      container.appendChild(
        statusText(
          doc,
          result.error ||
            t("journal-no-doi", "该条目没有 DOI，无法进行撤稿检测"),
        ),
      );
      break;
    case "error":
      container.appendChild(
        statusText(
          doc,
          `${t("retraction-error", "撤稿检测失败")}：${result.error || ""}`,
          {
            tone: "danger",
            actionLabel: t("retry", "重试"),
            onAction: () => {
              void refreshData(doc, body, item);
            },
          },
        ),
      );
      break;
    case "idle":
    case "loading":
      container.appendChild(
        loadingRow(doc, t("retraction-checking", "正在检测撤稿…")),
      );
      break;
    default:
      container.appendChild(
        statusText(doc, t("retraction-unknown", "暂未获取到撤稿数据")),
      );
      break;
  }
}

/** Force a refresh of both blocks for the given item (refresh button / retry). */
async function refreshData(
  doc: Document,
  body: HTMLDivElement,
  item: Zotero.Item,
): Promise<void> {
  const journalBlock = body.querySelector(
    '[data-pm-role="journal"]',
  ) as HTMLElement | null;
  const retractionBlock = body.querySelector(
    '[data-pm-role="retraction"]',
  ) as HTMLElement | null;
  const token = currentToken(body);
  if (journalBlock) {
    clearChildren(journalBlock);
    journalBlock.appendChild(
      loadingRow(doc, t("journal-loading", "正在查询期刊信息…")),
    );
  }
  if (retractionBlock) {
    clearChildren(retractionBlock);
    retractionBlock.appendChild(
      loadingRow(doc, t("retraction-checking", "正在检测撤稿…")),
    );
  }
  const [journal, retraction] = await Promise.all([
    loadJournal(item, true),
    loadRetraction(item, true),
  ]);
  if (token !== currentToken(body) || !body.isConnected) return;
  if (journalBlock) {
    renderJournalBlock(doc, journalBlock, journal, item, body);
  }
  if (retractionBlock) {
    renderRetractionBlock(doc, retractionBlock, retraction, item, body);
  }
  refreshJournalColumn();
  toast(t("journal-refreshed", "已刷新期刊与撤稿信息"), "success");
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
  bumpToken(body);
  clearChildren(body);
  try {
    setSectionSummary("");
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
  body.appendChild(root);

  const journalBlock = htmlEl(doc, "div", {
    class: "pm-journal-block pm-journal-journal",
    dataset: { pmRole: "journal" },
  });
  journalBlock.appendChild(
    loadingRow(doc, t("journal-loading", "正在查询期刊信息…")),
  );
  root.appendChild(journalBlock);

  const retractionBlock = htmlEl(doc, "div", {
    class: "pm-journal-block pm-journal-retraction-block",
    dataset: { pmRole: "retraction" },
  });
  retractionBlock.appendChild(
    loadingRow(doc, t("retraction-checking", "正在检测撤稿…")),
  );
  root.appendChild(retractionBlock);

  root.appendChild(htmlEl(doc, "hr", { class: "pm-divider" }));
  root.appendChild(buildActions(doc, regular, body));

  // Render cached data immediately and also start the async load here instead
  // of waiting for onAsyncRender. Zotero only invokes onAsyncRender when the
  // section is open, so a collapsed section would otherwise stay in its
  // loading state forever.
  const cachedJournal = getCachedJournalRank(getItemPublication(regular));
  if (cachedJournal) {
    renderJournalBlock(doc, journalBlock, cachedJournal, regular, body);
  }
  const cachedRetraction = getCachedRetractionStatus(getItemDOI(regular));
  if (cachedRetraction) {
    renderRetractionBlock(
      doc,
      retractionBlock,
      cachedRetraction,
      regular,
      body,
    );
  }
  void refreshSectionData(doc, body, regular, setSectionSummary);
}

async function refreshSectionData(
  doc: Document,
  body: HTMLDivElement,
  regular: Zotero.Item,
  setSectionSummary?: (summary: string) => void,
): Promise<void> {
  const token = currentToken(body);
  const journalBlock = body.querySelector(
    '[data-pm-role="journal"]',
  ) as HTMLElement | null;
  const retractionBlock = body.querySelector(
    '[data-pm-role="retraction"]',
  ) as HTMLElement | null;
  if (!journalBlock && !retractionBlock) return;
  const [journal, retraction] = await Promise.all([
    loadJournal(regular),
    loadRetraction(regular),
  ]);
  if (token !== currentToken(body) || !body.isConnected) return;
  if (journalBlock) {
    renderJournalBlock(doc, journalBlock, journal, regular, body);
  }
  if (retractionBlock) {
    renderRetractionBlock(doc, retractionBlock, retraction, regular, body);
  }
  const summary: string[] = [];
  if (retraction && retraction.status === "retracted") {
    summary.push(t("retraction-retracted", "该论文已被撤稿"));
  }
  if (journal && journal.status === "ok" && journal.shortText) {
    summary.push(journal.shortText);
  }
  try {
    setSectionSummary?.(summary.join(" · "));
  } catch {
    // ignore
  }
}

async function renderSectionAsync(props: SectionArgs): Promise<void> {
  const { doc, body, item, setSectionSummary } = props;
  const regular = resolveRegularItem(item);
  if (!regular || !isPaperItem(regular)) return;
  await refreshSectionData(doc, body, regular, setSectionSummary);
}

function scheduleSelectionPrefetch(item: Zotero.Item | null | undefined): void {
  if (!item || !item.isRegularItem() || !isPaperItem(item)) return;
  if (selectionPrefetchTimer) clearTimeout(selectionPrefetchTimer);
  selectionPrefetchTimer = setTimeout(() => {
    selectionPrefetchTimer = null;
    const regular = resolveRegularItem(item);
    if (!regular) return;
    void prefetchJournalRanks([regular]);
    void prefetchRetractions([regular]);
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
  if (!getPref("journalEnabled") && !getPref("retractionEnabled")) {
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
        tokens.delete(props.body);
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
      onAsyncRender: (props: SectionArgs) => renderSectionAsync(props),
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
