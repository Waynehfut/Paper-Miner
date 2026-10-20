/* eslint-disable mocha/max-top-level-suites */
import { assert } from "chai";
import type { PaperMeta } from "../src/types";
import {
  buildFallbackOutline,
  displayWidth,
  normalizeOutline,
  parsePptOutline,
  PPT_MAX_BULLETS,
  PPT_MAX_BULLET_WIDTH,
  PPT_MAX_TITLE_WIDTH,
  truncateDisplay,
} from "../src/modules/ai/outline";
import { buildPptOutlineMessages } from "../src/modules/ai/prompts";

const meta: PaperMeta = {
  itemID: 1,
  key: "ABCD1234",
  title: "A Study of Neural Ranking with Limited Labels",
  doi: "10.1000/example.2024.001",
  journal: "Journal of Testing",
  year: "2024",
  authors: "Alice Zhang, Bob Li",
  abstract:
    "We study neural ranking with limited labels. We propose a contrastive objective and a lightweight re-ranker. Experiments on three benchmarks show a 4.2 point nDCG gain while reducing latency by 30%. Limitations include evaluation on English data only.",
  itemType: "journalArticle",
};

const options = { meta, slideCount: 6, language: "zh" as const };

describe("PPT outline normalization", function () {
  it("normalizes a well-formed outline", function () {
    const outline = normalizeOutline(
      {
        title: "Neural Ranking",
        subtitle: "A short summary",
        slides: [
          {
            title: "Background",
            bullets: [
              "Ranking matters",
              "Labels are expensive",
              "Neural models help",
            ],
            speakerNotes: "Start with the motivation.",
          },
          {
            title: "Method",
            bullets: [
              "Contrastive objective",
              "Lightweight re-ranker",
              "Three benchmarks",
            ],
          },
        ],
      },
      options,
    );
    assert.equal(outline.title, "Neural Ranking");
    assert.equal(outline.subtitle, "A short summary");
    assert.lengthOf(outline.slides, 2);
    assert.deepEqual(outline.slides[0].bullets, [
      "Ranking matters",
      "Labels are expensive",
      "Neural models help",
    ]);
    assert.equal(outline.slides[0].speakerNotes, "Start with the motivation.");
  });

  it("parses fenced JSON surrounded by prose", function () {
    const raw = [
      "以上就是大纲：",
      "```json",
      JSON.stringify({
        title: "Deck",
        slides: [{ title: "One", bullets: ["a", "b"] }],
      }),
      "```",
      "如有需要可以继续扩展。",
    ].join("\n");
    const outline = parsePptOutline(raw, options);
    assert.equal(outline.title, "Deck");
    assert.lengthOf(outline.slides, 1);
    assert.equal(outline.slides[0].title, "One");
  });

  it("accepts a bare JSON array of slides", function () {
    const outline = normalizeOutline(
      [
        { title: "Intro", bullets: ["x", "y"] },
        { title: "Results", bullets: ["z"] },
      ],
      options,
    );
    assert.lengthOf(outline.slides, 2);
    assert.equal(outline.title, meta.title);
  });

  it("parses a JSON array answer without dropping slides", function () {
    const raw = JSON.stringify([
      { title: "Intro", bullets: ["x", "y"] },
      { title: "Method", bullets: ["m1", "m2"] },
      { title: "Results", bullets: ["z"] },
    ]);
    const outline = parsePptOutline(raw, options);
    assert.lengthOf(outline.slides, 3);
    assert.deepEqual(
      outline.slides.map((slide) => slide.title),
      ["Intro", "Method", "Results"],
    );
    assert.equal(outline.title, meta.title);
  });

  it("normalizes messy bullets and limits their number", function () {
    const outline = normalizeOutline(
      {
        title: "Deck",
        slides: [
          {
            title: "1. Messy slide",
            bullets: [
              "- **First** point",
              "* second point",
              "3) third point",
              { text: "object point" },
              "",
              "first point",
              "fourth",
              "fifth",
              "sixth",
              "seventh",
            ],
          },
        ],
      },
      options,
    );
    const bullets = outline.slides[0].bullets;
    assert.isAtMost(bullets.length, PPT_MAX_BULLETS);
    assert.include(bullets, "First point");
    assert.include(bullets, "second point");
    assert.include(bullets, "third point");
    assert.include(bullets, "object point");
    // Duplicate (\"first point\") is removed.
    assert.lengthOf(
      bullets.filter((bullet) => bullet.toLowerCase() === "first point"),
      1,
    );
    assert.equal(outline.slides[0].title, "Messy slide");
  });

  it("truncates long titles and bullets", function () {
    const longTitle = "标题".repeat(100);
    const longBullet = "要点".repeat(200);
    const outline = normalizeOutline(
      { title: "Deck", slides: [{ title: longTitle, bullets: [longBullet] }] },
      options,
    );
    assert.isAtMost(displayWidth(outline.slides[0].title), PPT_MAX_TITLE_WIDTH);
    assert.include(outline.slides[0].title, "…");
    assert.isAtMost(
      displayWidth(outline.slides[0].bullets[0]),
      PPT_MAX_BULLET_WIDTH,
    );
    assert.include(outline.slides[0].bullets[0], "…");
  });

  it("limits the number of slides to the requested count", function () {
    const slides = Array.from({ length: 20 }, (_, index) => ({
      title: `Section ${index + 1}`,
      bullets: ["a", "b", "c"],
    }));
    const outline = normalizeOutline({ title: "Deck", slides }, options);
    assert.lengthOf(outline.slides, options.slideCount);
  });

  it("falls back to metadata for invalid responses", function () {
    const outline = parsePptOutline("抱歉，我无法生成这个大纲。", options);
    assert.equal(outline.title, meta.title);
    assert.isAbove(outline.slides.length, 0);
    for (const slide of outline.slides) {
      assert.isAbove(slide.title.length, 0);
      assert.isAbove(slide.bullets.length, 0);
      assert.isAtMost(slide.bullets.length, PPT_MAX_BULLETS);
    }
    const flat = outline.slides.flatMap((slide) => slide.bullets).join(" ");
    assert.include(flat, "Journal of Testing");
  });

  it("falls back when the model returns an empty slide list", function () {
    const outline = normalizeOutline({ title: "Deck", slides: [] }, options);
    assert.isAbove(outline.slides.length, 0);
    assert.equal(outline.slides[0].title, "论文概况");
  });

  it("builds a complete fallback outline from metadata", function () {
    const outline = buildFallbackOutline(meta, 6, "zh");
    assert.equal(outline.title, meta.title);
    assert.include(outline.subtitle, meta.journal);
    assert.isAtLeast(outline.slides.length, 2);
    const titles = outline.slides.map((slide) => slide.title);
    assert.include(titles, "论文概况");
    assert.include(titles, "阅读提示");
    assert.isTrue(outline.slides.every((slide) => slide.bullets.length > 0));
  });

  it("measures display width with CJK characters as double", function () {
    assert.equal(displayWidth("ab"), 2);
    assert.equal(displayWidth("中文"), 4);
    assert.equal(displayWidth("中a"), 3);
    assert.equal(truncateDisplay("abcdefghij", 5).length, 5);
    assert.isAtMost(displayWidth(truncateDisplay("中".repeat(20), 10)), 10);
  });
});

describe("custom slide prompt", function () {
  it("appends the user's slide instructions", function () {
    const messages = buildPptOutlineMessages({
      meta,
      text: "Body text",
      slideCount: 5,
      language: "zh",
      customPrompt: "CUSTOM-SLIDE-RULE",
    });
    assert.include(messages[0].content, "CUSTOM-SLIDE-RULE");
    assert.include(messages[0].content, "演示文稿设计师");
  });
});
