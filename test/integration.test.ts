/* eslint-disable mocha/max-top-level-suites, mocha/consistent-spacing-between-blocks */
import { assert } from "chai";
import { config } from "../package.json";
import { getPaperText, getPaperContext } from "../src/modules/ai/paperText";
import { getRetractionStatus } from "../src/modules/retraction/service";
import { getJournalRank } from "../src/modules/journal/service";

function fixturePath(): string {
  const cwd = Services.dirsvc.get("CurWorkD", Ci.nsIFile).path;
  const pathUtils = (globalThis as any).PathUtils;
  return pathUtils?.join
    ? pathUtils.join(cwd, "test", "fixtures", "sample-paper.pdf")
    : `${cwd}/test/fixtures/sample-paper.pdf`;
}

const FIXTURE = fixturePath();

async function createTestPaper(): Promise<{
  item: Zotero.Item;
  attachment: Zotero.Item;
}> {
  const item = new Zotero.Item("journalArticle");
  item.libraryID = Zotero.Libraries.userLibraryID;
  item.setField("title", "PaperMiner Sample Paper");
  item.setField("DOI", "10.1016/S0140-6736(20)31180-6");
  item.setField("publicationTitle", "The Lancet");
  item.setField(
    "abstractNote",
    "A sample paper about AI-assisted reading comprehension with 120 participants.",
  );
  item.setField("date", "2024-01-01");
  await item.saveTx();
  const attachment = await Zotero.Attachments.importFromFile({
    file: FIXTURE,
    parentItemID: item.id,
    title: "Full Text PDF",
  });
  return { item, attachment };
}

describe("PaperMiner integration", function () {
  this.timeout(90000);
  let item: Zotero.Item;
  let attachment: Zotero.Item;

  before(async function () {
    const created = await createTestPaper();
    item = created.item;
    attachment = created.attachment;
  });

  after(async function () {
    if (item) {
      await item.eraseTx();
    }
  });

  it("extracts text from the PDF", async function () {
    const result = await getPaperText(item);
    assert.isAbove(result.text.length, 200);
    assert.include(result.text.toLowerCase(), "ai-assisted reading");
    const context = await getPaperContext(item, { maxChars: 5000 });
    assert.equal(context.itemID, item.id);
    assert.isAbove(context.text.length, 200);
    assert.isTrue(context.truncated || context.text.length <= 5000);
  });

  it("returns unconfigured journal status without a key", async function () {
    const result = await getJournalRank(item);
    assert.equal(result.status, "unconfigured");
    assert.isNotEmpty(result.error || "");
  });

  it("reports an invalid EasyScholar key as an actionable config error", async function () {
    const { getPref, setPref } = await import("../src/utils/prefs");
    const backup = getPref("journalSecretKey");
    setPref("journalSecretKey", "invalid-test-key" as never);
    try {
      const result = await getJournalRank(item, { force: true });
      assert.equal(result.status, "unconfigured");
      assert.include(String(result.error || ""), "密钥");
    } finally {
      setPref("journalSecretKey", backup as never);
    }
  });

  it("detects a known retracted DOI", async function () {
    const result = await getRetractionStatus(item);
    assert.isTrue(result.retracted, `expected retracted, got ${result.status}`);
    assert.include(result.sources, "openalex");
  });

  it("renders the item pane section for a selected paper", async function () {
    const pane = Zotero.getActiveZoteroPane();
    pane.selectItem(item.id);
    await Zotero.Promise.delay(3500);
    const doc = Zotero.getMainWindow().document;
    const section = doc.querySelector(
      '[data-pane$="paperminer-journal"], [data-pane="paperminer-journal"]',
    );
    assert.ok(section, "PaperMiner section should be in the item pane");
    const body = section!.querySelector('[data-type="body"]');
    assert.ok(body, "section body exists");
    const text = body!.textContent || "";
    assert.match(text, /AI (摘要|Summary)/);
    assert.match(text, /(阅读对话|Chat with Paper)/);
    assert.match(text, /(撤稿|Retraction)/);
    assert.isTrue(
      text.includes("EasyScholar") || text.includes("期刊"),
      "journal area should be rendered",
    );
    const icons = Array.from(body!.querySelectorAll(".pm-icon"));
    assert.isAbove(icons.length, 3, "action icons should be rendered");
    const win = Zotero.getMainWindow();
    for (const icon of icons.slice(0, 6)) {
      const style = win.getComputedStyle(icon);
      assert.equal(style.width, "16px", `icon width: ${icon.className}`);
      assert.equal(style.height, "16px", `icon height: ${icon.className}`);
      assert.include(
        style.backgroundImage,
        "chrome://zotero/skin/16/universal/",
        "icons should use native Zotero icon assets",
      );
    }
  });

  it("opens the reader and chat panel from the library item", async function () {
    const { openChatPanel, closeChatPanel } =
      await import("../src/modules/ui/chatPanel");
    await openChatPanel(item);
    await Zotero.Promise.delay(5000);
    const win = Zotero.getMainWindow() as any;
    assert.equal(win.Zotero_Tabs.selectedType, "reader", "reader tab opened");
    assert.ok(
      win.document.getElementById("paperminer-chat-panel"),
      "chat panel should be mounted after opening from library",
    );
    closeChatPanel();
    await Zotero.Promise.delay(500);
    win.Zotero_Tabs.close(win.Zotero_Tabs.selectedID);
    await Zotero.Promise.delay(800);
  });

  it("injects the PaperMiner context submenu", function () {
    const doc = Zotero.getMainWindow().document;
    const itemMenu = doc.getElementById("zotero-itemmenu");
    assert.ok(itemMenu, "#zotero-itemmenu should exist");
    const menu = doc.getElementById("paperminer-itemmenu");
    assert.ok(menu, "PaperMiner submenu should be injected");
    const items = menu!.querySelectorAll("menuitem");
    assert.isAtLeast(items.length, 7, "submenu should expose all core actions");
    assert.isAtLeast(
      menu!.querySelectorAll("menuseparator").length,
      2,
      "submenu should group actions",
    );
    const labels = Array.from(items)
      .map((item) => String(item.getAttribute("label") || ""))
      .join("|");
    for (const expected of [
      "摘要",
      "PPT",
      "对话",
      "划词翻译",
      "设置",
      "撤稿",
    ]) {
      assert.include(labels, expected, `missing menu action: ${expected}`);
    }
  });

  it("registers the journal list column", function () {
    const columns = Zotero.ItemTreeManager.getCustomColumns("main") || [];
    assert.isTrue(
      columns.some((column: any) =>
        String(column.dataKey).endsWith("paperminerJournalRank"),
      ),
    );
  });
});

describe("PaperMiner reader integration", function () {
  this.timeout(120000);
  let item: Zotero.Item;
  let attachment: Zotero.Item;
  let tabID: string | null = null;
  let reader: any = null;
  let readerDoc: Document | null = null;
  before(async function () {
    const created = await createTestPaper();
    item = created.item;
    attachment = created.attachment;
    reader = (await Zotero.Reader.open(attachment.id)) as any;
    await Zotero.Promise.delay(4000);
    tabID =
      reader?.tabID || (Zotero.getMainWindow() as any).Zotero_Tabs?.selectedID;
    for (let attempt = 0; attempt < 20 && !readerDoc; attempt += 1) {
      readerDoc = reader?._iframeWindow?.document || null;
      if (!readerDoc) await Zotero.Promise.delay(500);
    }
  });

  after(async function () {
    try {
      if (tabID) (Zotero.getMainWindow() as any).Zotero_Tabs?.close(tabID);
    } catch {
      // ignore
    }
    if (item) await item.eraseTx();
  });

  it("injects the reader toolbar button and warning banner", async function () {
    const doc = readerDoc;
    assert.ok(doc, "reader iframe document");
    let button: Element | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      button = doc!.getElementById("paperminer-chat-toolbar-button");
      if (button) break;
      await Zotero.Promise.delay(500);
    }
    assert.ok(button, "PaperMiner toolbar button should be injected");
    const icon = button!.querySelector(".pm-icon");
    assert.ok(icon, "toolbar button should contain an icon element");
    const iconStyle = doc!.defaultView!.getComputedStyle(icon!);
    assert.equal(iconStyle.width, "16px");
    assert.equal(iconStyle.height, "16px");
    let banner: Element | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      banner = doc!.querySelector(
        ".pm-journal-reader-banner, .pm-journal-toolbar-chip",
      );
      if (banner) break;
      await Zotero.Promise.delay(500);
    }
    if (!banner) {
      const listeners = (Zotero.Reader as any)._registeredListeners || [];
      const classes = Array.from(
        doc!.querySelectorAll(
          '[class*="pm-journal"], [id*="paperminer"], [class*="paperminer"]',
        ),
      ).map((node) => `${node.id || ""}.${node.className || ""}`);
      assert.fail(
        `banner missing; listeners=${listeners
          .map((item: any) => item.type)
          .join(
            ",",
          )}; nodes=${classes.join("|")}; connected=${doc!.isConnected}`,
      );
    }
  });

  it("provides a PaperMiner reader view context menu", async function () {
    const listeners = (
      (Zotero.Reader as any)._registeredListeners || []
    ).filter(
      (listener: any) =>
        listener.type === "createViewContextMenu" &&
        listener.pluginID === config.addonID,
    );
    assert.isAtLeast(listeners.length, 1, "createViewContextMenu registered");
    const groups: any[][] = [];
    listeners[0].handler({
      reader,
      params: { x: 20, y: 20 },
      append: (...items: any[]) => groups.push(items),
    });
    assert.isAbove(groups.length, 0, "menu groups appended");
    const labels = groups.flat().map((item: any) => String(item.label));
    assert.include(labels.join("|"), "AI 阅读摘要");
    assert.include(labels.join("|"), "汇报 PPT");
    assert.include(labels.join("|"), "阅读对话");
    assert.include(labels.join("|"), "刷新期刊与撤稿信息");
  });

  it("opens and closes the docked chat panel", async function () {
    const { openChatPanel, closeChatPanel } =
      await import("../src/modules/ui/chatPanel");
    await openChatPanel(item);
    await Zotero.Promise.delay(2500);
    const mainDoc = Zotero.getMainWindow().document;
    const panel = mainDoc.getElementById("paperminer-chat-panel");
    assert.ok(panel, "chat panel should be mounted in the context pane");
    const chatIcon = panel!.querySelector(".pm-chat-icon-btn .pm-icon");
    assert.ok(chatIcon, "chat header icons should be rendered");
    const chatStyle = Zotero.getMainWindow().getComputedStyle(chatIcon!);
    assert.equal(chatStyle.width, "16px");
    assert.equal(chatStyle.height, "16px");
    const templateSelect = panel!.querySelector(".pm-chat-template-select");
    assert.ok(templateSelect, "chat template selector should be rendered");
    assert.isAbove(
      templateSelect!.querySelectorAll("option").length,
      4,
      "default conversation templates should be offered",
    );
    assert.ok(
      panel!.textContent?.includes("PaperMiner") ||
        panel!.textContent?.includes("论文阅读对话"),
      "chat panel content should render",
    );
    closeChatPanel();
    await Zotero.Promise.delay(800);
    assert.isNull(
      mainDoc.getElementById("paperminer-chat-panel"),
      "chat panel should be removed",
    );
  });
});
