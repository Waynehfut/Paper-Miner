import type {
  BadgeTone,
  JournalBadgeCategory,
  JournalRankData,
  RankBadge,
} from "../../types";

export type JournalFieldSource = "official" | "select" | "both";

export interface JournalFieldDefinition {
  key: string;
  /** Chinese label used in preferences and badge tooltips. */
  label: string;
  /** Compact category label shown inside the badge. */
  shortLabel: string;
  source: JournalFieldSource;
  /** Field names to try, in order (officialRank.all / officialRank.select). */
  fields: string[];
  category: JournalBadgeCategory;
  /** Whether this field indicates an early-warning journal. */
  warning?: boolean;
  /** Default enabled in preferences. */
  defaultOn?: boolean;
}

/**
 * Supported EasyScholar fields. Keep keys stable: they are persisted in the
 * `journalFields` preference (comma separated).
 *
 * Field order is also the display order. Categories matter for the badge
 * styling: quartiles, metrics, Chinese core lists, indexes, rankings and
 * warnings each get a different colour family.
 */
export const JOURNAL_FIELDS: JournalFieldDefinition[] = [
  {
    key: "sciUp",
    label: "中科院分区（升级版）",
    shortLabel: "中科院",
    source: "select",
    fields: ["sciUp"],
    category: "cas",
    defaultOn: true,
  },
  {
    key: "sciUpTop",
    label: "中科院 TOP",
    shortLabel: "中科院",
    source: "select",
    fields: ["sciUpTop"],
    category: "cas",
    defaultOn: true,
  },
  {
    key: "sci",
    label: "JCR 分区",
    shortLabel: "JCR",
    source: "select",
    fields: ["sci"],
    category: "sci",
    defaultOn: true,
  },
  {
    key: "sciBase",
    label: "中科院分区（基础版）",
    shortLabel: "基础版",
    source: "select",
    fields: ["sciBase"],
    category: "cas",
  },
  {
    key: "sciif",
    label: "影响因子 IF",
    shortLabel: "IF",
    source: "official",
    fields: ["sciif"],
    category: "sci",
    defaultOn: true,
  },
  {
    key: "sciif5",
    label: "5 年影响因子",
    shortLabel: "5年IF",
    source: "select",
    fields: ["sciif5"],
    category: "sci",
  },
  {
    key: "jci",
    label: "JCI",
    shortLabel: "JCI",
    source: "official",
    fields: ["jci"],
    category: "sci",
  },
  {
    key: "cssci",
    label: "CSSCI（南大核心）",
    shortLabel: "CSSCI",
    source: "official",
    fields: ["cssci"],
    category: "index",
    defaultOn: true,
  },
  {
    key: "pku",
    label: "北大核心",
    shortLabel: "北大核心",
    source: "official",
    fields: ["pku"],
    category: "index",
    defaultOn: true,
  },
  {
    key: "cscd",
    label: "CSCD",
    shortLabel: "CSCD",
    source: "official",
    fields: ["cscd"],
    category: "index",
    defaultOn: true,
  },
  {
    key: "zhongguokejihexin",
    label: "中国科技核心期刊",
    shortLabel: "科技核心",
    source: "official",
    fields: ["zhongguokejihexin"],
    category: "index",
    defaultOn: true,
  },
  {
    key: "cju",
    label: "中国科技期刊卓越行动计划",
    shortLabel: "梯队",
    source: "official",
    fields: ["cju"],
    category: "level",
    defaultOn: true,
  },
  {
    key: "eii",
    label: "EI 收录",
    shortLabel: "EI",
    source: "official",
    fields: ["eii"],
    category: "open",
  },
  {
    key: "ahci",
    label: "AHCI",
    shortLabel: "AHCI",
    source: "official",
    fields: ["ahci"],
    category: "open",
  },
  {
    key: "ssci",
    label: "SSCI",
    shortLabel: "SSCI",
    source: "official",
    fields: ["ssci"],
    category: "open",
  },
  {
    key: "esi",
    label: "ESI 学科",
    shortLabel: "ESI",
    source: "official",
    fields: ["esi"],
    category: "open",
  },
  {
    key: "ccf",
    label: "CCF",
    shortLabel: "CCF",
    source: "official",
    fields: ["ccf"],
    category: "level",
  },
  {
    key: "ajg",
    label: "AJG (ABS)",
    shortLabel: "AJG",
    source: "official",
    fields: ["ajg"],
    category: "level",
  },
  {
    key: "abdc",
    label: "ABDC",
    shortLabel: "ABDC",
    source: "official",
    fields: ["abdc"],
    category: "level",
  },
  {
    key: "ft50",
    label: "FT50",
    shortLabel: "FT50",
    source: "official",
    fields: ["ft50"],
    category: "level",
  },
  {
    key: "utd24",
    label: "UTD24",
    shortLabel: "UTD24",
    source: "official",
    fields: ["utd24"],
    category: "level",
  },
  {
    key: "fms",
    label: "FMS",
    shortLabel: "FMS",
    source: "official",
    fields: ["fms"],
    category: "level",
  },
  {
    key: "xr",
    label: "新锐分区",
    shortLabel: "新锐",
    source: "official",
    fields: ["xr"],
    category: "cas",
  },
  {
    key: "sciWarning",
    label: "中科院预警",
    shortLabel: "中科院",
    source: "both",
    fields: ["sciWarning", "sciwarn"],
    category: "danger",
    warning: true,
    defaultOn: true,
  },
  {
    key: "xrWarn",
    label: "新锐预警",
    shortLabel: "新锐",
    source: "both",
    fields: ["xrWarn"],
    category: "danger",
    warning: true,
  },
];

export const DEFAULT_ENABLED_FIELDS = JOURNAL_FIELDS.filter(
  (field) => field.defaultOn,
).map((field) => field.key);

export const DEFAULT_JOURNAL_FIELDS_VALUE = DEFAULT_ENABLED_FIELDS.join(",");

const CATEGORY_ORDER: Record<JournalBadgeCategory, number> = {
  cas: 0,
  sci: 1,
  index: 2,
  open: 3,
  level: 4,
  danger: 9,
};

const EMPTY_WARNING_VALUES = new Set([
  "",
  "无",
  "非预警",
  "未预警",
  "否",
  "none",
  "no",
  "false",
  "0",
  "-",
  "null",
  "n/a",
]);

export function isWarningValue(value: string | undefined | null): boolean {
  if (value === undefined || value === null) return false;
  return !EMPTY_WARNING_VALUES.has(String(value).trim().toLowerCase());
}

/**
 * Read a single value from one EasyScholar map. Keys are matched
 * case-insensitively because the upstream payload mixes `sciIf` / `sciif`
 * and `sciUp` / `sciup` styles between API versions.
 */
function pickFieldValue(
  map: Record<string, string> | undefined,
  field: string,
): string {
  if (!map) return "";
  for (const key of Object.keys(map)) {
    if (key !== field && key.toLowerCase() !== field.toLowerCase()) continue;
    const value = map[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

/** Read a field from a parsed EasyScholar payload. */
export function getFieldValue(
  data: JournalRankData | undefined,
  definition: JournalFieldDefinition,
): string {
  if (!data) return "";
  // Prefer the documented source, then fall back to the other map so that a
  // field that only exists in `officialRank.all` (or only in `select`) is
  // still displayed instead of silently disappearing.
  const maps =
    definition.source === "select"
      ? [data.select, data.official]
      : [data.official, data.select];
  for (const field of definition.fields) {
    for (const map of maps) {
      const value = pickFieldValue(map, field);
      if (value) return value;
    }
  }
  return "";
}

function normalizeQuartile(value: string): string {
  const match = String(value || "").match(/[1-4]区(?:\s*TOP)?/i);
  if (match) return match[0].toUpperCase().replace(/\s+/g, " ");
  return value;
}

/** Format a raw EasyScholar value for compact display inside a badge. */
export function formatFieldValue(
  definition: JournalFieldDefinition,
  value: string,
): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  switch (definition.key) {
    case "sciUp":
    case "sciBase":
      return normalizeQuartile(raw);
    case "sciUpTop":
      return "TOP";
    case "sci":
      return raw.toUpperCase();
    case "xr":
      return normalizeQuartile(raw);
    case "ccf":
      return raw.toUpperCase();
    case "cju": {
      const match = raw.match(/T[1-3]/i);
      return match ? match[0].toUpperCase() : raw;
    }
    case "cscd":
      return /核心/i.test(raw) ? raw : "收录";
    case "cssci":
    case "pku":
    case "zhongguokejihexin":
    case "eii":
    case "ahci":
    case "ssci":
      return "收录";
    case "ft50":
    case "utd24":
      return /^(1|y|yes|true|是)$/i.test(raw) ? "收录" : raw;
    case "sciWarning":
    case "xrWarn":
      return "预警";
    default:
      return raw;
  }
}

function quartileTone(value: string): BadgeTone {
  const normalized = value.toUpperCase().replace(/\s+/g, "");
  if (normalized.includes("Q1") || normalized.includes("1区")) return "good";
  if (normalized.includes("Q2") || normalized.includes("2区")) return "info";
  if (normalized.includes("Q3") || normalized.includes("3区")) return "neutral";
  if (normalized.includes("Q4") || normalized.includes("4区")) return "warn";
  if (normalized.includes("TOP")) return "good";
  return "neutral";
}

export function buildBadge(
  definition: JournalFieldDefinition,
  rawValue: string,
): RankBadge {
  const value = formatFieldValue(definition, rawValue);
  let tone: BadgeTone = "neutral";
  if (definition.category === "danger") {
    tone = "bad";
  } else if (definition.category === "cas") {
    tone = quartileTone(rawValue);
  } else if (definition.category === "sci") {
    tone = "info";
  } else if (definition.category === "index") {
    tone = "good";
  } else if (definition.category === "open") {
    tone = "info";
  } else if (definition.category === "level") {
    tone = "neutral";
  }
  return {
    key: definition.key,
    label: definition.label,
    shortLabel: definition.shortLabel,
    value,
    tone,
    category: definition.category,
  };
}

function getDefinition(key: string): JournalFieldDefinition {
  const definition = JOURNAL_FIELDS.find((field) => field.key === key);
  if (!definition) throw new Error(`Unknown journal field: ${key}`);
  return definition;
}

/** Build badges for the fields selected in preferences. */
export function buildBadges(
  data: JournalRankData | undefined,
  enabledFieldKeys: string[],
): RankBadge[] {
  if (!data) return [];
  const enabled = new Set(enabledFieldKeys);
  const badges: RankBadge[] = [];
  for (const definition of JOURNAL_FIELDS) {
    if (!enabled.has(definition.key)) continue;
    const value = getFieldValue(data, definition);
    if (!value) continue;
    badges.push(buildBadge(definition, value));
  }

  // Merge the TOP flag into the CAS quartile badge instead of rendering two
  // nearly-identical pills.
  const sciUp = badges.find((badge) => badge.key === "sciUp");
  const sciUpTop = badges.find((badge) => badge.key === "sciUpTop");
  if (sciUp) {
    const rawTop = getFieldValue(data, getDefinition("sciUpTop"));
    if (
      (sciUpTop || isWarningValue(rawTop)) &&
      /top/i.test(rawTop || "") &&
      !/top/i.test(sciUp.value)
    ) {
      sciUp.value = `${sciUp.value} TOP`;
    }
    if (sciUpTop) badges.splice(badges.indexOf(sciUpTop), 1);
  }

  badges.sort(
    (a, b) =>
      CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] ||
      JOURNAL_FIELDS.findIndex((field) => field.key === a.key) -
        JOURNAL_FIELDS.findIndex((field) => field.key === b.key),
  );
  return badges;
}

export function hasWarning(
  data: JournalRankData | undefined,
  enabledFieldKeys: string[],
): boolean {
  if (!data) return false;
  const enabled = new Set(enabledFieldKeys);
  return JOURNAL_FIELDS.filter(
    (field) => field.warning && enabled.has(field.key),
  ).some((field) => isWarningValue(getFieldValue(data, field)));
}

/** Compact text for the item-tree column. Mirrors the same badges as the item
 *  pane, so every enabled field that appears in the pane also appears here. */
export function formatShortText(
  data: JournalRankData | undefined,
  enabledFieldKeys: string[],
): string {
  if (!data) return "";
  const parts: string[] = [];
  for (const badge of buildBadges(data, enabledFieldKeys)) {
    let text = "";
    switch (badge.category) {
      case "danger":
        text = "预警";
        break;
      case "index":
      case "open":
        text =
          badge.value === "收录"
            ? badge.shortLabel
            : `${badge.shortLabel} ${badge.value}`;
        break;
      case "level":
        text = `${badge.shortLabel} ${badge.value}`;
        break;
      case "cas":
        text =
          badge.key === "sciUp" || badge.key === "sciBase"
            ? badge.value
            : `${badge.shortLabel} ${badge.value}`;
        break;
      case "sci":
        text =
          badge.key === "sci"
            ? badge.value
            : `${badge.shortLabel} ${badge.value}`;
        break;
      default:
        text = badge.value;
        break;
    }
    if (text && !parts.includes(text)) parts.push(text);
  }
  return parts.join(" · ");
}

/** Journal title normalization before querying/caching. */
export function normalizePublicationName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.。;；,，]+$/g, "")
    .trim();
}
