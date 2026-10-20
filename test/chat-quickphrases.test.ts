import { assert } from "chai";
import {
  getDefaultTemplates,
  loadQuickPhrases,
  MAX_QUICK_PHRASES,
  parseQuickPhrases,
} from "../src/modules/chat/quickPhrases";
import { setPref } from "../src/utils/prefs";

describe("chat quick phrases", function () {
  it("parses plain lines and named templates", function () {
    const parsed = parseQuickPhrases(
      "总结一下这篇论文\n审稿人视角 | 请指出主要缺陷\n复现要点｜需要哪些数据",
    );
    assert.lengthOf(parsed, 3);
    assert.equal(parsed[1].label, "审稿人视角");
    assert.include(parsed[1].prompt, "主要缺陷");
    assert.equal(parsed[2].label, "复现要点");
  });

  it("deduplicates, skips blanks, and bounds the list", function () {
    const lines = Array.from(
      { length: MAX_QUICK_PHRASES + 5 },
      (_, index) => `模板 ${index} | 问题 ${index}`,
    );
    lines.push("重复 | 问题 0", "   ");
    const parsed = parseQuickPhrases(lines.join("\n"));
    assert.lengthOf(parsed, MAX_QUICK_PHRASES);
    assert.equal(parsed[0].prompt, "问题 0");
  });

  it("appends user templates after defaults", function () {
    const backup = Zotero.Prefs.get(
      "extensions.zotero.paperminer.chatQuickPhrases",
      true,
    );
    try {
      setPref("chatQuickPhrases", "我的模板 | 只回答一句话" as never);
      const phrases = loadQuickPhrases();
      assert.isAbove(phrases.length, getDefaultTemplates().length);
      assert.equal(phrases[phrases.length - 1].prompt, "只回答一句话");
    } finally {
      Zotero.Prefs.set(
        "extensions.zotero.paperminer.chatQuickPhrases",
        backup,
        true,
      );
    }
  });
});
