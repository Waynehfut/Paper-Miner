import { pluginCache } from "../utils/cache";
import { log } from "../utils/log";
import { registerPreferencesPane } from "./preferences/pane";
import { ensurePrefs } from "./preferences/defaults";
import {
  registerChatEntryPoints,
  unregisterChatEntryPoints,
} from "./ui/chatPanel";
import { registerContextMenus, unregisterContextMenus } from "./ui/contextMenu";
import {
  registerJournalSection,
  unregisterJournalSection,
} from "./ui/journalSection";
import {
  registerReaderBanner,
  unregisterReaderBanner,
} from "./ui/readerBanner";
import {
  registerReaderContextMenu,
  unregisterReaderContextMenu,
} from "./ui/readerContextMenu";
import {
  registerJournalColumn,
  unregisterJournalColumn,
} from "./ui/treeColumn";
import {
  registerSelectionPopup,
  unregisterSelectionPopup,
} from "./ui/selectionPopup";

let started = false;

/** Initialize all PaperMiner features after Zotero is ready. */
export async function initPaperMiner(): Promise<void> {
  if (started) return;
  started = true;
  ensurePrefs();
  registerPreferencesPane();

  try {
    registerJournalSection();
  } catch (error) {
    log("registerJournalSection failed", error);
  }
  try {
    await registerJournalColumn();
  } catch (error) {
    log("registerJournalColumn failed", error);
  }
  try {
    registerReaderBanner();
  } catch (error) {
    log("registerReaderBanner failed", error);
  }
  try {
    registerContextMenus();
  } catch (error) {
    log("registerContextMenus failed", error);
  }
  try {
    registerReaderContextMenu();
  } catch (error) {
    log("registerReaderContextMenu failed", error);
  }
  try {
    registerChatEntryPoints();
  } catch (error) {
    log("registerChatEntryPoints failed", error);
  }
  try {
    registerSelectionPopup();
  } catch (error) {
    log("registerSelectionPopup failed", error);
  }
  log("PaperMiner started");
}

export async function shutdownPaperMiner(): Promise<void> {
  if (!started) return;
  started = false;
  try {
    unregisterSelectionPopup();
    unregisterChatEntryPoints();
    unregisterContextMenus();
    unregisterReaderContextMenu();
    unregisterReaderBanner();
    await unregisterJournalColumn();
    unregisterJournalSection();
    await pluginCache.flush();
  } catch (error) {
    log("shutdownPaperMiner failed", error);
  }
}
