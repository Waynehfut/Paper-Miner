import { initLocale } from "./utils/locale";
import { installAbortGlobals } from "./utils/abort";
import { createZToolkit } from "./utils/ztoolkit";
import { installMainWindowStyles } from "./utils/styles";
import { initPaperMiner, shutdownPaperMiner } from "./modules/plugin";
import { onPreferencesLoad } from "./modules/preferences/pane";
import { log } from "./utils/log";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  installAbortGlobals();
  initLocale();
  addon.data.ztoolkit = createZToolkit();

  await initPaperMiner();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
  log("startup complete");
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );
  installMainWindowStyles(win);
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  // Styles are attached to the window document and disappear with it.
}

async function onShutdown(): Promise<void> {
  await shutdownPaperMiner();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

/**
 * Preference pane lifecycle. The pane XHTML calls this on load.
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      await onPreferencesLoad(data.window);
      break;
    default:
      return;
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};
