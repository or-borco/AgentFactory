import { describe, expect, it } from "vitest";
import { adfToMarkdown } from "../adf";

// Minimal ADF document builder: { type: "doc", version: 1, content: [...] }.
function doc(content: unknown[]) {
  return { type: "doc", version: 1, content };
}

function text(value: string, marks?: Array<{ type: string; attrs?: Record<string, unknown> }>) {
  return marks ? { type: "text", text: value, marks } : { type: "text", text: value };
}

function paragraph(content: unknown[]) {
  return { type: "paragraph", content };
}

describe("adfToMarkdown", () => {
  describe("malformed / empty input degrades to empty string, never throws", () => {
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["a plain string", "not a doc"],
      ["a number", 42],
      ["an empty object", {}],
      ["a doc with no content array", { type: "doc", version: 1 }],
      ["a doc whose content is not an array", { type: "doc", version: 1, content: "oops" }],
    ])("returns \"\" for %s", (_label, input) => {
      expect(() => adfToMarkdown(input)).not.toThrow();
      expect(adfToMarkdown(input)).toBe("");
    });
  });

  describe("paragraph and plain text", () => {
    it("renders a single paragraph", () => {
      const input = doc([paragraph([text("Hello world")])]);
      expect(adfToMarkdown(input)).toBe("Hello world");
    });

    it("joins multiple paragraphs with a blank line", () => {
      const input = doc([paragraph([text("First paragraph")]), paragraph([text("Second paragraph")])]);
      expect(adfToMarkdown(input)).toBe("First paragraph\n\nSecond paragraph");
    });

    it("concatenates adjacent text runs within a paragraph with no added whitespace", () => {
      const input = doc([paragraph([text("foo"), text("bar")])]);
      expect(adfToMarkdown(input)).toBe("foobar");
    });
  });

  describe("text marks", () => {
    it("renders strong as **text**", () => {
      const input = doc([paragraph([text("bold", [{ type: "strong" }])])]);
      expect(adfToMarkdown(input)).toBe("**bold**");
    });

    it("renders em as _text_", () => {
      const input = doc([paragraph([text("italic", [{ type: "em" }])])]);
      expect(adfToMarkdown(input)).toBe("_italic_");
    });

    it("renders code as `text`", () => {
      const input = doc([paragraph([text("const x = 1", [{ type: "code" }])])]);
      expect(adfToMarkdown(input)).toBe("`const x = 1`");
    });

    it("combines strong and em as _**text**_", () => {
      const input = doc([paragraph([text("bold italic", [{ type: "strong" }, { type: "em" }])])]);
      expect(adfToMarkdown(input)).toBe("_**bold italic**_");
    });

    it("renders a link mark as [text](href)", () => {
      const input = doc([
        paragraph([text("AgentFactory", [{ type: "link", attrs: { href: "https://example.com" } }])]),
      ]);
      expect(adfToMarkdown(input)).toBe("[AgentFactory](https://example.com)");
    });

    it("wraps link outermost when combined with strong", () => {
      const input = doc([
        paragraph([
          text("bold link", [{ type: "strong" }, { type: "link", attrs: { href: "https://example.com" } }]),
        ]),
      ]);
      expect(adfToMarkdown(input)).toBe("[**bold link**](https://example.com)");
    });

    it("treats a link mark with a missing href as an empty href rather than throwing", () => {
      const input = doc([paragraph([text("nowhere", [{ type: "link", attrs: {} }])])]);
      expect(() => adfToMarkdown(input)).not.toThrow();
      expect(adfToMarkdown(input)).toBe("[nowhere]()");
    });
  });

  describe("headings", () => {
    it.each([1, 2, 3, 4, 5, 6])("renders a level %i heading", (level) => {
      const input = doc([{ type: "heading", attrs: { level }, content: [text("Title")] }]);
      expect(adfToMarkdown(input)).toBe(`${"#".repeat(level)} Title`);
    });

    it("clamps an out-of-range level down to 6", () => {
      const input = doc([{ type: "heading", attrs: { level: 9 }, content: [text("Too deep")] }]);
      expect(adfToMarkdown(input)).toBe("###### Too deep");
    });

    it("clamps an out-of-range level up to 1", () => {
      const input = doc([{ type: "heading", attrs: { level: 0 }, content: [text("Too shallow")] }]);
      expect(adfToMarkdown(input)).toBe("# Too shallow");
    });

    it("defaults to level 1 when attrs are missing", () => {
      const input = doc([{ type: "heading", content: [text("No attrs")] }]);
      expect(adfToMarkdown(input)).toBe("# No attrs");
    });
  });

  describe("lists", () => {
    it("renders a bulletList", () => {
      const input = doc([
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [paragraph([text("First")])] },
            { type: "listItem", content: [paragraph([text("Second")])] },
          ],
        },
      ]);
      expect(adfToMarkdown(input)).toBe("- First\n- Second");
    });

    it("renders an orderedList with incrementing numbers", () => {
      const input = doc([
        {
          type: "orderedList",
          content: [
            { type: "listItem", content: [paragraph([text("First")])] },
            { type: "listItem", content: [paragraph([text("Second")])] },
            { type: "listItem", content: [paragraph([text("Third")])] },
          ],
        },
      ]);
      expect(adfToMarkdown(input)).toBe("1. First\n2. Second\n3. Third");
    });

    it("renders a nested bulletList indented under its parent item", () => {
      const input = doc([
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                paragraph([text("Parent")]),
                {
                  type: "bulletList",
                  content: [{ type: "listItem", content: [paragraph([text("Child")])] }],
                },
              ],
            },
          ],
        },
      ]);
      expect(adfToMarkdown(input)).toBe("- Parent\n  - Child");
    });
  });

  describe("codeBlock", () => {
    it("renders a fenced code block with a language", () => {
      const input = doc([
        { type: "codeBlock", attrs: { language: "ts" }, content: [text("const x = 1;")] },
      ]);
      expect(adfToMarkdown(input)).toBe("```ts\nconst x = 1;\n```");
    });

    it("renders a fenced code block with no language attr", () => {
      const input = doc([{ type: "codeBlock", content: [text("plain code")] }]);
      expect(adfToMarkdown(input)).toBe("```\nplain code\n```");
    });
  });

  describe("hardBreak", () => {
    it("renders a hard break as a markdown line break within a paragraph", () => {
      const input = doc([paragraph([text("line one"), { type: "hardBreak" }, text("line two")])]);
      expect(adfToMarkdown(input)).toBe("line one  \nline two");
    });
  });

  describe("rule", () => {
    it("renders a rule as a standalone thematic break", () => {
      const input = doc([paragraph([text("Above")]), { type: "rule" }, paragraph([text("Below")])]);
      expect(adfToMarkdown(input)).toBe("Above\n\n---\n\nBelow");
    });
  });

  describe("unknown node types degrade gracefully (never throw, never emit partial markup)", () => {
    it("drops a mediaSingle node with no text content entirely, without leaving stray blank lines", () => {
      const input = doc([
        paragraph([text("Before the image")]),
        {
          type: "mediaSingle",
          attrs: { layout: "center" },
          content: [{ type: "media", attrs: { type: "file", id: "abc123", collection: "attachments" } }],
        },
        paragraph([text("After the image")]),
      ]);
      expect(() => adfToMarkdown(input)).not.toThrow();
      expect(adfToMarkdown(input)).toBe("Before the image\n\nAfter the image");
    });

    it("degrades an unrecognized wrapper node (e.g. a panel) to its concatenated text content", () => {
      const input = doc([
        {
          type: "panel",
          attrs: { panelType: "info" },
          content: [paragraph([text("Note: this is important")])],
        },
      ]);
      expect(adfToMarkdown(input)).toBe("Note: this is important");
    });

    it("degrades an unrecognized inline node within a paragraph to its text content", () => {
      const input = doc([
        paragraph([text("See "), { type: "inlineCard", attrs: { url: "https://example.com" } }, text(" for details")]),
      ]);
      expect(() => adfToMarkdown(input)).not.toThrow();
      expect(adfToMarkdown(input)).toBe("See  for details");
    });

    it("does not throw when a content array contains non-object entries", () => {
      const input = doc([paragraph([text("ok"), null, undefined, "raw string", 5])]);
      expect(() => adfToMarkdown(input)).not.toThrow();
      expect(adfToMarkdown(input)).toBe("ok");
    });

    it("never emits a partial markdown token for an unmodeled node type", () => {
      // A table is unmodeled; it must not leak "|" cell syntax or throw, just degrade to text.
      const input = doc([
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [paragraph([text("A1")])] },
                { type: "tableCell", content: [paragraph([text("B1")])] },
              ],
            },
          ],
        },
      ]);
      const result = adfToMarkdown(input);
      expect(() => adfToMarkdown(input)).not.toThrow();
      expect(result).not.toContain("|");
      expect(result).toBe("A1B1");
    });
  });

  describe("a realistic mixed document", () => {
    it("renders heading, paragraph, list, and code block together", () => {
      const input = doc([
        { type: "heading", attrs: { level: 2 }, content: [text("Summary")] },
        paragraph([text("This bug affects "), text("production", [{ type: "strong" }]), text(".")]),
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [paragraph([text("Repro step one")])] },
            { type: "listItem", content: [paragraph([text("Repro step two")])] },
          ],
        },
        { type: "codeBlock", attrs: { language: "bash" }, content: [text("npm run repro")] },
      ]);
      expect(adfToMarkdown(input)).toBe(
        "## Summary\n\n" +
          "This bug affects **production**.\n\n" +
          "- Repro step one\n- Repro step two\n\n" +
          "```bash\nnpm run repro\n```",
      );
    });
  });
});
