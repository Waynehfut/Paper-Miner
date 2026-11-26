import { assert } from "chai";
import {
  RATING_FIELD,
  getRating,
  setRating,
  __testing,
} from "../src/modules/ui/ratingColumn";

describe("PaperMiner five-star rating", function () {
  it("stores the rating in the Extra field and exposes it to the column", async function () {
    const item = new Zotero.Item("journalArticle");
    item.setField("title", "Rating column test paper");
    item.setField("extra", "Publisher: Test Press\nPMID: 123");
    await item.saveTx();
    try {
      assert.equal(getRating(item), 0);
      assert.equal(__testing.ratingDataProvider(item), `0|${item.id}`);
      assert.equal(await setRating(item, 3), 3);
      assert.equal(getRating(item), 3);
      assert.include(String(item.getField("extra")), `${RATING_FIELD}: 3`);
      assert.include(String(item.getField("extra")), "Publisher: Test Press");
      assert.equal(__testing.ratingDataProvider(item), `3|${item.id}`);
      assert.equal(await setRating(item, 0), 0);
      assert.equal(getRating(item), 0);
      assert.notInclude(String(item.getField("extra")), `${RATING_FIELD}:`);
      assert.include(String(item.getField("extra")), "PMID: 123");
    } finally {
      await item.eraseTx();
    }
  });
});
