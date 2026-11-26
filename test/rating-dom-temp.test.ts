import { assert } from "chai";

describe("rating DOM probe", function () {
  this.timeout(60000);
  it("inspects rating cells", async function () {
    const item = new Zotero.Item("journalArticle");
    item.setField("title", "Rating DOM probe");
    await item.saveTx();
    try {
      const pane = Zotero.getActiveZoteroPane();
      pane.selectItem(item.id);
      await Zotero.Promise.delay(2000);
      const doc = Zotero.getMainWindow().document;
      const cells = doc.querySelectorAll(".pm-rating-cell");
      const stars = doc.querySelectorAll(".pm-rating-star");
      let info: any = { cells: cells.length, stars: stars.length };
      if (stars.length) {
        (stars[2] as HTMLElement).click();
        await Zotero.Promise.delay(800);
        info.extra = String(item.getField("extra") || "");
        info.starsAfter = doc.querySelectorAll(".pm-rating-star").length;
      }
      await (globalThis as any).IOUtils.writeUTF8(
        "/tmp/rating-dom.json",
        JSON.stringify(info, null, 2),
      );
      assert.isTrue(true);
    } finally {
      await item.eraseTx();
    }
  });
});
