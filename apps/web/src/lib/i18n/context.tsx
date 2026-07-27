"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { defaultLocale, locales, type Locale } from "./locales";
import { dictionaries } from "./dictionaries";
import { getByPath, interpolate, type TranslationKey, type TranslationVars } from "./paths";

interface I18nValue {
  locale: Locale;
  t: (key: TranslationKey, vars?: TranslationVars) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

// Matches the browser's language list against our supported locales: exact tag first
// (e.g. "en-GB" against a hypothetical "en-GB" entry), then base language (the "en" in
// "en-GB" against a supported "en"). Falls back to defaultLocale if nothing matches.
function detectLocale(): Locale {
  for (const raw of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    const lang = raw.toLowerCase();
    const exact = locales.find((l) => l.toLowerCase() === lang);
    if (exact) return exact;
    const base = lang.split("-")[0];
    const baseMatch = locales.find((l) => l.toLowerCase() === base);
    if (baseMatch) return baseMatch;
  }
  return defaultLocale;
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocale] = useState<Locale>(defaultLocale);
  const detected = useRef(false);

  useEffect(() => {
    if (detected.current) return;
    detected.current = true;
    setLocale(detectLocale());
  }, []);

  const t = useCallback(
    (key: TranslationKey, vars?: TranslationVars) => {
      const dict = dictionaries[locale] ?? dictionaries[defaultLocale];
      return interpolate(getByPath(dict, key), vars);
    },
    [locale],
  );

  return <I18nContext.Provider value={{ locale, t }}>{children}</I18nContext.Provider>;
}

export function useTranslation() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useTranslation must be used within I18nProvider");
  return ctx;
}
