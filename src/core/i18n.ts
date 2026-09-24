import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Lightweight i18n for the extension host.
 *
 * The locale follows VS Code's display language (`vscode.env.language`,
 * e.g. `en`, `zh-cn`). Translations live in `l10n/bundle.l10n.<locale>.json`
 * at the package root, keyed by the original English string. When the
 * current locale has no bundle (or the string is missing from it), the
 * original English text is returned unchanged.
 */

let bundle: Record<string, string> | undefined;
let initialized = false;

/** Primary tag of a locale string, e.g. `zh-cn` -> `zh`, `pt-br` -> `pt`. */
function primaryTag(locale: string): string {
  return locale.split('-')[0].toLowerCase();
}

/**
 * Must be called once from activate() before any t() usage.
 * @param extensionRoot Absolute path of the extension folder.
 */
export function initI18n(extensionRoot: string): void {
  initialized = true;
  bundle = {};
  const locale = (vscode.env.language || 'en').toLowerCase();
  const l10nDir = path.join(extensionRoot, 'l10n');
  for (const candidate of [locale, primaryTag(locale)]) {
    const file = path.join(l10nDir, `bundle.l10n.${candidate}.json`);
    try {
      if (fs.existsSync(file)) {
        bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
        return;
      }
    } catch {
      // Fall through to the next candidate.
    }
  }
}

/** True when VS Code is running in a locale other than English. */
export function isEnglishLocale(): boolean {
  return primaryTag(vscode.env.language || 'en') === 'en';
}

/**
 * Translate a user-facing string. The key is the English source text;
 * supports `{0}`, `{1}`... placeholders filled from the extra arguments.
 */
export function t(key: string, ...args: unknown[]): string {
  let text: string = bundle?.[key] ?? key;
  args.forEach((arg, i) => {
    text = text.replace(new RegExp(`\\{${i}\\}`, 'g'), String(arg));
  });
  return text;
}
