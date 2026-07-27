import type { Dictionary } from "./dictionaries";

type Paths<T> = T extends string
  ? never
  : { [K in keyof T & string]: T[K] extends string ? K : `${K}.${Paths<T[K]>}` }[keyof T & string];

// TranslationKey enforces every t() call site against en's shape at compile time.
// The `(string & {})` union keeps that autocomplete/checking for literal keys while still
// accepting a dynamically-built path (e.g. `connections.provider.${provider}`), which can't
// be a literal type — those calls just lose compile-time key validation.
export type TranslationKey = Paths<Dictionary> | (string & {});

export type TranslationVars = Record<string, string | number>;

export function getByPath(dict: Dictionary, path: string): string {
  const value = path.split(".").reduce<unknown>((node, key) => {
    if (node && typeof node === "object" && key in node) {
      return (node as Record<string, unknown>)[key];
    }
    return undefined;
  }, dict);
  return typeof value === "string" ? value : path;
}

export function interpolate(template: string, vars?: TranslationVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}
