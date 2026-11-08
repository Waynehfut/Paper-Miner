import { log } from "./log";

export interface ProgressHandle {
  update: (text: string, progress?: number) => void;
  close: (delayMs?: number) => void;
}

let progressSeq = 0;

/** A Zotero-native progress window used for long-running AI tasks. */
export function showProgress(
  title: string,
  initialText: string,
  progress = 0,
): ProgressHandle {
  progressSeq += 1;
  const id = progressSeq;
  let popup: any;
  try {
    popup = new ztoolkit.ProgressWindow(title, {
      closeOnClick: false,
      closeTime: -1,
    })
      .createLine({
        text: initialText,
        type: "default",
        progress,
      })
      .show();
  } catch (error) {
    log("showProgress failed:", error);
  }
  return {
    update(text: string, value?: number) {
      try {
        popup?.changeLine({
          text,
          progress: value ?? progress,
        });
      } catch {
        // ignore
      }
    },
    close(delayMs = 1500) {
      try {
        if (delayMs > 0) popup?.startCloseTimer(delayMs);
        else popup?.close();
      } catch {
        // ignore
      }
      log("progress closed", id);
    },
  };
}

export function toast(
  text: string,
  type: "default" | "success" | "fail" = "default",
  closeTime = 3500,
): void {
  try {
    new ztoolkit.ProgressWindow("PaperMiner", {
      closeOnClick: true,
      closeTime,
    })
      .createLine({ text, type, progress: 100 })
      .show();
  } catch (error) {
    log("toast failed:", error);
  }
}

export function copyText(text: string): void {
  const value = String(text ?? "");
  if (!value) return;
  try {
    Zotero.Utilities.Internal.copyTextToClipboard(value);
    toast("已复制", "success");
    return;
  } catch (error) {
    log("copyText native failed:", error);
  }

  // Fallback for environments where the privileged clipboard helper is
  // unavailable (or the chat panel is inside an iframe).
  try {
    const win = Zotero.getMainWindow();
    const doc = win?.document;
    if (doc) {
      const area = doc.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "true");
      area.style.position = "fixed";
      area.style.opacity = "0";
      area.style.pointerEvents = "none";
      (doc.body || doc.documentElement)?.appendChild(area);
      area.select();
      const copied = doc.execCommand("copy");
      area.remove();
      if (copied) {
        toast("已复制", "success");
        return;
      }
    }
  } catch (error) {
    log("copyText execCommand failed:", error);
  }

  try {
    const clipboard = Zotero.getMainWindow()?.navigator?.clipboard;
    if (clipboard?.writeText) {
      void clipboard
        .writeText(value)
        .then(() => toast("已复制", "success"))
        .catch((error: unknown) => {
          log("copyText clipboard failed:", error);
          toast("复制失败", "fail");
        });
      return;
    }
  } catch (error) {
    log("copyText clipboard unavailable:", error);
  }
  toast("复制失败", "fail");
}

export function openURL(url: string): void {
  try {
    Zotero.launchURL(url);
  } catch (error) {
    log("openURL failed:", error);
  }
}
