/**
 * Reader / item plumbing shared by the chat panel and the selection popup.
 *
 * Kept free of UI construction so the same code works for reader tabs, reader
 * windows and the item pane.
 */

import { getRegularItemForReader } from "../../utils/item";
import type { AnchorRect } from "./position";

export type ReaderLike = {
  itemID?: number;
  tabID?: string;
  _iframeWindow?: Window;
  _internalReader?: {
    _lastView?: {
      _iframeWindow?: Window;
      getClientRectForPopup?: (position: {
        pageIndex?: number;
        rects?: number[][];
      }) => number[];
    };
  };
};

export interface SelectionAnchor {
  doc: Document;
  rect: AnchorRect;
  text: string;
}

/** The main Zotero window, or null while Zotero is starting up. */
export function getMainWindow(): _ZoteroTypes.MainWindow | null {
  try {
    return Zotero.getMainWindow() as _ZoteroTypes.MainWindow;
  } catch {
    return null;
  }
}

export function getSelectedTabType(): string {
  const win = getMainWindow();
  try {
    return win?.Zotero_Tabs?.selectedType || "library";
  } catch {
    return "library";
  }
}

/** The reader instance of the currently selected tab, if any. */
export function getActiveReader(): ReaderLike | null {
  const win = getMainWindow();
  if (!win) return null;
  try {
    const tabID = win.Zotero_Tabs?.selectedID;
    if (!tabID) return null;
    const reader = Zotero.Reader.getByTabID(tabID);
    return (reader as ReaderLike) || null;
  } catch {
    return null;
  }
}

export function getReaderDocument(reader: ReaderLike | null): Document | null {
  if (!reader) return null;
  try {
    return reader._iframeWindow?.document || null;
  } catch {
    // Dead reader wrapper after its tab closed.
    return null;
  }
}

function asItem(value: unknown): Zotero.Item | null {
  return value && typeof value === "object" && "isRegularItem" in value
    ? (value as Zotero.Item)
    : null;
}

/** The PDF attachment item backing a reader. */
export function getReaderAttachment(
  reader: ReaderLike | null,
): Zotero.Item | null {
  if (!reader?.itemID) return null;
  try {
    return asItem(Zotero.Items.get(reader.itemID));
  } catch {
    return null;
  }
}

/**
 * The paper item for a reader: the parent regular item when available, else
 * the attachment itself (standalone PDFs still deserve a chat).
 */
export function getPaperItemForReader(
  reader: ReaderLike | null,
): Zotero.Item | null {
  const attachment = getReaderAttachment(reader);
  if (!attachment) return null;
  return getRegularItemForReader(attachment) || attachment;
}

/** Normalise any item (attachment, child note, ...) to the paper item. */
export function resolvePaperItem(
  item: Zotero.Item | null | undefined,
): Zotero.Item | null {
  if (!item) return null;
  try {
    if (item.isRegularItem()) return item;
    if (item.isAttachment()) {
      return getRegularItemForReader(item) || item;
    }
  } catch {
    // ignore
  }
  return null;
}

/** Build an anchor rect from a DOM rect. */
export function toAnchorRect(rect: {
  left: number;
  right: number;
  top: number;
  bottom: number;
}): AnchorRect {
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
  };
}

/** Current text selection and its last visible client rect. */
export function getSelectionAnchor(doc: Document): SelectionAnchor | null {
  try {
    const selection = doc.getSelection();
    if (!selection || !selection.rangeCount) return null;
    const text = String(selection.toString() || "").trim();
    if (!text) return null;
    const range = selection.getRangeAt(selection.rangeCount - 1);
    const view = doc.defaultView;
    const width = view?.innerWidth || 0;
    const height = view?.innerHeight || 0;
    const rects = Array.from(range.getClientRects() || []).filter(
      (rect) =>
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right >= 0 &&
        rect.left <= width &&
        rect.bottom >= 0 &&
        rect.top <= height,
    );
    const rect = rects[rects.length - 1];
    if (!rect) return null;
    return { doc, rect: toAnchorRect(rect), text };
  } catch {
    return null;
  }
}

/**
 * Rect for a text-selection popup event. Falls back to the PDF view's
 * `getClientRectForPopup` so a popup opened on a saved annotation still gets a
 * sensible anchor.
 */
export function getPopupSelectionAnchor(
  event: {
    doc?: Document;
    reader?: ReaderLike;
    params?: { annotation?: { text?: string; position?: unknown } };
  },
  fallbackDoc?: Document | null,
): SelectionAnchor | null {
  const reader = event.reader || null;
  const doc = event.doc || getReaderDocument(reader) || fallbackDoc || null;
  const iframeDoc = doc || getReaderDocument(reader);
  const text = String(event.params?.annotation?.text || "").trim();

  if (iframeDoc) {
    // A live selection is the most accurate anchor.
    const live = text ? getSelectionAnchor(iframeDoc) : null;
    if (live) return { ...live, text: text || live.text };
  }
  if (!text || !iframeDoc) return null;

  const position = event.params?.annotation?.position as
    | { pageIndex?: number; rects?: number[][] }
    | undefined;
  const view = reader?._internalReader?._lastView;
  if (position && view?.getClientRectForPopup) {
    try {
      const rect = view.getClientRectForPopup(position);
      if (
        Array.isArray(rect) &&
        rect.length >= 4 &&
        rect.every((value) => Number.isFinite(value))
      ) {
        return {
          doc: iframeDoc,
          text,
          rect: {
            left: rect[0],
            top: rect[1],
            right: rect[0] + rect[2],
            bottom: rect[1] + rect[3],
          },
        };
      }
    } catch {
      // Fall through to the viewport centre.
    }
  }
  const width = iframeDoc.defaultView?.innerWidth || 0;
  const height = iframeDoc.defaultView?.innerHeight || 0;
  return {
    doc: iframeDoc,
    text,
    rect: {
      left: width / 2 - 40,
      right: width / 2 + 40,
      top: Math.max(40, height / 3),
      bottom: Math.max(60, height / 3 + 20),
    },
  };
}

/**
 * Text of saved annotations, keyed by annotation item keys (the ids handed to
 * `createAnnotationContextMenu`).
 */
export function collectAnnotationText(
  reader: ReaderLike | null,
  ids: readonly string[] | undefined,
): string {
  const attachment = getReaderAttachment(reader);
  if (!attachment || !ids?.length) return "";
  const parts: string[] = [];
  for (const key of ids) {
    try {
      const annotation = Zotero.Items.getByLibraryAndKey(
        attachment.libraryID,
        key,
      );
      if (!annotation) continue;
      const text = String(annotation.annotationText || "").trim();
      const comment = String(annotation.annotationComment || "").trim();
      if (text && comment) parts.push(`${text}\n\n（批注：${comment}）`);
      else if (text || comment) parts.push(text || comment);
    } catch {
      // Skip unreadable annotation items.
    }
  }
  return parts.join("\n\n---\n\n");
}
