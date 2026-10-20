/* eslint-disable mocha/no-setup-in-describe */
import { assert } from "chai";
import {
  findSummaryNote,
  maybeAutoGenerateSummary,
} from "../src/modules/ai/summary";
import { getPref, setPref } from "../src/utils/prefs";

function fixturePath(): string {
  const cwd = Services.dirsvc.get("CurWorkD", Ci.nsIFile).path;
  const pathUtils = (globalThis as any).PathUtils;
  return pathUtils?.join
    ? pathUtils.join(cwd, "test", "fixtures", "sample-paper.pdf")
    : `${cwd}/test/fixtures/sample-paper.pdf`;
}

const FIXTURE = fixturePath();

async function createPaper(title: string): Promise<Zotero.Item> {
  const item = new Zotero.Item("journalArticle");
  item.libraryID = Zotero.Libraries.userLibraryID;
  item.setField("title", title);
  item.setField("publicationTitle", "Nature");
  item.setField("abstractNote", "Auto summary switch test.");
  await item.saveTx();
  await Zotero.Attachments.importFromFile({
    file: FIXTURE,
    parentItemID: item.id,
  });
  return item;
}

describe("auto summary switch", function () {
  this.timeout(60000);
  const originalFetch = (globalThis as any).fetch;
  const backup: Record<string, unknown> = {};
  let itemOff: Zotero.Item;
  let itemOn: Zotero.Item;

  before(async function () {
    for (const key of [
      "summaryAuto",
      "llmBaseURL",
      "llmApiKey",
      "llmModel",
      "llmStream",
      "summaryTag",
    ]) {
      backup[key] = getPref(key as any);
    }
    setPref("llmBaseURL", "https://mock.local/v1" as never);
    setPref("llmApiKey", "test-key" as never);
    setPref("llmModel", "mock-model" as never);
    setPref("llmStream", false as never);
    setPref("summaryTag", "PaperMiner-AutoTest" as never);
    setPref("summaryAuto", false as never);
    itemOff = await createPaper("Auto summary off");
    itemOn = await createPaper("Auto summary on");
    (globalThis as any).fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "## 总结\n自动摘要测试内容。" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
  });

  after(async function () {
    (globalThis as any).fetch = originalFetch;
    for (const [key, value] of Object.entries(backup)) {
      setPref(key as any, value as never);
    }
    if (itemOff) await itemOff.eraseTx();
    if (itemOn) await itemOn.eraseTx();
  });

  it("does nothing when the switch is off", async function () {
    await maybeAutoGenerateSummary(itemOff);
    assert.isNull(await findSummaryNote(itemOff));
  });

  it("generates once when the switch is on", async function () {
    setPref("summaryAuto", true as never);
    await maybeAutoGenerateSummary(itemOn);
    const note = await findSummaryNote(itemOn);
    assert.ok(note, "auto summary note should be created");
    assert.isTrue(note!.hasTag("PaperMiner-AutoTest"));
  });
});
