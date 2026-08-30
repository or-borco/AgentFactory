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

// How far snapStart/snapEnd will search forward past the nominal boundary for a whitespace
// character. Deliberately small and well under CHUNK_TARGET_CHARS: it's enough slack to land on
// the next word break in ordinary prose (average word + space is well under this), but bounded so
// a long whitespace-free run — a base64 data URI, a long URL, a minified line, or a stretch of
// CJK text with no spaces — can't drag a window's boundary forward without limit. Past this many
// characters with no whitespace found, callers fall back to a hard cut at the nominal boundary: a
// possible mid-word cut, but bounded and rare, rather than a window that silently balloons past
// what the embedder's context window can hold.
const SNAP_LOOKAHEAD_CHARS = 40;

// The index of the first whitespace character in `text[from, limit)`, or -1 if that span has no
// whitespace at all (i.e. it runs on as one token at least up to `limit`). `limit` defaults to
// `text.length` for callers that want an unbounded forward search (overlapTail, trimming a tail
// that's already capped in length); snapStart/snapEnd pass a bounded `limit` so a whitespace-free
// run can't pull a boundary arbitrarily far forward. Shared so every caller snaps to word
// boundaries the same way.
function nextWhitespaceFrom(text: string, from: number, limit: number = text.length): number {
  const end = Math.min(limit, text.length);
  if (from >= end) return -1;
  const boundary = text.slice(from, end).search(/\s/);
  return boundary === -1 ? -1 : from + boundary;
}

// The tail carried into the next window, trimmed forward to the first whitespace so a window
// never opens mid-word — a half-token is noise to the embedder.
function overlapTail(text: string): string {
  if (text.length <= CHUNK_OVERLAP_CHARS) return text;
  const tailStart = text.length - CHUNK_OVERLAP_CHARS;
  const boundary = nextWhitespaceFrom(text, tailStart);
  return boundary === -1 ? text.slice(tailStart) : text.slice(boundary + 1);
}

// A cut at `index` is clean (falls on a word boundary) iff the character just before it is
// whitespace or the index sits at a string boundary — i.e. it does not land inside a token.
function isCleanBoundary(text: string, index: number): boolean {
  return index <= 0 || index >= text.length || /\s/.test(text[index - 1]);
}

// Snap a window's start forward past any partial word: if `index` doesn't already sit right
// after whitespace (or at the very start), skip forward to the next whitespace (within
// SNAP_LOOKAHEAD_CHARS) and start right after it — the same move overlapTail makes for the
// packed-paragraph overlap case. If no whitespace turns up within the lookahead (a long
// whitespace-free run starts here), give up and start exactly at `index` instead of searching
// indefinitely — a mid-word start in that rare case, never an unbounded skip forward.
function snapStart(text: string, index: number): number {
  if (isCleanBoundary(text, index)) return index;
  const boundary = nextWhitespaceFrom(text, index, index + SNAP_LOOKAHEAD_CHARS);
  return boundary === -1 ? index : boundary + 1;
}

// Snap a window's end forward past a partial word: if the cut at `index` would land inside a
// token (the char right at index is not whitespace and the char before it isn't either), extend
// forward to the next whitespace (within SNAP_LOOKAHEAD_CHARS) so the window ends on a whole word
// instead of cutting it. If no whitespace turns up within the lookahead — a long whitespace-free
// run straddles the target boundary — fall back to a hard cut exactly at `index` rather than
// searching indefinitely: a possible mid-word cut, but bounded, instead of a window that can grow
// arbitrarily larger than CHUNK_TARGET_CHARS.
function snapEnd(text: string, index: number): number {
  if (index >= text.length || isCleanBoundary(text, index) || /\s/.test(text[index])) return index;
  const boundary = nextWhitespaceFrom(text, index, index + SNAP_LOOKAHEAD_CHARS);
  return boundary === -1 ? index : boundary;
}

// A single paragraph bigger than the target has no internal boundary to respect at the target
// stride, so it is cut on a fixed stride but every boundary is snapped forward to the nearest
// whitespace so a window never opens or closes mid-word. Consecutive windows share roughly (not
// always exactly, once snapping shifts a boundary) CHUNK_OVERLAP_CHARS.
function splitOversized(paragraph: string): string[] {
  const step = CHUNK_TARGET_CHARS - CHUNK_OVERLAP_CHARS;
  const windows: string[] = [];
  let start = 0;
  while (start < paragraph.length) {
    const actualStart = snapStart(paragraph, start);
    // snapStart's bounded search can, in principle, land exactly on the string's end (e.g. the
    // only whitespace within the lookahead is the final character) — nothing left to emit.
    if (actualStart >= paragraph.length) break;
    const nominalEnd = actualStart + CHUNK_TARGET_CHARS;
    const actualEnd = nominalEnd >= paragraph.length ? paragraph.length : snapEnd(paragraph, nominalEnd);
    windows.push(paragraph.slice(actualStart, actualEnd));
    if (actualEnd >= paragraph.length) break;
    start = actualStart + step;
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
