/* eslint-disable mocha/max-top-level-suites */
import { assert } from "chai";
import {
  buildChatContext,
  buildChatMessages,
  buildMetaHeader,
  buildSystemPrompt,
  countOccurrences,
  splitParagraphs,
  scoreParagraph,
  selectRelevantParagraphs,
  toContextParagraphs,
  tokenize,
  trimHistory,
  truncateMiddle,
  DEFAULT_MAX_HISTORY,
} from "../src/modules/chat/context";
import {
  computePopoverPosition,
  movePoint,
} from "../src/modules/chat/position";

const META = {
  itemID: 1,
  key: "ABCD1234",
  title: "Retrieval-Augmented Reading Assistants",
  doi: "10.1000/xyz",
  journal: "Journal of Reading",
  year: "2024",
  authors: "Ada Lovelace, Alan Turing",
  abstract: "We study how language models answer questions about papers.",
  itemType: "journalArticle",
};

describe("chat context", function () {
  describe("tokenize", function () {
    it("lowercases English words and drops stop words", function () {
      const tokens = tokenize("The Retrieval Model is based on Attention");
      assert.include(tokens, "retrieval");
      assert.include(tokens, "model");
      assert.include(tokens, "attention");
      assert.notInclude(tokens, "the");
      assert.notInclude(tokens, "is");
      assert.notInclude(tokens, "based");
    });

    it("uses Chinese bigrams and removes function words", function () {
      const tokens = tokenize("本文提出一种新的检索方法");
      assert.include(tokens, "检索");
      assert.include(tokens, "方法");
      assert.notInclude(tokens, "本文");
      assert.notInclude(tokens, "一种");
      assert.notInclude(tokens, "的");
    });

    it("deduplicates tokens while keeping first-seen order", function () {
      const tokens = tokenize("transformer transformer attention");
      assert.deepEqual(tokens, ["transformer", "attention"]);
    });

    it("handles empty input", function () {
      assert.deepEqual(tokenize(""), []);
    });
  });

  describe("countOccurrences", function () {
    it("counts non-overlapping matches", function () {
      assert.equal(countOccurrences("aaaa", "aa"), 2);
      assert.equal(countOccurrences("abcabc", "abc"), 2);
      assert.equal(countOccurrences("abc", "zzz"), 0);
      assert.equal(countOccurrences("abc", ""), 0);
    });
  });

  describe("splitParagraphs", function () {
    it("splits on blank lines", function () {
      const text = "First paragraph.\n\nSecond paragraph.\n\nThird.";
      assert.deepEqual(splitParagraphs(text), [
        "First paragraph.",
        "Second paragraph.",
        "Third.",
      ]);
    });

    it("treats form feeds as page breaks", function () {
      assert.deepEqual(splitParagraphs("Page one\fPage two"), [
        "Page one",
        "Page two",
      ]);
    });

    it("chunks oversized blocks below the limit", function () {
      const sentence = "This is a sentence about retrieval augmented reading. ";
      const text = sentence.repeat(60);
      const paragraphs = splitParagraphs(text, 300);
      assert.isAbove(paragraphs.length, 1);
      for (const paragraph of paragraphs) {
        assert.isAtMost(paragraph.length, 400);
      }
    });

    it("returns an empty list for empty text", function () {
      assert.deepEqual(splitParagraphs("   \n\n  "), []);
    });
  });

  describe("scoreParagraph", function () {
    it("scores matching paragraphs higher", function () {
      const query = tokenize("retrieval attention");
      const matching = scoreParagraph(
        "We use retrieval with attention over passages.",
        query,
      );
      const other = scoreParagraph("The weather is nice today.", query);
      assert.isAbove(matching, 0);
      assert.equal(other, 0);
    });

    it("caps repeated token contributions", function () {
      const query = ["retrieval"];
      const once = scoreParagraph("retrieval", query);
      const many = scoreParagraph(
        "retrieval retrieval retrieval retrieval",
        query,
      );
      assert.isBelow(many, once * 8);
    });
  });

  describe("selectRelevantParagraphs", function () {
    let paragraphs: ReturnType<typeof toContextParagraphs>;

    beforeEach(function () {
      paragraphs = toContextParagraphs(
        [
          "Introduction: this paper studies reading assistants.",
          "Unrelated discussion of weather and holidays.",
          "Our retrieval model uses attention over document chunks.",
          "The evaluation uses exact match and human ratings.",
          "Conclusion: retrieval improves answer grounding.",
        ].join("\n\n"),
      );
    });

    it("prefers paragraphs matching the question", function () {
      const selected = selectRelevantParagraphs(
        paragraphs,
        "检索模型 attention 如何工作",
        1000,
      );
      const text = selected.map((p) => p.text).join(" ");
      assert.include(text, "retrieval model");
    });

    it("returns paragraphs in document order", function () {
      const selected = selectRelevantParagraphs(
        paragraphs,
        "evaluation ratings conclusion",
        1000,
      );
      const indexes = selected.map((p) => p.index);
      const sorted = indexes.slice().sort((a, b) => a - b);
      assert.deepEqual(indexes, sorted);
    });

    it("respects the character budget", function () {
      const selected = selectRelevantParagraphs(
        paragraphs,
        "retrieval model evaluation",
        120,
      );
      const total = selected.reduce(
        (sum, paragraph) => sum + paragraph.text.length,
        0,
      );
      assert.isAtMost(total, 200);
    });

    it("falls back to leading paragraphs for an unrelated question", function () {
      const selected = selectRelevantParagraphs(
        paragraphs,
        "quantum chromodynamics",
        2000,
      );
      assert.isAbove(selected.length, 0);
      assert.equal(selected[0].index, 0);
    });

    it("copes with empty input", function () {
      assert.deepEqual(selectRelevantParagraphs([], "anything", 1000), []);
      assert.deepEqual(selectRelevantParagraphs(paragraphs, "anything", 0), []);
    });
  });

  describe("buildMetaHeader", function () {
    it("includes available metadata only", function () {
      const header = buildMetaHeader(META);
      assert.include(header, "标题");
      assert.include(header, META.title);
      assert.include(header, META.doi);
      assert.include(header, "摘要");
    });
  });

  describe("buildChatContext", function () {
    it("includes the whole text when it fits", function () {
      const result = buildChatContext(
        { meta: META, text: "Short body about retrieval." },
        { maxChars: 60000 },
      );
      assert.equal(result.mode, "full");
      assert.include(result.contextText, "Short body about retrieval.");
      assert.include(result.contextText, META.title);
    });

    it("retrieves relevant excerpts and stays within the budget", function () {
      const paragraphs: string[] = [];
      for (let i = 0; i < 80; i += 1) {
        paragraphs.push(
          i === 40
            ? "The proposed retrieval pipeline reranks candidate passages with a cross encoder."
            : `Filler paragraph ${i} describing background details unrelated to the query.`,
        );
      }
      const text = paragraphs.join("\n\n");
      const result = buildChatContext(
        { meta: META, text },
        { question: "retrieval rerank cross encoder", maxChars: 4000 },
      );
      assert.equal(result.mode, "retrieved");
      assert.include(result.contextText, "cross encoder");
      assert.isAtMost(result.contextText.length, 4000);
      assert.isTrue(result.truncated);
    });

    it("tells the model when no full text could be extracted", function () {
      const result = buildChatContext(
        { meta: META, text: "" },
        { maxChars: 2000 },
      );
      assert.include(result.contextText, "未能提取到 PDF 正文");
      assert.isAtMost(result.contextText.length, 2000);
    });
  });

  describe("buildSystemPrompt", function () {
    it("embeds the context and the grounding rules", function () {
      const prompt = buildSystemPrompt("CONTEXT-BLOCK");
      assert.include(prompt, "CONTEXT-BLOCK");
      assert.include(prompt, "原文事实");
      assert.include(prompt, "推断");
      assert.include(prompt, "未提及");
    });
  });

  describe("history trimming", function () {
    const history = [
      { role: "user" as const, content: "one" },
      { role: "assistant" as const, content: "two" },
      { role: "user" as const, content: "three" },
    ];

    it("keeps the newest messages", function () {
      const trimmed = trimHistory(history, 2);
      assert.deepEqual(
        trimmed.map((message) => message.content),
        ["two", "three"],
      );
    });

    it("keeps everything when the limit is not positive", function () {
      assert.lengthOf(trimHistory(history, 0), 3);
      assert.lengthOf(trimHistory(history, -1), 3);
    });

    it("drops empty messages", function () {
      const trimmed = trimHistory(
        [
          { role: "user" as const, content: "" },
          { role: "assistant" as const, content: "kept" },
        ],
        10,
      );
      assert.lengthOf(trimmed, 1);
    });

    it("builds request messages with a system prompt first", function () {
      const messages = buildChatMessages({
        systemPrompt: "SYS",
        history,
        question: "four",
        maxHistory: DEFAULT_MAX_HISTORY,
      });
      assert.equal(messages[0].role, "system");
      assert.equal(messages[0].content, "SYS");
      assert.equal(messages[messages.length - 1].role, "user");
      assert.equal(messages[messages.length - 1].content, "four");
    });

    it("does not duplicate a question already in the history", function () {
      const messages = buildChatMessages({
        systemPrompt: "SYS",
        history,
        question: "three",
      });
      assert.equal(
        messages.filter((message) => message.content === "three").length,
        1,
      );
    });

    it("truncates oversized history messages in the middle", function () {
      const long = "A".repeat(2000) + "END";
      const messages = buildChatMessages({
        systemPrompt: "SYS",
        history: [{ role: "user", content: long }],
        maxCharsPerMessage: 200,
      });
      const sent = messages[1].content;
      assert.isAtMost(sent.length, 210);
      assert.include(sent, "END");
      assert.include(sent, "…");
    });
  });

  describe("truncateMiddle", function () {
    it("keeps short text untouched", function () {
      assert.equal(truncateMiddle("hello", 10), "hello");
    });

    it("keeps head and tail", function () {
      const result = truncateMiddle("HEAD" + "x".repeat(100) + "TAIL", 20);
      assert.include(result, "HEAD");
      assert.include(result, "TAIL");
      assert.isAtMost(result.length, 24);
    });
  });

  describe("popover positioning", function () {
    const viewport = { width: 800, height: 600 };
    const size = { width: 340, height: 200 };

    it("prefers below the anchor when there is room", function () {
      const position = computePopoverPosition(
        { left: 300, right: 400, top: 100, bottom: 120 },
        size,
        viewport,
      );
      assert.equal(position.top, 128);
      assert.isAtLeast(position.left, 8);
      assert.isAtMost(position.left, viewport.width - size.width - 8);
    });

    it("flips above the anchor near the bottom", function () {
      const position = computePopoverPosition(
        { left: 300, right: 400, top: 550, bottom: 570 },
        size,
        viewport,
      );
      assert.equal(position.top, 550 - 200 - 8);
    });

    it("clamps dragged positions inside the viewport", function () {
      const position = computePopoverPosition(
        { left: 0, right: 0, top: 0, bottom: 0 },
        size,
        viewport,
        { preferred: { left: -100, top: 5000 } },
      );
      assert.equal(position.left, 8);
      assert.equal(position.top, 600 - 200 - 8);
    });

    it("moves a dragged point without letting it escape", function () {
      const moved = movePoint(
        { left: 100, top: 100 },
        { dx: -500, dy: 5000 },
        size,
        viewport,
      );
      assert.equal(moved.left, 8);
      assert.equal(moved.top, 600 - 200 - 8);
    });

    it("handles a viewport smaller than the popover", function () {
      const position = computePopoverPosition(
        { left: 10, right: 20, top: 10, bottom: 20 },
        size,
        { width: 200, height: 150 },
      );
      assert.equal(position.left, 8);
      assert.equal(position.top, 8);
    });
  });
});

describe("custom system prompt", function () {
  it("appends the custom instructions to the default rules", function () {
    const prompt = buildSystemPrompt("CTX", "CUSTOM-INSTRUCTION");
    assert.include(prompt, "CUSTOM-INSTRUCTION");
    assert.include(prompt, "只依据下面给出的论文信息与原文回答");
    assert.include(prompt, "CTX");
  });
});
