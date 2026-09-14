// Jira project keys are conventionally 2-10 characters, starting with a letter and otherwise
// letters/digits, followed by a dash and the issue number (e.g. "PROJ-123"). Matched
// case-insensitively -- people paste keys in whatever case they happen to be typing in -- and
// the returned key is always normalized to uppercase, matching how Jira itself displays it.
const BARE_KEY_RE = /\b([A-Za-z][A-Za-z0-9]{1,9})-([0-9]+)\b/g;

// A handful of common non-Jira LETTERS-NUMBER patterns that collide with the key shape above but
// are never real Jira project keys in practice (technical standards/abbreviations, e.g. "UTF-8",
// "COVID-19"). There is no structural way to tell "PROJ-123" apart from "UTF-8" by regex alone --
// a real project key can be exactly as short -- so this is a denylist, not a proof. Extend it if
// another false positive turns up.
const KNOWN_NON_ISSUE_PREFIXES = new Set([
  "UTF",
  "ISO",
  "RFC",
  "IEEE",
  "ECMA",
  "COVID",
  "ASCII",
  "WCAG",
  "USB",
  "PCI",
]);

// Matches a Jira browse URL anywhere in the text: origin, "/browse/", the key, and an optional
// trailing slash or query string. Origin is captured separately so the caller's site can be
// checked before the key is ever trusted.
const BROWSE_URL_RE = /(https?:\/\/[^/\s]+)\/browse\/([A-Za-z][A-Za-z0-9]{1,9}-[0-9]+)(?:[/?][^\s]*)?/i;

function normalizeSite(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

function extractBareKey(text: string): string | undefined {
  for (const match of text.matchAll(BARE_KEY_RE)) {
    const [, prefix, number] = match;
    if (KNOWN_NON_ISSUE_PREFIXES.has(prefix.toUpperCase())) continue;
    return `${prefix.toUpperCase()}-${number}`;
  }
  return undefined;
}

// Pulls a Jira issue key out of free text, scoped to one connection's site. Text that contains a
// browse URL for a different Atlassian site is rejected outright -- never falls back to a bare-key
// scan of the same text -- so a pasted link into another org's Jira can never resolve through this
// connection. This is what backs the "tasks" TaskProvider port's parseIssueReference method for
// the Jira adapter; see packages/integrations/src/task-provider.ts.
export function parseJiraIssueReference(text: string, siteUrl: string): string | undefined {
  const urlMatch = BROWSE_URL_RE.exec(text);
  if (urlMatch) {
    const [, origin, key] = urlMatch;
    return normalizeSite(origin) === normalizeSite(siteUrl) ? key.toUpperCase() : undefined;
  }

  return extractBareKey(text);
}
