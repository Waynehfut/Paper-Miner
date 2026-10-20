/**
 * Right-click menu inside the PDF reader view.
 *
 * The reader exposes a synchronous `createViewContextMenu` event. We add one
 * group for selection actions (when text is selected) and one group for paper
 * level AI actions, so all of PaperMiner's core features are reachable from a
 * right click while reading.
 */

import { config } from "../../../package.json";
import { generatePpt } from "../ai/ppt";
import { generateSummary, openSummaryNote } from "../ai/summary";
import { getJournalRank } from "../journal/service";
import { openTranslatePopover } from "../chat/translatePopover";
import {
  getPaperItemForReader,
  getSelectionAnchor,
  type ReaderLike,
  type SelectionAnchor,
} from "../chat/reader";
import { t } from "../../utils/i18n";
import { errorToString, log } from "../../utils/log";
import { showProgress, toast } from "../../utils/ui";
import { openChatPanel } from "./chatPanel";
import { refreshJournalSection } from "./journalSection";
import { refreshReaderBanner } from "./readerBanner";
import { refreshJournalColumn } from "./treeColumn";

const PLUGIN_ID = config.addonID;

interface ViewContextMenuEvent {
  reader?: ReaderLike;
  params?: { x?: number; y?: number };
  append?: (...items: Array<Record<string, unknown>>) => void;
}

let handler: ((event: unknown) => void) | null = null;
let registered = false;

function getPdfSelection(reader: ReaderLike): SelectionAnchor | null {
  const documents: Document[] = [];
  try {
    const pdfDoc = reader?._internalReader?._lastView?._iframeWindow?.document;
    if (pdfDoc) documents.push(pdfDoc);
  } catch {
    // dead wrapper
  }
  try {
    const readerDoc = reader?._iframeWindow?.document;
    if (readerDoc && !documents.includes(readerDoc)) {
      documents.push(readerDoc);
    }
  } catch {
    // dead wrapper
  }
  for (const doc of documents) {
    try {
      const anchor = getSelectionAnchor(doc);
      if (anchor) return anchor;
    } catch {
      // Ignore dead/inaccessible documents.
    }
  }
  return null;
}

function runSummary(item: Zotero.Item): void {
  const progress = showProgress(
    t("summary-title", "AI 阅读摘要"),
    t("summary-generating", "正在生成 AI 摘要…"),
    5,
  );
  void generateSummary(item, {
    onProgress: (message, value) => progress.update(message, value),
  })
    .then(() => {
      progress.close(1200);
      toast(t("summary-done", "AI 摘要已保存为子笔记"), "success");
      openSummaryNote(item);
    })
    .catch((error: unknown) => {
      progress.close(0);
      toast(
        `${t("summary-failed", "生成 AI 摘要失败")}：${errorToString(error)}`,
        "fail",
      );
    });
}

function runPpt(item: Zotero.Item): void {
  const progress = showProgress(
    t("ppt-title", "生成汇报 PPT"),
    t("ppt-extracting", "正在提取论文正文…"),
    2,
  );
  void generatePpt(item, {
    onProgress: (message, value) => progress.update(message, value),
  })
    .then(() => {
      progress.close(1500);
      toast(t("ppt-done", "PPT 已生成"), "success");
    })
    .catch((error: unknown) => {
      progress.close(0);
      toast(
        `${t("ppt-failed", "生成 PPT 失败")}：${errorToString(error)}`,
        "fail",
      );
    });
}

function refreshInfo(item: Zotero.Item): void {
  const progress = showProgress(
    t("menu-refresh-info", "刷新期刊信息"),
    t("journal-loading", "正在查询期刊信息…"),
    5,
  );
  void getJournalRank(item, { force: true })
    .then((journal) => {
      progress.close(1200);
      const parts: string[] = [];
      if (journal?.status === "ok") {
        parts.push(journal.shortText || t("journal-title", "期刊信息"));
      } else if (journal?.status === "notfound") {
        parts.push(t("journal-notfound", "EasyScholar 未收录该期刊"));
      }
      toast(parts.join(" · ") || t("journal-empty", "无期刊信息"), "success");
      refreshJournalSection();
      refreshJournalColumn();
      refreshReaderBanner();
    })
    .catch((error: unknown) => {
      progress.close(0);
      toast(
        `${t("journal-error", "获取期刊信息失败")}：${errorToString(error)}`,
        "fail",
      );
    });
}

function handleViewContextMenu(rawEvent: unknown): void {
  const event = rawEvent as ViewContextMenuEvent;
  const reader = event?.reader;
  if (!reader || typeof event.append !== "function") return;
  try {
    const item = getPaperItemForReader(reader);
    if (!item) return;

    const selection = getPdfSelection(reader);
    if (selection) {
      const selectionDoc = selection.doc;
      const selectionRect = selection.rect;
      const selectionText = selection.text;
      event.append(
        {
          label: t("reader-menu-translate", "PaperMiner：翻译选中文字"),
          onCommand: () => {
            try {
              openTranslatePopover({
                doc: selectionDoc,
                text: selectionText,
                anchor: selectionRect,
                onAskAI: () => {
                  void openChatPanel(item, { quotedText: selectionText });
                },
              });
            } catch (error) {
              log("reader menu translate failed:", errorToString(error));
            }
          },
        },
        {
          label: t("reader-menu-ask", "PaperMiner：就选中文字提问"),
          onCommand: () => {
            void openChatPanel(item, { quotedText: selectionText });
          },
        },
      );
    }

    event.append(
      {
        label: t("reader-menu-summary", "PaperMiner：生成 AI 阅读摘要"),
        onCommand: () => runSummary(item),
      },
      {
        label: t("reader-menu-ppt", "PaperMiner：生成汇报 PPT"),
        onCommand: () => runPpt(item),
      },
      {
        label: t("reader-menu-chat", "PaperMiner：打开阅读对话"),
        onCommand: () => {
          void openChatPanel(item);
        },
      },
      {
        label: t("reader-menu-refresh", "PaperMiner：刷新期刊信息"),
        onCommand: () => refreshInfo(item),
      },
    );
  } catch (error) {
    log("reader view context menu failed:", errorToString(error));
  }
}

export function registerReaderContextMenu(): void {
  if (registered) return;
  try {
    handler = handleViewContextMenu;
    Zotero.Reader.registerEventListener(
      "createViewContextMenu",
      handler as never,
      PLUGIN_ID,
    );
    registered = true;
  } catch (error) {
    handler = null;
    log("register createViewContextMenu failed:", errorToString(error));
  }
}

export function unregisterReaderContextMenu(): void {
  if (!registered || !handler) return;
  try {
    Zotero.Reader.unregisterEventListener(
      "createViewContextMenu",
      handler as never,
    );
  } catch (error) {
    log("unregister createViewContextMenu failed:", errorToString(error));
  }
  registered = false;
  handler = null;
}
