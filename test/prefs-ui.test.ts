/* eslint-disable mocha/max-top-level-suites */
import { assert } from "chai";

describe("PaperMiner preferences UI", function () {
  this.timeout(30000);

  it("loads the pane and renders controls", async function () {
    const win = Zotero.Utilities.Internal.openPreferences(
      "paperminer-preference-pane",
    ) as Window | null;
    assert.ok(win, "preferences window should open");
    await Zotero.Promise.delay(2500);
    const doc = win!.document;
    const root = doc.getElementById("paperminer-prefpane");
    assert.ok(root, "pane root should be loaded");
    assert.ok(doc.getElementById("pm-llm-preset"), "provider menu exists");
    assert.ok(doc.getElementById("pm-llm-apikey"), "api key input exists");
    assert.ok(doc.getElementById("pm-journal-fields"), "journal fields exist");
    assert.isAbove(
      doc.querySelectorAll("#pm-journal-fields checkbox").length,
      5,
      "journal field checkboxes should be generated",
    );
    assert.ok(doc.getElementById("pm-llm-test"), "test button exists");
    assert.ok(
      doc.getElementById("pm-llm-fetch-models"),
      "fetch-models button exists",
    );
    assert.ok(
      doc.getElementById("pm-llm-disable-thinking"),
      "disable-thinking checkbox exists",
    );
    assert.ok(doc.getElementById("pm-chat-skill-table"), "skills table exists");
    assert.isAbove(
      doc.querySelectorAll("#pm-chat-skill-table .pm-skill-row").length,
      0,
      "built-in skills should be rendered",
    );
    assert.ok(
      doc.getElementById("pm-tr-tencent-key"),
      "Tencent secret id input exists",
    );
    const navIcon = Array.from(
      doc.querySelectorAll("#prefs-navigation image, #prefs-navigation img"),
    ).find((node: any) =>
      String(node.getAttribute("src") || "").includes("paperminer"),
    ) as any;
    if (navIcon) {
      const rect = navIcon.getBoundingClientRect();
      assert.isAtMost(rect.width, 32, `prefs icon width ${rect.width}`);
      assert.isAbove(rect.width, 16, `prefs icon width ${rect.width}`);
    }
    const pptLang = doc.getElementById("pm-ppt-lang") as any;
    const englishOption = pptLang?.querySelector('menuitem[value="en"]');
    assert.include(
      String(englishOption?.getAttribute("label") || ""),
      "English",
      "PPT language options should have localized labels",
    );
    const localeOptions = doc.querySelectorAll("#pm-ppt-lang menuitem");
    for (const option of Array.from(localeOptions)) {
      assert.isNotEmpty(
        String((option as any).getAttribute("label") || ""),
        "every language option should have a label",
      );
    }
    win!.close();
  });
});

describe("PaperMiner preferences interactions", function () {
  this.timeout(30000);

  it("updates prefs when the provider and fields change", async function () {
    const win = Zotero.Utilities.Internal.openPreferences(
      "paperminer-preference-pane",
    ) as Window | null;
    assert.ok(win);
    await Zotero.Promise.delay(2000);
    const doc = win!.document;
    const backupBase = Zotero.Prefs.get(
      "extensions.zotero.paperminer.llmBaseURL",
      true,
    );
    const backupModel = Zotero.Prefs.get(
      "extensions.zotero.paperminer.llmModel",
      true,
    );
    const backupPreset = Zotero.Prefs.get(
      "extensions.zotero.paperminer.llmPreset",
      true,
    );
    const backupJournalFields = Zotero.Prefs.get(
      "extensions.zotero.paperminer.journalFields",
      true,
    );
    try {
      const menulist = doc.getElementById("pm-llm-preset") as any;
      assert.ok(menulist, "preset menu exists");
      menulist.value = "openai";
      menulist.dispatchEvent(new win!.Event("command", { bubbles: true }));
      await Zotero.Promise.delay(100);
      assert.equal(
        Zotero.Prefs.get("extensions.zotero.paperminer.llmPreset", true),
        "openai",
      );
      assert.equal(
        Zotero.Prefs.get("extensions.zotero.paperminer.llmBaseURL", true),
        "https://api.openai.com/v1",
      );
      const modelMenu = doc.getElementById("pm-llm-model") as any;
      assert.ok(modelMenu, "model dropdown exists");
      assert.isAtLeast(
        modelMenu.querySelectorAll("menuitem").length,
        1,
        "model dropdown should be populated from the preset",
      );
      assert.equal(
        Zotero.Prefs.get("extensions.zotero.paperminer.llmModel", true),
        "gpt-4o-mini",
      );
      const fields = doc.querySelectorAll("#pm-journal-fields checkbox");
      const first = fields[0] as any;
      const before = String(
        Zotero.Prefs.get("extensions.zotero.paperminer.journalFields", true),
      );
      first.checked = !first.checked;
      first.dispatchEvent(new win!.Event("command", { bubbles: true }));
      await Zotero.Promise.delay(100);
      const after = String(
        Zotero.Prefs.get("extensions.zotero.paperminer.journalFields", true),
      );
      assert.notEqual(before, after, "journal fields pref should change");

      const pptLang = doc.getElementById("pm-ppt-lang") as any;
      assert.ok(pptLang, "PPT language menu exists");
      pptLang.value = "en";
      pptLang.dispatchEvent(new win!.Event("command", { bubbles: true }));
      await Zotero.Promise.delay(100);
      assert.equal(
        Zotero.Prefs.get("extensions.zotero.paperminer.pptLanguage", true),
        "en",
        "PPT language should persist",
      );
      const sumLang = doc.getElementById("pm-sum-lang") as any;
      sumLang.value = "zh";
      sumLang.dispatchEvent(new win!.Event("command", { bubbles: true }));
      await Zotero.Promise.delay(100);
      assert.equal(
        Zotero.Prefs.get("extensions.zotero.paperminer.summaryLanguage", true),
        "zh",
        "summary language should persist",
      );
    } finally {
      Zotero.Prefs.set(
        "extensions.zotero.paperminer.llmBaseURL",
        backupBase,
        true,
      );
      Zotero.Prefs.set(
        "extensions.zotero.paperminer.llmModel",
        backupModel,
        true,
      );
      Zotero.Prefs.set(
        "extensions.zotero.paperminer.llmPreset",
        backupPreset,
        true,
      );
      Zotero.Prefs.set(
        "extensions.zotero.paperminer.journalFields",
        backupJournalFields,
        true,
      );
      Zotero.Prefs.set(
        "extensions.zotero.paperminer.pptLanguage",
        "auto",
        true,
      );
      Zotero.Prefs.set(
        "extensions.zotero.paperminer.summaryLanguage",
        "auto",
        true,
      );
      win!.close();
    }
  });
});

describe("PaperMiner template and numeric controls", function () {
  this.timeout(30000);

  it("edits the skills table and validates numeric input", async function () {
    const win = Zotero.Utilities.Internal.openPreferences(
      "paperminer-preference-pane",
    ) as Window | null;
    assert.ok(win);
    await Zotero.Promise.delay(2000);
    const doc = win!.document;
    const backupQuick = Zotero.Prefs.get(
      "extensions.zotero.paperminer.chatQuickPhrases",
      true,
    );
    const backupSkills = Zotero.Prefs.get(
      "extensions.zotero.paperminer.chatSkills",
      true,
    );
    const backupTemp = Zotero.Prefs.get(
      "extensions.zotero.paperminer.llmTemperature",
      true,
    );
    const backupSystem = Zotero.Prefs.get(
      "extensions.zotero.paperminer.chatSystemPrompt",
      true,
    );
    const backupEngine = Zotero.Prefs.get(
      "extensions.zotero.paperminer.translateEngine",
      true,
    );
    try {
      const rows = () =>
        doc.querySelectorAll("#pm-chat-skill-table .pm-skill-row");
      assert.isAtLeast(rows().length, 6, "built-in skills should be listed");
      const firstRow = rows()[0] as HTMLElement;
      assert.isAtLeast(
        firstRow.getBoundingClientRect().width,
        400,
        "skills table row should span the pane",
      );
      assert.isAtLeast(
        (
          firstRow.querySelector(".pm-skill-prompt") as HTMLTextAreaElement
        ).getBoundingClientRect().width,
        180,
        "skill prompt column should be readable",
      );
      const addButton = doc.getElementById("pm-chat-skill-add") as any;
      assert.ok(addButton, "add-skill button exists");
      const before = rows().length;
      addButton.dispatchEvent(new win!.Event("command", { bubbles: true }));
      await Zotero.Promise.delay(100);
      assert.equal(rows().length, before + 1, "add button should append a row");

      const last = rows()[rows().length - 1];
      const name = last.querySelector(".pm-skill-name") as HTMLInputElement;
      const prompt = last.querySelector(
        ".pm-skill-prompt",
      ) as HTMLTextAreaElement;
      name.value = "测试技能";
      name.dispatchEvent(new win!.Event("input", { bubbles: true }));
      prompt.value = "请只回答测试内容。";
      prompt.dispatchEvent(new win!.Event("input", { bubbles: true }));
      await Zotero.Promise.delay(500);
      const saved = String(
        Zotero.Prefs.get("extensions.zotero.paperminer.chatSkills", true),
      );
      assert.include(saved, "测试技能");
      assert.include(saved, "请只回答测试内容");

      (last.querySelector(".pm-skill-remove") as HTMLButtonElement).click();
      await Zotero.Promise.delay(100);
      assert.equal(rows().length, before, "remove button should delete a row");

      for (const id of [
        "pm-journal-cachedays",
        "pm-chat-history",
        "pm-chat-temp",
        "pm-llm-temperature",
      ]) {
        const input = doc.getElementById(id) as HTMLInputElement;
        assert.ok(input, `${id} should exist`);
        assert.isAtLeast(
          input.getBoundingClientRect().width,
          60,
          `${id} should not be squeezed by flex layout`,
        );
      }

      const engine = doc.getElementById("pm-tr-engine") as any;
      const promptCard = doc.getElementById("pm-tr-llm-prompt") as HTMLElement;
      const deeplCard = doc.getElementById("pm-tr-deepl") as HTMLElement;
      engine.value = "deepl";
      engine.dispatchEvent(new win!.Event("command", { bubbles: true }));
      await Zotero.Promise.delay(100);
      assert.isTrue(promptCard.hasAttribute("hidden"));
      assert.isFalse(deeplCard.hasAttribute("hidden"));
      engine.value = "llm";
      engine.dispatchEvent(new win!.Event("command", { bubbles: true }));
      await Zotero.Promise.delay(100);
      assert.isFalse(promptCard.hasAttribute("hidden"));

      const launched: string[] = [];
      const originalLaunch = Zotero.launchURL;
      try {
        (Zotero as any).launchURL = (url: string) => launched.push(String(url));
        (doc.getElementById("pm-about-homepage") as HTMLAnchorElement).click();
        (doc.getElementById("pm-about-issues") as HTMLAnchorElement).click();
        assert.include(
          launched.join("\n"),
          "github.com/Waynehfut/Paper-Miner",
          "project homepage link should open externally",
        );
        assert.include(
          launched.join("\n"),
          "github.com/Waynehfut/Paper-Miner/issues",
          "issues link should open externally",
        );
      } finally {
        Zotero.launchURL = originalLaunch;
      }

      for (const id of [
        "pm-llm-test",
        "pm-ppt-pick-dir",
        "pm-open-datadir",
        "pm-chat-skill-add",
      ]) {
        const button = doc.getElementById(id) as HTMLButtonElement;
        assert.ok(button, `${id} should exist`);
        assert.isAtMost(
          button.getBoundingClientRect().width,
          140,
          `${id} should not be stretched by label min-width`,
        );
        assert.isAtLeast(
          button.getBoundingClientRect().height,
          21,
          `${id} should keep a clickable height`,
        );
      }

      const dirInput = doc.getElementById("pm-ppt-dir") as HTMLInputElement;
      const dirButton = doc.getElementById(
        "pm-ppt-pick-dir",
      ) as HTMLButtonElement;
      assert.ok(dirInput && dirButton, "PPT directory controls should exist");
      assert.isAtLeast(dirInput.getBoundingClientRect().width, 150);
      assert.isAtLeast(dirButton.getBoundingClientRect().width, 60);
      assert.isAtMost(
        Math.abs(
          dirInput.getBoundingClientRect().top +
            dirInput.getBoundingClientRect().height / 2 -
            (dirButton.getBoundingClientRect().top +
              dirButton.getBoundingClientRect().height / 2),
        ),
        2,
        "PPT directory button should align with the input",
      );

      const temp = doc.getElementById("pm-llm-temperature") as HTMLInputElement;
      temp.value = "abc";
      temp.dispatchEvent(new win!.Event("input", { bubbles: true }));
      assert.equal(temp.value, "", "non-numeric input should be rejected");
      temp.value = "3.5";
      temp.dispatchEvent(new win!.Event("change", { bubbles: true }));
      assert.equal(
        Zotero.Prefs.get("extensions.zotero.paperminer.llmTemperature", true),
        "2",
        "temperature should be clamped to its maximum",
      );
    } finally {
      Zotero.Prefs.set(
        "extensions.zotero.paperminer.chatQuickPhrases",
        backupQuick,
        true,
      );
      Zotero.Prefs.set(
        "extensions.zotero.paperminer.chatSkills",
        backupSkills,
        true,
      );
      Zotero.Prefs.set(
        "extensions.zotero.paperminer.llmTemperature",
        backupTemp,
        true,
      );
      Zotero.Prefs.set(
        "extensions.zotero.paperminer.chatSystemPrompt",
        backupSystem,
        true,
      );
      Zotero.Prefs.set(
        "extensions.zotero.paperminer.translateEngine",
        backupEngine,
        true,
      );
      win!.close();
    }
  });
});
