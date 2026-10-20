import { assert } from "chai";
import { config } from "../package.json";

describe("PaperMiner startup", function () {
  it("exposes the plugin instance", function () {
    assert.isNotEmpty((Zotero as any)[config.addonInstance]);
  });

  it("has initialized PaperMiner", function () {
    const addon = (Zotero as any)[config.addonInstance];
    assert.isTrue(addon.data.initialized);
    assert.isTrue(addon.data.alive);
  });

  it("registers the preference pane", function () {
    const panes = Zotero.PreferencePanes.pluginPanes || [];
    assert.isTrue(
      panes.some((pane: any) => pane.id === "paperminer-preference-pane"),
    );
  });

  it("registers the journal item pane section", function () {
    const data = (Zotero.ItemPaneManager as any).customSectionData || {};
    const sections: any[] = Array.isArray(data.options) ? data.options : [];
    const ours = sections.find((section) =>
      String(section.paneID).endsWith("paperminer-journal"),
    );
    assert.ok(
      ours,
      `sections=${JSON.stringify(sections.map((section) => section.paneID))}`,
    );
    // Icons must use Zotero's native item-pane icon set (16/20 px, context-fill).
    assert.include(
      String(ours.header.icon),
      "chrome://zotero/skin/itempane/16/",
    );
    assert.include(
      String(ours.sidenav.icon),
      "chrome://zotero/skin/itempane/20/",
    );
  });

  it("registers the item tree column", function () {
    const columns = Zotero.ItemTreeManager.getCustomColumns("main") || [];
    assert.isTrue(
      columns.some((column: any) =>
        String(column.dataKey).endsWith("paperminerJournalRank"),
      ),
      `columns=${JSON.stringify(columns.map((column: any) => column.dataKey))}`,
    );
  });
});
