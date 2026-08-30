import { describe, expect, it } from "vitest";
import { CHUNK_OVERLAP_CHARS, CHUNK_TARGET_CHARS, chunkDocument } from "../chunker";

// Distinguishable filler: every word is unique, so an overlap assertion cannot pass by accident
// on repeated text. 120 words of "a0 a1 … a119" is 489 characters.
function filler(label: string, words: number): string {
  return Array.from({ length: words }, (_, i) => `${label}${i}`).join(" ");
}

function bodyOf(text: string, prefix: string): string {
  expect(text.startsWith(`${prefix}\n\n`)).toBe(true);
  return text.slice(prefix.length + 2);
}

describe("chunkDocument", () => {
  it("splits on markdown headings and carries the full heading path in the prefix", () => {
    const source = "# Deploys\n\nRun pnpm build.\n\n## Rollback\n\nRevert the tag.\n";

    expect(chunkDocument("Handbook", source)).toEqual([
      { chunkIdx: 0, text: "Handbook › Deploys\n\nRun pnpm build." },
      { chunkIdx: 1, text: "Handbook › Deploys › Rollback\n\nRevert the tag." },
    ]);
  });

  it("pops back up the heading stack rather than accumulating siblings", () => {
    const source =
      "# Deploys\n\nOne.\n\n## Rollback\n\nTwo.\n\n# Incidents\n\nThree.\n\n## Paging\n\nFour.\n";

    expect(chunkDocument("Handbook", source).map((c) => c.text.split("\n\n")[0])).toEqual([
      "Handbook › Deploys",
      "Handbook › Deploys › Rollback",
      "Handbook › Incidents",
      "Handbook › Incidents › Paging",
    ]);
  });

  it("prefixes preamble text above the first heading with the title alone", () => {
    expect(chunkDocument("Handbook", "Intro line.\n\n# Deploys\n\nBody.")).toEqual([
      { chunkIdx: 0, text: "Handbook\n\nIntro line." },
      { chunkIdx: 1, text: "Handbook › Deploys\n\nBody." },
    ]);
  });

  it("packs paragraphs into target-sized windows and carries ~150 characters of overlap", () => {
    const a = filler("a", 120);
    const b = filler("b", 120);
    const c = filler("c", 120);
    const prefix = "Handbook › Deploys";

    const chunks = chunkDocument("Handbook", `# Deploys\n\n${a}\n\n${b}\n\n${c}`);
    const bodies = chunks.map((chunk) => bodyOf(chunk.text, prefix));

    // a + b fits under the target (489 + 2 + 489 = 980); c does not, so it opens a new window.
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(`${a}\n\n${b}`);

    // The second window opens with a tail carried from the first, cut at a word boundary.
    const carry = bodies[1].slice(0, bodies[1].indexOf(`\n\n${c}`));
    expect(bodies[0].endsWith(carry)).toBe(true);
    expect(carry.length).toBeLessThanOrEqual(CHUNK_OVERLAP_CHARS);
    expect(carry.length).toBeGreaterThan(CHUNK_OVERLAP_CHARS - 20);
    expect(carry.startsWith("b")).toBe(true); // a word start, never mid-token
  });

  it("never emits a body longer than the target, across a long multi-section document", () => {
    const source = [
      "# Deploys",
      "",
      filler("a", 120),
      "",
      filler("b", 120),
      "",
      "## Rollback",
      "",
      filler("c", 120),
      "",
      filler("d", 120),
      "",
      filler("e", 120),
      "",
      "# Incidents",
      "",
      filler("f", 120),
    ].join("\n");

    const chunks = chunkDocument("Handbook", source);

    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      const prefixEnd = chunk.text.indexOf("\n\n");
      expect(chunk.text.length - (prefixEnd + 2)).toBeLessThanOrEqual(CHUNK_TARGET_CHARS);
    }
    expect(chunks.map((chunk) => chunk.chunkIdx)).toEqual(chunks.map((_, i) => i));
  });

  it("hard-splits a single paragraph larger than the target, with overlapping windows", () => {
    const oversized = filler("z", 400); // 1889 characters, one paragraph, no blank lines
    const prefix = "Handbook › Big";

    const chunks = chunkDocument("Handbook", `# Big\n\n${oversized}`);
    const bodies = chunks.map((chunk) => bodyOf(chunk.text, prefix));

    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toHaveLength(CHUNK_TARGET_CHARS);
    expect(bodies[1]).toHaveLength(CHUNK_TARGET_CHARS);
    // Windows step by target - overlap, so consecutive windows share exactly the overlap.
    expect(bodies[1].slice(0, CHUNK_OVERLAP_CHARS)).toBe(bodies[0].slice(-CHUNK_OVERLAP_CHARS));
    expect(bodies.join("").length).toBeGreaterThan(oversized.length); // overlap is real, not lost text
    for (const chunk of chunks) {
      expect(chunk.text.startsWith(`${prefix}\n\n`)).toBe(true);
    }
  });

  it("hard-splits a bullet list with no blank lines without cutting any bullet mid-word", () => {
    // Reproduces a spike finding: a long un-blank-line-separated bullet list is one paragraph to
    // the chunker (no `\n\s*\n` inside it), so it goes through splitOversized. Words vary in
    // length (unlike the evenly-spaced filler fixture above) so a fixed-stride cut is very likely
    // to land inside a word unless boundaries are snapped to whitespace.
    const bullets = Array.from(
      { length: 60 },
      (_, i) => `- item number ${i} carries a moderately descriptive label so the line has heft`,
    ).join("\n");
    const prefix = "Handbook › Big";

    const chunks = chunkDocument("Handbook", `# Big\n\n${bullets}`);
    const bodies = chunks.map((chunk) => bodyOf(chunk.text, prefix));

    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.join("").length).toBeGreaterThan(bullets.length); // overlap is real, not lost text

    // Every window's start and end must fall on a whitespace boundary within the source text, and
    // the source itself must never have been mangled (each body is a verbatim substring of it).
    for (const body of bodies) {
      const at = bullets.indexOf(body);
      expect(at).toBeGreaterThanOrEqual(0);
      const before = bullets[at - 1];
      const after = bullets[at + body.length];
      expect(before === undefined || /\s/.test(before)).toBe(true);
      expect(after === undefined || /\s/.test(after)).toBe(true);
    }
  });

  it("returns no chunks for an empty or whitespace-only document", () => {
    expect(chunkDocument("Handbook", "")).toEqual([]);
    expect(chunkDocument("Handbook", "   \n\n  \n")).toEqual([]);
    // A heading with no body underneath it is nothing to embed either.
    expect(chunkDocument("Handbook", "# Deploys\n\n## Rollback\n")).toEqual([]);
  });
});
