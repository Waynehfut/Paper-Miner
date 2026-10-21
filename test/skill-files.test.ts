/* eslint-disable mocha/no-setup-in-describe */

import { assert } from "chai";
import {
  loadSkillFiles,
  parseSkillMarkdown,
  serializeSkillMarkdown,
  writeSkillFiles,
} from "../src/modules/chat/skillFiles";
import { joinPath } from "../src/utils/fs";

describe("Markdown skill files", function () {
  const dir = joinPath(
    Zotero.getTempDirectory().path,
    "paperminer-skills-test",
  );
  const io = (globalThis as any).IOUtils;

  beforeEach(async function () {
    if (await io.exists(dir)) await io.remove(dir, { recursive: true });
    await io.makeDirectory(dir, {
      createAncestors: true,
      ignoreExisting: true,
    });
  });

  afterEach(async function () {
    if (await io.exists(dir)) await io.remove(dir, { recursive: true });
  });

  it("parses front matter, quoted names and global rules", function () {
    const skill = parseSkillMarkdown(
      [
        "---",
        'name: "审稿人视角"',
        "global: true",
        "---",
        "请指出论文的主要缺陷。",
        "",
        "并给出修改建议。",
      ].join("\n"),
    );
    assert.equal(skill?.label, "审稿人视角");
    assert.isTrue(skill?.global);
    assert.include(skill?.prompt || "", "主要缺陷");
    assert.include(skill?.prompt || "", "修改建议");
  });

  it("supports a plain heading fallback", function () {
    const skill = parseSkillMarkdown("# 方法拆解\n\n按输入→步骤→输出拆解。");
    assert.equal(skill?.label, "方法拆解");
    assert.equal(skill?.prompt, "按输入→步骤→输出拆解。");
  });

  it("round-trips and preserves order, global flags and stale-file cleanup", async function () {
    const rows = [
      { label: "总结核心贡献", prompt: "用三条总结。", global: true },
      { label: "证据审计", prompt: "列出主张和证据。" },
    ];
    const written = await writeSkillFiles(rows, dir);
    assert.equal(written.length, 2);
    assert.match(written[0], /01-.*\.md$/);
    assert.match(written[1], /02-.*\.md$/);

    const loaded = await loadSkillFiles(dir);
    assert.deepEqual(
      loaded?.map((row) => row.label),
      ["总结核心贡献", "证据审计"],
    );
    assert.isTrue(loaded?.[0]?.global);
    assert.isNotTrue(loaded?.[1]?.global);

    // A user-created file is picked up; a removed skill file is deleted on save.
    await io.writeUTF8(
      joinPath(dir, "03-manual.md"),
      serializeSkillMarkdown({ label: "手工技能", prompt: "手工添加。" }),
    );
    const withManual = await loadSkillFiles(dir);
    assert.include(
      withManual?.map((row) => row.label),
      "手工技能",
    );

    await io.writeUTF8(
      joinPath(dir, "99-stale.md"),
      serializeSkillMarkdown({ label: "过期", prompt: "应被清理。" }),
    );
    await writeSkillFiles(rows, dir);
    const children = await io.getChildren(dir);
    assert.isFalse(
      children.some((path: string) => path.endsWith("99-stale.md")),
    );
  });

  it("migrates a legacy skills.json folder to Markdown", async function () {
    await io.writeUTF8(
      joinPath(dir, "skills.json"),
      JSON.stringify([
        { label: "旧技能", prompt: "旧 JSON 技能内容。", global: true },
      ]),
    );
    const rows = await loadSkillFiles(dir);
    assert.equal(rows?.length, 1);
    assert.equal(rows?.[0].label, "旧技能");
    assert.isTrue(rows?.[0].global);
    const children = await io.getChildren(dir);
    assert.isTrue(
      children.some((path: string) => /\.md$/.test(path)),
      "legacy JSON should be migrated to Markdown",
    );
    assert.isFalse(
      children.some((path: string) => /skills\.json$/.test(path)),
      "legacy JSON should be removed",
    );
  });

  it("returns null when the skills directory does not exist", async function () {
    assert.isNull(await loadSkillFiles(joinPath(dir, "missing-subdirectory")));
  });
});
