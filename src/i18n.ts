// UI translations.
//
// Catalogs live in src/locales/*.json and are shared with the Rust side
// (src-tauri/src/i18n.rs reads the same file for tray labels and errors).
// English is the reference catalog: it defines the set of keys, and any key
// missing from another language falls back to it.
//
// Adding a language: create src/locales/<code>.json and register it in
// `catalogs` below. Plural forms use Intl.PluralRules categories
// (`.one`, `.few`, `.many`, `.other`), so languages with richer plural rules
// need no code changes.

import en from "./locales/en.json";

export type MessageKey = keyof typeof en;

/** Keys with plural variants, without the `.one` / `.other` suffix. */
type PluralBase = {
  [K in MessageKey]: K extends `${infer Base}.other` ? Base : never;
}[MessageKey];

type Params = Record<string, string | number>;

const catalogs: Record<string, Partial<Record<string, string>>> = { en };

function resolveLocale(): string {
  const preferred = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of preferred) {
    const base = tag.toLowerCase().split("-")[0];
    if (base && base in catalogs) return base;
  }
  return "en";
}

export const locale = resolveLocale();
const messages: Partial<Record<string, string>> = catalogs[locale] ?? en;

export function t(key: MessageKey, params?: Params): string {
  return format(messages[key] ?? en[key], params);
}

export function tPlural(base: PluralBase, count: number, params?: Params): string {
  const category = new Intl.PluralRules(locale).select(count);
  const key = `${base}.${category}`;
  const template = messages[key] ?? messages[`${base}.other`] ?? en[`${base}.other` as MessageKey];
  return format(template, { count, ...params });
}

function format(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
