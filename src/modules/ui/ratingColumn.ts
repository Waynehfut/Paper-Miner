/**
 * Five-star rating column backed by the Zotero `rate` Extra field.
 *
 * This mirrors the EndNote-style rating used by zotero-style: the value is
 * stored as `rate: 1..5` in the item's Extra field, so it survives restarts,
 * can be exported, and does not pollute the tag selector. Clicking a star sets
 * the rating; clicking the current rating clears it.
 */

import { config } from "../../../package.json";
import { htmlEl } from "../journal/dom";
import { t } from "../../utils/i18n";
import { errorToString, log } from "../../utils/log";
import { toast } from "../../utils/ui";

export const RATING_COLUMN_KEY = "paperminerRating";
export const RATING_FIELD = "rate";
export const MAX_RATING = 5;

let registeredKey: string | false | null = null;

function getExtra(item: Zotero.Item): string {
  try {
    return String(item.getField("extra") || "");
  } catch {
    return "";
  }
}

/** Read `rate: N` from the Extra field. */
export function getRating(item: Zotero.Item | null | undefined): number {
  if (!item) return 0;
  const match = /^\s*rate\s*:\s*(\d+)\s*$/im.exec(getExtra(item));
  if (!match) return 0;
  return Math.min(MAX_RATING, Math.max(0, Number.parseInt(match[1], 10) || 0));
}

function hasChildItem(item: unknown): boolean {
  const ref = item as { isRegularItem?: () => boolean } | null;
  return Boolean(
    ref && typeof ref.isRegularItem === "function" && !ref.isRegularItem(),
  );
}

/** Write `rate: N` into Extra while preserving all other Extra fields. */
export async function setRating(
  item: Zotero.Item,
  rating: number,
): Promise<number> {
  const value = Math.min(MAX_RATING, Math.max(0, Math.round(rating)));
  const lines = getExtra(item)
    .split(/\r?\n/)
    .filter((line) => !/^\s*rate\s*:\s*\d+\s*$/i.test(line));
  if (value > 0) {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push(`${RATING_FIELD}: ${value}`);
  }
  await item.setField("extra", lines.join("\n"));
  await item.saveTx();
  refreshRatingColumn();
  return value;
}

async function setRatingByID(itemID: number, rating: number): Promise<void> {
  try {
    const item = Zotero.Items.get(itemID);
    if (!item || !item.isRegularItem()) return;
    const next = getRating(item) === rating ? 0 : rating;
    await setRating(item, next);
    toast(
      next > 0
        ? t("rating-set", "已评分 { count } 星", { count: next })
        : t("rating-cleared", "已清除评分"),
      "success",
    );
  } catch (error) {
    log("set rating failed:", errorToString(error));
    toast(t("rating-failed", "评分失败"), "fail");
  }
}

function ratingDataProvider(item: Zotero.Item): string {
  if (
    !item ||
    typeof item.isRegularItem !== "function" ||
    !item.isRegularItem()
  ) {
    return "";
  }
  return `${getRating(item)}|${item.id}`;
}

function paintStars(container: HTMLElement, rating: number): void {
  const stars = Array.from(
    container.querySelectorAll(".pm-rating-star"),
  ) as HTMLElement[];
  stars.forEach((star, index) => {
    const filled = index < rating;
    star.textContent = "⭐️";
    star.classList.toggle("pm-rating-star-filled", filled);
  });
}

function renderRatingCell(
  _index: number,
  data: string,
  column: { className?: string },
  _isFirstColumn: boolean,
  doc: Document,
): HTMLElement {
  const cell = htmlEl(doc, "span", {
    class: `cell ${column?.className || ""} pm-rating-cell`.trim(),
  });
  const match = /^(\d+)\|(\d+)$/.exec(String(data || ""));
  if (!match) return cell;
  const rating = Math.min(MAX_RATING, Number.parseInt(match[1], 10) || 0);
  const itemID = Number(match[2]);
  const stars = htmlEl(doc, "span", { class: "pm-rating-stars" });
  for (let index = 1; index <= MAX_RATING; index += 1) {
    const star = htmlEl(doc, "span", {
      class: "pm-rating-star",
      text: "⭐️",
      attrs: {
        role: "button",
        tabindex: "0",
        "aria-label": t("rating-star", "评为 { count } 星", { count: index }),
        title: t("rating-star", "评为 { count } 星", { count: index }),
      },
    });
    star.classList.toggle("pm-rating-star-filled", index <= rating);
    star.addEventListener("mouseenter", () => paintStars(cell, index));
    star.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void setRatingByID(itemID, index);
    });
    star.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (key === "Enter" || key === " ") {
        event.preventDefault();
        event.stopPropagation();
        void setRatingByID(itemID, index);
      }
    });
    stars.appendChild(star);
  }
  cell.addEventListener("mouseleave", () => paintStars(cell, rating));
  cell.appendChild(stars);
  return cell;
}

export function refreshRatingColumn(): void {
  if (hasChildItem(Zotero.getActiveZoteroPane()?.getSelectedItems?.()?.[0])) {
    return;
  }
  try {
    Zotero.ItemTreeManager.refreshColumns();
  } catch (error) {
    log("refresh rating column failed:", errorToString(error));
  }
}

export async function registerRatingColumn(): Promise<void> {
  if (registeredKey) return;
  if (!Zotero.ItemTreeManager?.registerColumn) return;
  try {
    const key = await Zotero.ItemTreeManager.registerColumn({
      dataKey: RATING_COLUMN_KEY,
      label: t("rating-column-label", "评分"),
      pluginID: config.addonID,
      enabledTreeIDs: ["main"],
      width: "96",
      minWidth: 78,
      showInColumnPicker: true,
      zoteroPersist: ["width", "hidden", "sortDirection"],
      dataProvider: ratingDataProvider,
      renderCell: renderRatingCell,
    });
    if (!key) {
      log("registerRatingColumn returned false");
      return;
    }
    registeredKey = key;
  } catch (error) {
    log("registerRatingColumn failed:", errorToString(error));
  }
}

export async function unregisterRatingColumn(): Promise<void> {
  if (!registeredKey) return;
  try {
    await Zotero.ItemTreeManager.unregisterColumn(registeredKey);
  } catch (error) {
    log("unregisterRatingColumn failed:", errorToString(error));
  }
  registeredKey = null;
}

export const __testing = { ratingDataProvider, renderRatingCell };
