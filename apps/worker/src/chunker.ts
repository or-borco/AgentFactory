// Pure text chunking: no I/O, no embedder, no database. Every decision about how a document is
// cut lives here so it can be re-tuned from the unit tests alone once PR 7 has numbers.
export const CHUNK_TARGET_CHARS = 1000;
export const CHUNK_OVERLAP_CHARS = 150;

export interface Chunk {
  chunkIdx: number;
  text: string;
}

interface Section {
  headingPath: string[];
  body: string;
}

// ATX headings only. A `# comment` inside a fenced code block reads as a heading here — a known,
// accepted limitation: the cost is a slightly odd heading path on one chunk, not lost text.
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

function splitByHeadings(source: string): Section[] {
  const sections: Section[] = [];
  let headingPath: string[] = [];
  let lines: string[] = [];

  const flush = () => {
    const body = lines.join("\n").trim();
    if (body) sections.push({ headingPath: [...headingPath], body });
    lines = [];
  };

  for (const line of source.split("\n")) {
    const match = HEADING_RE.exec(line);
    if (!match) {
      lines.push(line);
      continue;
    }
    flush();
    // Truncate to the parent level, then push — an h2 after an h1 nests, an h1 after an h2 resets.
    headingPath = [...headingPath.slice(0, match[1].length - 1), match[2]];
  }
  flush();
  return sections;
}

// The tail carried into the next window, trimmed forward to the first whitespace so a window
// never opens mid-word — a half-token is noise to the embedder.
function overlapTail(text: string): string {
  if (text.length <= CHUNK_OVERLAP_CHARS) return text;
  const tail = text.slice(-CHUNK_OVERLAP_CHARS);
  const boundary = tail.search(/\s/);
  return boundary === -1 ? tail : tail.slice(boundary + 1);
}

// A single paragraph bigger than the target has no internal boundary to respect, so it is cut on
// a fixed stride. Consecutive windows share exactly CHUNK_OVERLAP_CHARS.
function splitOversized(paragraph: string): string[] {
  const step = CHUNK_TARGET_CHARS - CHUNK_OVERLAP_CHARS;
  const windows: string[] = [];
  for (let start = 0; start < paragraph.length; start += step) {
    windows.push(paragraph.slice(start, start + CHUNK_TARGET_CHARS));
    if (start + CHUNK_TARGET_CHARS >= paragraph.length) break;
  }
  return windows;
}

function packSection(body: string): string[] {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const windows: string[] = [];
  let current = "";

  const flush = () => {
    if (current) windows.push(current);
    current = "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > CHUNK_TARGET_CHARS) {
      flush();
      // splitOversized already carries its own overlap; starting the next window from its tail
      // would emit that tail twice, once alone if the paragraph is the section's last.
      windows.push(...splitOversized(paragraph));
      continue;
    }
    if (!current) {
      current = paragraph;
      continue;
    }
    if (current.length + 2 + paragraph.length <= CHUNK_TARGET_CHARS) {
      current = `${current}\n\n${paragraph}`;
      continue;
    }
    const carry = overlapTail(current);
    flush();
    // Drop the carry rather than overshoot: the target is a hard ceiling on a body, which is
    // what lets PR 5's byte budget reason about whole chunks.
    current =
      carry.length + 2 + paragraph.length <= CHUNK_TARGET_CHARS ? `${carry}\n\n${paragraph}` : paragraph;
  }
  flush();
  return windows;
}

// Every chunk is prefixed "<document title> › <heading path>" and the prefix is embedded along
// with the body. A bare paragraph pulled out of a 40-page handbook is frequently uninterpretable,
// and the agent has no way to ask where it came from — this layer is pre-injected text, not a tool.
export function chunkDocument(title: string, source: string): Chunk[] {
  const chunks: Chunk[] = [];
  for (const section of splitByHeadings(source)) {
    const prefix = [title, ...section.headingPath].join(" › ");
    for (const window of packSection(section.body)) {
      chunks.push({ chunkIdx: chunks.length, text: `${prefix}\n\n${window}` });
    }
  }
  return chunks;
}
