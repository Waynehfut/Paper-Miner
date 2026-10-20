import { config } from "../../package.json";

/**
 * Localized string lookup with a fallback used when an ftl key is missing.
 * This deliberately accepts plain strings so feature modules can be written
 * without regenerating Fluent typings on every change.
 */
export function t(
  key: string,
  fallback?: string,
  args?: Record<string, unknown>,
): string {
  try {
    const l10n = addon?.data?.locale?.current;
    if (!l10n) return fallback ?? key;
    const pattern = l10n.formatMessagesSync([
      { id: `${config.addonRef}-${key}`, args },
    ])[0] as { value?: string } | undefined;
    return pattern?.value || fallback || key;
  } catch {
    return fallback ?? key;
  }
}
