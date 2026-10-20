import { isLLMConfigured } from "../ai/config";
import { generatePpt } from "../ai/ppt";
import { generateSummary } from "../ai/summary";
import { getJournalRank } from "../journal/service";
import {
  findPDFAttachment,
  getRegularItemForReader,
  isPaperItem,
} from "../../utils/item";
import { t } from "../../utils/i18n";
import { errorToString, log } from "../../utils/log";
import { getPref } from "../../utils/prefs";
import { showProgress, toast } from "../../utils/ui";
import { openChatPanel } from "./chatPanel";
import { refreshJournalSection } from "./journalSection";
import { refreshReaderBanner } from "./readerBanner";
import { refreshJournalColumn } from "./treeColumn";

/** Right-click menus. Owned by the journal UI module. */

const MENU_ID = "paperminer-itemmenu";
const MAX_SELECTION = 10;

interface DocState {
  menu: Element;
  onPopupShowing: () => void;
  items: Element[];
}

const docStates = new Map<Document, DocState>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryCount = 0;
const MAX_RETRIES = 8;

function selectedPaperItems(): Zotero.Item[] {
  try {
    const pane = Zotero.getActiveZoteroPane();
    const selected = pane?.getSelectedItems?.() || [];
    const papers = new Map<number, Zotero.Item>();
    for (const selectedItem of selected) {
      if (!selectedItem) continue;
      const paper = selectedItem.isRegularItem()
        ? selectedItem
        : selectedItem.isAttachment()
          ? getRegularItemForReader(selectedItem)
          : null;
      if (paper && isPaperItem(paper)) {
        papers.set(paper.id, paper);
      }
    }
    return [...papers.values()];
  } catch (error) {
    log("read selection failed:", errorToString(error));
    return [];
  }
}

function itemTitle(item: Zotero.Item): string {
  try {
    return String(item.getField("title") || "").slice(0, 40);
  } catch {
    return "";
  }
}

function toastResult(text: string, failed = false): void {
  toast(text, failed ? "fail" : "success");
}

async function updateJournalInfo(items: Zotero.Item[]): Promise<void> {
  if (!getPref("journalEnabled")) {
    toast(t("journal-disabled", "期刊分区功能未启用"), "fail");
    return;
  }
  const progress = showProgress(
    t("menu-update-journal", "更新期刊信息"),
    t("journal-loading", "正在查询期刊信息…"),
    1,
  );
  let ok = 0;
  let notFound = 0;
  let failed = 0;
  try {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      progress.update(
        itemTitle(item) || `(${index + 1}/${items.length})`,
        Math.round((index / items.length) * 100),
      );
      const result = await getJournalRank(item, { force: true });
      if (result.status === "ok") ok += 1;
      else if (result.status === "notfound") notFound += 1;
      else if (result.status === "error") failed += 1;
    }
    progress.close(1500);
    refreshJournalColumn();
    refreshJournalSection();
    refreshReaderBanner();
    const parts = [
      `${t("menu-updated", "已更新")} ${ok}`,
      notFound ? `${t("journal-notfound-short", "未收录")} ${notFound}` : "",
      failed ? `${t("menu-failed", "失败")} ${failed}` : "",
    ].filter(Boolean);
    toastResult(parts.join(" · "), failed > 0 && ok === 0);
  } catch (error) {
    progress.close(0);
    toastResult(
      `${t("journal-error", "获取期刊信息失败")}：${errorToString(error)}`,
      true,
    );
  }
}

async function runSummaries(items: Zotero.Item[]): Promise<void> {
  if (!isLLMConfigured("summary")) {
    toast(t("chat-not-configured", "尚未配置 AI 服务，点击前往设置"), "fail");
    return;
  }
  const progress = showProgress(
    t("summary-title", "AI 阅读摘要"),
    t("summary-generating", "正在生成 AI 摘要…"),
    2,
  );
  let done = 0;
  let failed = 0;
  try {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      progress.update(
        itemTitle(item) || `(${index + 1}/${items.length})`,
        Math.round((index / items.length) * 100),
      );
      try {
        await generateSummary(item);
        done += 1;
      } catch (error) {
        failed += 1;
        log("summary failed for item:", item.id, errorToString(error));
      }
    }
    progress.close(1500);
    toastResult(
      failed
        ? `${t("summary-failed", "生成 AI 摘要失败")} ${failed}/${items.length}`
        : `${t("summary-done", "AI 摘要已保存为子笔记")} ${done}`,
      failed > 0 && done === 0,
    );
  } catch (error) {
    progress.close(0);
    toastResult(
      `${t("summary-failed", "生成 AI 摘要失败")}：${errorToString(error)}`,
      true,
    );
  }
}

async function runPpts(items: Zotero.Item[]): Promise<void> {
  if (!isLLMConfigured("ppt")) {
    toast(t("chat-not-configured", "尚未配置 AI 服务，点击前往设置"), "fail");
    return;
  }
  const progress = showProgress(
    t("ppt-title", "生成汇报 PPT"),
    t("ppt-extracting", "正在提取论文正文…"),
    2,
  );
  let done = 0;
  let failed = 0;
  try {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      progress.update(
        itemTitle(item) || `(${index + 1}/${items.length})`,
        Math.round((index / items.length) * 100),
      );
      try {
        await generatePpt(item);
        done += 1;
      } catch (error) {
        failed += 1;
        log("ppt failed for item:", item.id, errorToString(error));
      }
    }
    progress.close(1800);
    toastResult(
      failed
        ? `${t("ppt-failed", "生成 PPT 失败")} ${failed}/${items.length}`
        : `${t("ppt-done", "PPT 已生成")} ${done}`,
      failed > 0 && done === 0,
    );
  } catch (error) {
    progress.close(0);
    toastResult(
      `${t("ppt-failed", "生成 PPT 失败")}：${errorToString(error)}`,
      true,
    );
  }
}

async function openChat(items: Zotero.Item[]): Promise<void> {
  try {
    await openChatPanel(items[0]);
  } catch (error) {
    toast(`${t("chat-error", "对话失败")}：${errorToString(error)}`, "fail");
  }
}

async function openTranslationEntry(items: Zotero.Item[]): Promise<void> {
  const item = items[0];
  if (!item) return;
  const attachment = await findPDFAttachment(item);
  if (!attachment) {
    toastResult(t("menu-no-pdf", "该条目没有 PDF 附件"), true);
    return;
  }
  try {
    await Zotero.Reader.open(attachment.id);
    toastResult(t("menu-translate-hint", "在 PDF 中选中文字，点击「翻译」"));
  } catch (error) {
    toastResult(
      `${t("chat-open-failed", "打开阅读器失败")}：${errorToString(error)}`,
      true,
    );
  }
}

async function openSettings(): Promise<void> {
  try {
    Zotero.Utilities.Internal.openPreferences("paperminer-preference-pane");
  } catch (error) {
    log("open preferences failed:", errorToString(error));
    toastResult(t("menu-settings-failed", "无法打开设置"), true);
  }
}

interface MenuAction {
  id: string;
  label: string;
  run: (items: Zotero.Item[]) => Promise<void>;
  /** Draw a separator before this item. */
  separatorBefore?: boolean;
}

function menuActions(): MenuAction[] {
  return [
    {
      id: "update-journal",
      label: t("menu-update-journal", "更新期刊分区信息"),
      run: updateJournalInfo,
    },
    {
      id: "ai-summary",
      label: t("menu-ai-summary", "生成 AI 阅读摘要"),
      run: runSummaries,
      separatorBefore: true,
    },
    {
      id: "ai-ppt",
      label: t("menu-ai-ppt", "生成汇报 PPT"),
      run: runPpts,
    },
    {
      id: "chat",
      label: t("menu-chat", "与论文对话"),
      run: openChat,
    },
    {
      id: "translate",
      label: t("menu-translate", "划词翻译"),
      run: openTranslationEntry,
      separatorBefore: true,
    },
    {
      id: "settings",
      label: t("menu-settings", "PaperMiner 设置"),
      run: () => Promise.resolve(openSettings()),
    },
  ];
}

function createXUL(doc: Document, tag: string): XULElement {
  return doc.createXULElement(tag) as XULElement;
}

function ensureMenu(doc: Document): boolean {
  if (docStates.has(doc)) return true;
  if (doc.getElementById(MENU_ID)) return true;
  const itemMenu = doc.getElementById("zotero-itemmenu");
  if (!itemMenu) return false;

  const menu = createXUL(doc, "menu") as XULElement;
  menu.id = MENU_ID;
  menu.setAttribute("label", "PaperMiner");
  menu.setAttribute("class", "menu-iconic");
  const popup = createXUL(doc, "menupopup") as XULElement;
  popup.id = `${MENU_ID}-popup`;
  menu.appendChild(popup);

  const items: Element[] = [];
  for (const action of menuActions()) {
    if (action.separatorBefore) {
      popup.appendChild(createXUL(doc, "menuseparator"));
    }
    const menuitem = createXUL(doc, "menuitem") as XULElement;
    menuitem.id = `${MENU_ID}-${action.id}`;
    menuitem.setAttribute("label", action.label);
    menuitem.addEventListener("command", () => {
      const selected = selectedPaperItems();
      if (!selected.length) return;
      if (selected.length > MAX_SELECTION) {
        toast(
          t("menu-too-many", `一次最多处理 ${MAX_SELECTION} 个条目`),
          "fail",
        );
        return;
      }
      void action.run(selected).catch((error: unknown) => {
        log("context menu action failed:", action.id, errorToString(error));
      });
    });
    items.push(menuitem);
    popup.appendChild(menuitem);
  }

  itemMenu.appendChild(menu);

  const onPopupShowing = (): void => {
    const selected = selectedPaperItems();
    const visible = selected.length > 0;
    if (visible) menu.removeAttribute("hidden");
    else menu.setAttribute("hidden", "true");
    const disabled = !visible || selected.length > MAX_SELECTION;
    for (const menuitem of items) {
      if (disabled) menuitem.setAttribute("disabled", "true");
      else menuitem.removeAttribute("disabled");
    }
  };
  itemMenu.addEventListener("popupshowing", onPopupShowing);

  docStates.set(doc, { menu, onPopupShowing, items });
  return true;
}

function teardownMenu(doc: Document): void {
  const state = docStates.get(doc);
  if (!state) return;
  try {
    const itemMenu = doc.getElementById("zotero-itemmenu");
    itemMenu?.removeEventListener("popupshowing", state.onPopupShowing);
    state.menu.remove();
  } catch (error) {
    log("teardown context menu failed:", errorToString(error));
  }
  docStates.delete(doc);
}

function mainWindowDocuments(): Document[] {
  const docs: Document[] = [];
  try {
    const windows = Zotero.getMainWindows?.() || [];
    for (const win of windows) {
      if (win && !win.closed && win.document) docs.push(win.document);
    }
    const mainWin = Zotero.getMainWindow();
    if (mainWin?.document && !docs.includes(mainWin.document)) {
      docs.push(mainWin.document);
    }
  } catch (error) {
    log("list main windows failed:", errorToString(error));
  }
  return docs;
}

function installMenus(): boolean {
  let allInstalled = true;
  for (const doc of mainWindowDocuments()) {
    try {
      if (!ensureMenu(doc)) allInstalled = false;
    } catch (error) {
      allInstalled = false;
      log("register context menu failed:", errorToString(error));
    }
  }
  return allInstalled;
}

export function registerContextMenus(): void {
  try {
    const installed = installMenus();
    if (!installed && retryCount < MAX_RETRIES) {
      // #zotero-itemmenu can be missing while the main window is still
      // restoring tabs at startup; retry briefly instead of giving up.
      retryCount += 1;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        registerContextMenus();
      }, 500);
    }
  } catch (error) {
    log("registerContextMenus failed:", errorToString(error));
  }
}

export function unregisterContextMenus(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryCount = 0;
  for (const doc of [...docStates.keys()]) {
    teardownMenu(doc);
  }
}
