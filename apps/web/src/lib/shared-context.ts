// Pure TypeScript utility module for structured shared-context format.
// No React, no UI dependencies.

export type TermEntry = { key: string; value: string };
export type TextEntry = { text: string };
export type ArchEntry = { title: string; desc: string };
export type SystemEntry = { name: string; type: string; notes: string };

export type CategoryType = "terms" | "text" | "entries" | "systems";

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

/**
 * Validate that an unknown value is a well-formed ContextCategory.
 * Categories that fail validation are filtered out rather than crashing render.
 */
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

/**
 * Parse a raw shared context string into structured data.
 *
 * - If raw is valid JSON with a `categories` array, validate each category and
 *   return only those that pass. Unknown category types are silently dropped.
 * - If raw is empty or whitespace-only, return `{ categories: [] }`.
 * - Otherwise (legacy plain text, parse error, or no valid categories), wrap
 *   the raw string in a "General" text category.
 */
export function parseSharedContext(raw: string): SharedContextData {
  if (!raw || raw.trim() === "") {
    return { categories: [] };
  }

  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray(parsed.categories)
    ) {
      const validCategories = (parsed.categories as unknown[]).filter(
        isValidCategory,
      );
      if (validCategories.length > 0) {
        return { categories: validCategories };
      }
      // JSON parsed but contained no valid categories — fall through to legacy wrap
    }
  } catch {
    // Not valid JSON or doesn't have categories array; treat as legacy text
  }

  // Fallback: wrap raw text in a text category
  return {
    categories: [
      {
        id: "general",
        label: "General",
        type: "text",
        entries: [{ text: raw.trim() }],
      },
    ],
  };
}

/**
 * Serialize shared context data to a JSON string.
 */
export function serializeSharedContext(data: SharedContextData): string {
  return JSON.stringify(data);
}

/**
 * Create the four seed categories with stable IDs.
 */
export function makeSeedCategories(): ContextCategory[] {
  return [
    {
      id: "domain-terminology",
      label: "Domain Terminology",
      type: "terms",
      entries: [
        { key: "Agent", value: "An autonomous task executor within a team." },
        {
          key: "Skill",
          value: "A composable capability (e.g., Slack integration, GitHub API).",
        },
        {
          key: "Connection",
          value: "Credential and configuration for a third-party service.",
        },
        {
          key: "ToolPolicy",
          value: "Deny-by-default access control for agent tool use.",
        },
      ],
    },
    {
      id: "product-company",
      label: "Product & Company",
      type: "entries",
      entries: [
        {
          title: "AgentFactory",
          desc: "An open-source orchestration layer for autonomous AI agents with fine-grained access control.",
        },
        {
          title: "Mission",
          desc: "Enable teams to safely compose and deploy agents without centralized security gates.",
        },
      ],
    },
    {
      id: "architecture-decisions",
      label: "Architecture Decisions",
      type: "entries",
      entries: [
        {
          title: "Backend Agnostic to Agent SDK",
          desc: "Agent execution logic lives behind AgentRuntime port interface; the backend never imports provider SDK types.",
        },
        {
          title: "No Approval Gates",
          desc: "Authorization is synchronous (ToolPolicy checked at config time). Runs are never paused waiting for human input.",
        },
        {
          title: "State Machine on Runs",
          desc: "Run status (queued → provisioning → running → finalizing → done/failed/cancelled) is the source of truth in Postgres.",
        },
      ],
    },
    {
      id: "external-systems",
      label: "External Systems",
      type: "systems",
      entries: [
        {
          name: "GitHub",
          type: "scm",
          notes: "OAuth2 integration; scope: repo read/write for agent collaboration.",
        },
        {
          name: "Slack",
          type: "channel",
          notes: "App-level integration; agents can read/write messages, create workflows.",
        },
        {
          name: "Jira",
          type: "tasks",
          notes: "API token auth; agents can create/update issues and link to runs.",
        },
      ],
    },
  ];
}

/**
 * Count the number of entries in a category.
 * For text categories, returns 1 if non-empty, 0 if empty.
 */
export function countEntries(cat: ContextCategory): number {
  if (cat.type === "text") {
    // Text category entries is [TextEntry] | []
    return cat.entries.length > 0 ? 1 : 0;
  }
  return cat.entries.length;
}
