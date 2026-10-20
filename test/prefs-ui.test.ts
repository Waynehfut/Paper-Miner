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
    assert.ok(
      doc.getElementById("pm-chat-system-prompt"),
      "custom system prompt textarea exists",
    );
    assert.ok(
      doc.getElementById("pm-chat-quick-phrases"),
      "quick phrase textarea exists",
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

  it("lists built-in templates and validates numeric input", async function () {
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
    const backupTemp = Zotero.Prefs.get(
      "extensions.zotero.paperminer.llmTemperature",
      true,
    );
    try {
      assert.isAtLeast(
        doc.querySelectorAll("#pm-chat-template-presets .pm-pref-template")
          .length,
        6,
        "built-in templates should be listed",
      );
      const addButton = doc.getElementById("pm-chat-add-template") as any;
      const textarea = doc.getElementById(
        "pm-chat-quick-phrases",
      ) as HTMLTextAreaElement;
      assert.ok(addButton && textarea, "add-template controls exist");
      addButton.dispatchEvent(new win!.Event("command", { bubbles: true }));
      assert.include(textarea.value, "新模板 |");

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
        "extensions.zotero.paperminer.llmTemperature",
        backupTemp,
        true,
      );
      win!.close();
    }
  });
});
