// Atlassian Document Format (ADF) -> Markdown, for the node types that actually appear in Jira
// issue descriptions. ADF is a JSON tree: { type: "doc", version: 1, content: [...] }, where nodes
// nest via a `content` array and `text` nodes carry `marks: [{ type, attrs? }]`.
//
// Jira descriptions can also contain panels, macros, tables, and media (images, attachments) that
// this module does not model. Per the design: a task prefill that is slightly lossy on an exotic
// node is fine; one that throws is not. Every unrecognized node type — block or inline — degrades
// to its concatenated text content (found by walking `content` recursively) rather than throwing
// or emitting partial/broken markup.

interface AdfNode {
  type?: unknown;
  text?: unknown;
  marks?: unknown;
  attrs?: unknown;
  content?: unknown;
}

export function adfToMarkdown(doc: unknown): string {
  if (!isNode(doc) || !Array.isArray(doc.content)) {
    return "";
  }
  const blocks = doc.content
    .map((node) => renderBlock(node, 0))
    .filter((block) => block.length > 0);
  return blocks.join("\n\n");
}

function isNode(value: unknown): value is AdfNode {
  return typeof value === "object" && value !== null;
}

// For reading attrs sub-fields (level, language, href, ...), which AdfNode deliberately does not
// enumerate — attrs shapes vary per node type and this module only reads a handful of keys.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNodeArray(value: unknown): AdfNode[] {
  return Array.isArray(value) ? value.filter(isNode) : [];
}

function renderBlock(node: unknown, depth: number): string {
  if (!isNode(node)) {
    return "";
  }
  switch (node.type) {
    case "paragraph":
      return renderInline(node.content);
    case "heading": {
      const level = headingLevel(node.attrs);
      const inline = renderInline(node.content);
      return inline.length > 0 ? `${"#".repeat(level)} ${inline}` : "";
    }
    case "codeBlock": {
      const language = codeLanguage(node.attrs);
      const code = collectText(node.content);
      return "```" + language + "\n" + code + "\n```";
    }
    case "bulletList":
      return renderList(node.content, depth, false);
    case "orderedList":
      return renderList(node.content, depth, true);
    case "rule":
      return "---";
    case "listItem":
      // Only reachable if a listItem appears outside a list; render it like a lone bullet.
      return renderListItem(node, depth, undefined);
    default:
      // Unknown node type: degrade to concatenated text content, never throw.
      return collectText(node.content ?? node.text);
  }
}

function headingLevel(attrs: unknown): number {
  const level = isRecord(attrs) && typeof attrs.level === "number" ? attrs.level : 1;
  if (!Number.isFinite(level)) return 1;
  return Math.min(6, Math.max(1, Math.trunc(level)));
}

function codeLanguage(attrs: unknown): string {
  return isRecord(attrs) && typeof attrs.language === "string" ? attrs.language : "";
}

function renderList(content: unknown, depth: number, ordered: boolean): string {
  const items = asNodeArray(content);
  const lines: string[] = [];
  let index = 1;
  for (const item of items) {
    const rendered = renderListItem(item, depth, ordered ? index : undefined);
    if (rendered.length > 0) {
      lines.push(rendered);
      index += 1;
    }
  }
  return lines.join("\n");
}

function renderListItem(item: AdfNode, depth: number, ordinal: number | undefined): string {
  if (item.type !== "listItem") {
    return "";
  }
  const children = asNodeArray(item.content);
  const indent = "  ".repeat(depth);
  const marker = ordinal !== undefined ? `${ordinal}.` : "-";

  const lines: string[] = [];
  for (const child of children) {
    if (child.type === "bulletList" || child.type === "orderedList") {
      const nested = renderBlock(child, depth + 1);
      if (nested.length > 0) lines.push(nested);
    } else {
      const rendered = renderBlock(child, depth);
      if (rendered.length > 0) lines.push(rendered);
    }
  }

  if (lines.length === 0) {
    return "";
  }
  const [first, ...rest] = lines;
  return [`${indent}${marker} ${first}`, ...rest].join("\n");
}

function renderInline(content: unknown): string {
  return asNodeArray(content)
    .map((node) => renderInlineNode(node))
    .join("");
}

function renderInlineNode(node: AdfNode): string {
  if (node.type === "text") {
    const text = typeof node.text === "string" ? node.text : "";
    return applyMarks(text, node.marks);
  }
  if (node.type === "hardBreak") {
    return "  \n";
  }
  // Unknown inline node: degrade to concatenated text content, never throw.
  return collectText(node.content ?? node.text);
}

function applyMarks(text: string, marks: unknown): string {
  if (text.length === 0) {
    return text;
  }
  const markList = asNodeArray(marks);
  const hasMark = (type: string) => markList.some((mark) => mark.type === type);

  let result = text;
  if (hasMark("code")) {
    result = `\`${result}\``;
  }
  if (hasMark("strong")) {
    result = `**${result}**`;
  }
  if (hasMark("em")) {
    result = `_${result}_`;
  }
  const link = markList.find((mark) => mark.type === "link");
  if (link) {
    const href = isRecord(link.attrs) && typeof link.attrs.href === "string" ? link.attrs.href : "";
    result = `[${result}](${href})`;
  }
  return result;
}

// Generic fallback: walk a node's text/content recursively, concatenating every `text` leaf found.
// Used both for codeBlock bodies and as the degrade-gracefully path for any node type this module
// does not otherwise recognize (panels, macros, tables, media, and anything future Jira adds).
function collectText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => collectText(isNode(entry) ? (entry.text ?? entry.content) : undefined)).join("");
  }
  return "";
}
