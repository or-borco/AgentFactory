export type TermEntry = { key: string; value: string };
export type TextEntry = { text: string };
export type ArchEntry = { title: string; desc: string };
export type SystemEntry = { name: string; type: string; notes: string };

export interface TermsCategory {
  id: string;
  label: string;
  type: "terms";
  entries: TermEntry[];
}
export interface TextCategory {
  id: string;
  label: string;
  type: "text";
  entries: [TextEntry] | [];
}
export interface EntriesCategory {
  id: string;
  label: string;
  type: "entries";
  entries: ArchEntry[];
}
export interface SystemsCategory {
  id: string;
  label: string;
  type: "systems";
  entries: SystemEntry[];
}

export type ContextCategory =
  | TermsCategory
  | TextCategory
  | EntriesCategory
  | SystemsCategory;

export interface SharedContextData {
  categories: ContextCategory[];
}

function isValidCategory(cat: unknown): cat is ContextCategory {
  if (!cat || typeof cat !== "object") return false;
  const c = cat as Record<string, unknown>;
  if (typeof c.id !== "string" || typeof c.label !== "string") return false;
  if (!Array.isArray(c.entries)) return false;
  return (
    c.type === "terms" ||
    c.type === "text" ||
    c.type === "entries" ||
    c.type === "systems"
  );
}

export function parseSharedContext(raw: string): SharedContextData {
  if (!raw || raw.trim() === "") return { categories: [] };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.categories)) {
      const valid = (parsed.categories as unknown[]).filter(isValidCategory);
      if (valid.length > 0) return { categories: valid };
    }
  } catch {
    // legacy plain text — fall through
  }
  return {
    categories: [
      { id: "general", label: "General", type: "text", entries: [{ text: raw.trim() }] },
    ],
  };
}

function formatCategory(cat: ContextCategory): string {
  const lines: string[] = [`### ${cat.label}`];
  if (cat.type === "terms") {
    for (const e of cat.entries) {
      if (e.key) lines.push(`- **${e.key}**: ${e.value}`);
    }
  } else if (cat.type === "text") {
    const text = cat.entries[0]?.text;
    if (text) lines.push(text);
  } else if (cat.type === "entries") {
    for (const e of cat.entries) {
      if (e.title) lines.push(`- **${e.title}**: ${e.desc}`);
    }
  } else if (cat.type === "systems") {
    for (const e of cat.entries) {
      if (e.name) lines.push(`- **${e.name}** (${e.type}): ${e.notes}`);
    }
  }
  return lines.join("\n");
}

/**
 * Format a team's sharedContext string as a Markdown block suitable for
 * prepending to an agent's system prompt. Returns an empty string when
 * there is no meaningful context to inject.
 */
export function formatSharedContextForPrompt(raw: string): string {
  const { categories } = parseSharedContext(raw);
  const nonEmpty = categories.filter((cat) => {
    if (cat.type === "text") return (cat.entries[0]?.text ?? "").trim() !== "";
    return cat.entries.length > 0;
  });
  if (nonEmpty.length === 0) return "";
  const body = nonEmpty.map(formatCategory).join("\n\n");
  return `## Team Context\n\n${body}\n\n---\n\n`;
}
