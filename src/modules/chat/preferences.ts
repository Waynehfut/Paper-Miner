/**
 * Small helpers to jump to the PaperMiner preference pane.
 */

import { log } from "../../utils/log";

export const PREFS_PANE_ID = "paperminer-preference-pane";

/** Open the PaperMiner settings, focused on the AI section when possible. */
export function openPreferencesPane(): void {
  try {
    Zotero.Utilities.Internal.openPreferences(PREFS_PANE_ID);
  } catch (error) {
    log("openPreferencesPane failed:", error);
  }
}
