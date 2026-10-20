import { assert } from "chai";
import type { PaperMeta } from "../src/types";
import {
  SUMMARY_SECTIONS,
  buildPptOutlineMessages,
  buildSingleSummaryMessages,
} from "../src/modules/ai/prompts";
import { DEFAULT_TEMPLATES } from "../src/modules/chat/quickPhrases";

const meta: PaperMeta = {
  itemID: 1,
  key: "ABCD1234",
  title: "Evidence-Grounded Reading",
  doi: "10.1000/example",
  journal: "Journal of Testing",
  year: "2026",
  authors: "Alice Zhang",
  abstract: "A study of reading assistants.",
  itemType: "journalArticle",
};

describe("prompt quality", function () {
  it("requires evidence, uncertainty and reproducibility in reading notes", function () {
    const messages = buildSingleSummaryMessages({
      meta,
      text: "Body text",
      language: "zh",
    });
    const system = messages[0].content;
    assert.include(system, "作者主张");
    assert.include(system, "推断");
    assert.include(system, "可复现性");
    assert.include(SUMMARY_SECTIONS.zh.join("|"), "关键证据与主要结果");
    assert.include(SUMMARY_SECTIONS.zh.join("|"), "可复现性");
  });

  it("uses assertion-evidence slide titles and speaker notes", function () {
    const messages = buildPptOutlineMessages({
      meta,
      text: "Body text",
      slideCount: 8,
      language: "zh",
    });
    const system = messages[0].content;
    const user = messages[1].content;
    assert.include(system, "一页一个主张");
    assert.include(user, "断言式标题");
    assert.include(user, "speakerNotes");
    assert.include(user, "建议视觉");
    assert.include(user, "结果页必须");
  });

  it("ships stronger default reading skills", function () {
    const labels = DEFAULT_TEMPLATES.map((skill) => skill.label);
    assert.include(labels, "三遍阅读法");
    assert.include(labels, "证据审计");
    assert.include(labels, "方法拆解");
    assert.isAtLeast(DEFAULT_TEMPLATES.length, 8);
  });
});
