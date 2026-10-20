import { assert } from "chai";
import {
  getDefaultTemplates,
  loadQuickPhrases,
  MAX_QUICK_PHRASES,
  parseQuickPhrases,
  parseSkillsPayload,
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

  it("parses JSON skill payloads and plain text imports", function () {
    const json = parseSkillsPayload(
      JSON.stringify({
        skills: [
          { name: "审稿人", instruction: "指出缺陷" },
          { label: "复现", prompt: "列出步骤" },
        ],
      }),
    );
    assert.lengthOf(json, 2);
    assert.equal(json[0].label, "审稿人");
    assert.equal(json[0].prompt, "指出缺陷");
    const text = parseSkillsPayload("一句话 | 只回答一句话");
    assert.lengthOf(text, 1);
    assert.equal(text[0].prompt, "只回答一句话");
  });

  it("prefers the editable chatSkills list over the legacy lines", function () {
    const backupSkills = Zotero.Prefs.get(
      "extensions.zotero.paperminer.chatSkills",
      true,
    );
    const backupQuick = Zotero.Prefs.get(
      "extensions.zotero.paperminer.chatQuickPhrases",
      true,
    );
    try {
      setPref(
        "chatSkills",
        JSON.stringify([{ label: "唯一技能", prompt: "唯一提示词" }]) as never,
      );
      setPref("chatQuickPhrases", "旧模板 | 旧提示词" as never);
      const phrases = loadQuickPhrases();
      assert.lengthOf(phrases, 1);
      assert.equal(phrases[0].label, "唯一技能");
    } finally {
      Zotero.Prefs.set(
        "extensions.zotero.paperminer.chatSkills",
        backupSkills,
        true,
      );
      Zotero.Prefs.set(
        "extensions.zotero.paperminer.chatQuickPhrases",
        backupQuick,
        true,
      );
    }
  });

  it("appends legacy user templates after defaults when chatSkills is empty", function () {
    const backup = Zotero.Prefs.get(
      "extensions.zotero.paperminer.chatQuickPhrases",
      true,
    );
    const backupSkills = Zotero.Prefs.get(
      "extensions.zotero.paperminer.chatSkills",
      true,
    );
    try {
      setPref("chatSkills", "" as never);
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
      Zotero.Prefs.set(
        "extensions.zotero.paperminer.chatSkills",
        backupSkills,
        true,
      );
    }
  });
});
