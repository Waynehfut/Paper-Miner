import type { PaperMeta } from "../types";
import { getPref } from "./prefs";

/** DOI as stored on a Zotero item, or "" when unavailable. */
export function getItemDOI(item: Zotero.Item | null | undefined): string {
  if (!item || !item.isRegularItem()) return "";
  try {
    const doi = String(item.getField("DOI") || "").trim();
    if (doi) return normalizeDOI(doi);
  } catch {
    // Some item types do not have a DOI field.
  }
  try {
    const extra = String(item.getField("extra") || "");
    const match = extra.match(/^\s*DOI\s*:\s*(10\.[^\s]+)\s*$/im);
    if (match) return normalizeDOI(match[1]);
  } catch {
    // ignore
  }
  return "";
}

export function normalizeDOI(doi: string): string {
  return doi
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim();
}

/** Journal / proceedings title used for EasyScholar lookups. */
export function getItemPublication(
  item: Zotero.Item | null | undefined,
): string {
  if (!item || !item.isRegularItem()) return "";
  const itemType = Zotero.ItemTypes.getName(item.itemTypeID);
  const fields =
    itemType === "conferencePaper" || itemType === "preprint"
      ? ["publicationTitle", "conferenceName", "proceedingsTitle"]
      : ["publicationTitle", "conferenceName", "proceedingsTitle"];
  for (const field of fields) {
    try {
      const value = String(item.getField(field) || "").trim();
      if (value) return value;
    } catch {
      // Field not valid for this item type.
    }
  }
  return "";
}

/**
 * Candidate journal names for EasyScholar. Chinese records sometimes store
 * the official title in `publicationTitle` but an abbreviation in
 * `journalAbbreviation`; both are worth trying when one is not indexed.
 */
export function getItemPublicationCandidates(
  item: Zotero.Item | null | undefined,
): string[] {
  if (!item || !item.isRegularItem()) return [];
  const names: string[] = [];
  const add = (value: unknown) => {
    const text = String(value || "")
      .trim()
      .replace(/\s+/g, " ");
    if (text && !names.includes(text)) names.push(text);
  };
  add(getItemPublication(item));
  for (const field of [
    "journalAbbreviation",
    "conferenceName",
    "proceedingsTitle",
  ]) {
    try {
      add(item.getField(field));
    } catch {
      // Field not valid for this item type.
    }
  }
  // "期刊名（中英文版）" / "Journal Name (English Edition)" style suffixes.
  for (const name of [...names]) {
    const stripped = name.replace(/\s*[（(][^）)]{0,40}[）)]\s*$/, "").trim();
    if (stripped && !names.includes(stripped)) add(stripped);
  }
  return names;
}

export function getItemTitle(item: Zotero.Item | null | undefined): string {
  if (!item) return "";
  try {
    return String(item.getField("title") || item.getDisplayTitle?.() || "");
  } catch {
    return "";
  }
}

export function getItemMeta(item: Zotero.Item): PaperMeta {
  const creators = item.getCreators?.() || [];
  const authors = creators
    .filter((creator: any) => creator.creatorType === "author")
    .map((creator: any) =>
      creator.name
        ? creator.name
        : [creator.firstName, creator.lastName].filter(Boolean).join(" "),
    )
    .join(", ");
  return {
    itemID: item.id,
    key: item.key,
    title: getItemTitle(item),
    doi: getItemDOI(item),
    journal: getItemPublication(item),
    year: (() => {
      try {
        return String(item.getField("date") || "").slice(0, 4);
      } catch {
        return "";
      }
    })(),
    authors,
    abstract: (() => {
      try {
        return String(item.getField("abstractNote") || "");
      } catch {
        return "";
      }
    })(),
    itemType: Zotero.ItemTypes.getName(item.itemTypeID),
  };
}

export function isPaperItem(item: Zotero.Item | null | undefined): boolean {
  if (!item || !item.isRegularItem()) return false;
  const type = Zotero.ItemTypes.getName(item.itemTypeID);
  return [
    "journalArticle",
    "conferencePaper",
    "preprint",
    "bookSection",
    "report",
    "thesis",
    "manuscript",
  ].includes(type);
}

/** Find the best PDF attachment for an item (or the item itself). */
export async function findPDFAttachment(
  item: Zotero.Item | null | undefined,
): Promise<Zotero.Item | null> {
  if (!item) return null;
  if (item.isAttachment()) {
    return item.attachmentContentType === "application/pdf" ? item : null;
  }
  if (!item.isRegularItem()) return null;
  const ids = item.getAttachments?.() || [];
  let fallback: Zotero.Item | null = null;
  for (const id of ids) {
    const attachment = await Zotero.Items.getAsync(id);
    if (attachment?.attachmentContentType === "application/pdf") {
      return attachment;
    }
    if (attachment?.isAttachment()) fallback = attachment;
  }
  return fallback?.attachmentContentType === "application/pdf"
    ? fallback
    : null;
}

/** The reader item for a PDF attachment, or the parent regular item. */
export function getRegularItemForReader(
  readerItem: Zotero.Item | null | undefined,
): Zotero.Item | null {
  if (!readerItem) return null;
  if (readerItem.isRegularItem()) return readerItem;
  if (readerItem.isAttachment()) {
    try {
      const parent = readerItem.parentItem;
      if (parent?.isRegularItem()) return parent;
    } catch {
      // ignore
    }
  }
  return readerItem.isRegularItem() ? readerItem : null;
}

/** Whether AI features are allowed for the item (regular paper with PDF). */
export function canUseAIFeatures(
  item: Zotero.Item | null | undefined,
): boolean {
  return Boolean(item && item.isRegularItem() && isPaperItem(item));
}

export function isSummaryAutoEnabled(): boolean {
  return Boolean(getPref("summaryAuto"));
}
