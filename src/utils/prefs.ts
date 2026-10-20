import { config } from "../../package.json";

type PluginPrefsMap = _ZoteroTypes.Prefs["PluginPrefsMap"];

const PREFS_PREFIX = config.prefsPrefix;

/**
 * Get preference value.
 * Wrapper of `Zotero.Prefs.get`.
 * @param key
 */
export function getPref<K extends keyof PluginPrefsMap>(key: K) {
  return Zotero.Prefs.get(`${PREFS_PREFIX}.${key}`, true) as PluginPrefsMap[K];
}

/**
 * Set preference value.
 * Wrapper of `Zotero.Prefs.set`.
 * @param key
 * @param value
 */
export function setPref<K extends keyof PluginPrefsMap>(
  key: K,
  value: PluginPrefsMap[K],
) {
  return Zotero.Prefs.set(`${PREFS_PREFIX}.${key}`, value, true);
}

/**
 * Clear preference value.
 * Wrapper of `Zotero.Prefs.clear`.
 * @param key
 */
export function clearPref(key: string) {
  return Zotero.Prefs.clear(`${PREFS_PREFIX}.${key}`, true);
}

/**
 * Read a numeric preference with validation and clamping. This protects the
 * runtime from values typed into a text field (e.g. "abc" or a huge number)
 * and keeps provider requests within sane bounds.
 */
export function getNumberPref(
  key: keyof PluginPrefsMap,
  fallback: number,
  min: number,
  max: number,
  integer = false,
): number {
  const raw = Number(getPref(key));
  if (!Number.isFinite(raw)) return fallback;
  const clamped = Math.min(max, Math.max(min, raw));
  return integer ? Math.round(clamped) : clamped;
}
