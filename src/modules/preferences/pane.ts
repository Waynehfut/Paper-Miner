import { config } from "../../../package.json";
import { t } from "../../utils/i18n";
import { log } from "../../utils/log";

/** Register the PaperMiner preference pane. */
export function registerPreferencesPane(): void {
  try {
    Zotero.PreferencePanes.register({
      pluginID: config.addonID,
      id: "paperminer-preference-pane",
      src: `${rootURI}content/preferences.xhtml`,
      label: t("prefs-title", "PaperMiner 设置"),
      image: `chrome://${config.addonRef}/content/icons/paperminer-192.png`,
      stylesheets: [
        `${rootURI}content/styles/base.css`,
        `${rootURI}content/styles/preferences.css`,
      ],
    });
    log("preference pane registered");
  } catch (error) {
    log("registerPreferencesPane failed", error);
  }
}

/**
 * Called by hooks.onPrefsEvent when the preference pane document is loaded.
 * Implemented in preferencesUI.ts.
 */
export async function onPreferencesLoad(win: Window): Promise<void> {
  const { initPreferencesUI } = await import("./preferencesUI");
  await initPreferencesUI(win);
}
