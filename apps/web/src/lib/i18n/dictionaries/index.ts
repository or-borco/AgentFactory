import en, { type Dictionary } from "./en";
import type { Locale } from "../locales";

// Every locale is typechecked against Dictionary (en's shape), so a locale missing
// a key added here fails the build instead of silently falling back at runtime.
export const dictionaries: Record<Locale, Dictionary> = {
  en,
};

export type { Dictionary };
