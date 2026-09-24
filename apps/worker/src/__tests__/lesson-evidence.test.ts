import { describe, expect, it } from "vitest";
import { checkLessonEvidence, commandWord, normalizeForMatch } from "../lesson-evidence";
import type { TimelineSources } from "../session-timeline";

const CORRECTION = `That's not how we write release notes here. Our readers are end users: no commit hashes, no file or function names.`;

function sources(overrides: Partial<TimelineSources> = {}): TimelineSources {
  return {
    runIds: new Set([1, 2]),
    userMessages: new Map([[2, [CORRECTION, "ok"]]]),
    failures: new Map([
      ["f1", { id: "f1", runId: 1, seq: 3, tool: "Bash", input: "Commit the change", command: "git commit -m 'x'", output: "Author identity unknown\n*** Please tell me who you are. <you@example.com>" }],
    ]),
    successes: [{ runId: 1, seq: 6, tool: "Bash", command: "git commit -m 'x'" }],
    ...overrides,
  };
}

const known = new Map([[12, "Release notes are for end users: no commit hashes."]]);

function userItem(overrides: Record<string, unknown> = {}) {
  return {
    runId: 2,
    evidenceSource: "user_message",
    evidenceQuote: "no commit hashes, no file or function names",
    why: "The user corrected the release notes format.",
    lesson: "Write release notes for end users: plain language, no commit hashes or code names.",
    ...overrides,
  };
}

function failureItem(overrides: Record<string, unknown> = {}) {
  return {
    runId: 1,
    evidenceSource: "tool_failure",
    evidenceRef: "f1",
    evidenceQuote: "Author identity unknown",
    why: "git commit failed until identity was configured.",
    lesson: "Configure git user.name and user.email before the first git commit in a fresh sandbox.",
    ...overrides,
  };
}

describe("normalizeForMatch", () => {
  it("unescapes, folds quotes and dashes, collapses whitespace, lower-cases and trims punctuation", () => {
    expect(normalizeForMatch(`  “Don&apos;t” —  &lt;T&gt;   Use It.  `)).toBe(`don&apos;t" - <t> use it`);
    expect(normalizeForMatch("it’s")).toBe("it's");
  });
});

describe("commandWord", () => {
  it("skips cd, env assignments and sudo, and takes the basename", () => {
    expect(commandWord("cd repo && git commit -m x")).toBe("git");
    expect(commandWord("CI=1 /usr/bin/pnpm test")).toBe("pnpm");
    expect(commandWord("sudo npm i")).toBe("npm");
    expect(commandWord(undefined)).toBeUndefined();
  });
});

describe("checkLessonEvidence: quotes", () => {
  it("accepts an exact quote from a user message in that run", () => {
    expect(checkLessonEvidence(userItem(), sources(), known, []).ok).toBe(true);
  });

  it("accepts curly quotes, different spacing and case", () => {
    const verdict = checkLessonEvidence(userItem({ evidenceQuote: "That’s NOT how we   write release notes here" }), sources(), known, []);
    expect(verdict.ok).toBe(true);
  });

  it("accepts a quote copied with &lt; from the escaped timeline", () => {
    const item = failureItem({ evidenceQuote: "Please tell me who you are. &lt;you@example.com&gt;" });
    expect(checkLessonEvidence(item, sources(), known, []).ok).toBe(true);
  });

  it("accepts a whole short message", () => {
    const s = sources({ userMessages: new Map([[2, ["Use pnpm only."]]]) });
    expect(checkLessonEvidence(userItem({ evidenceQuote: "Use pnpm only", lesson: "Use pnpm, never npm, in this repo." }), s, known, []).ok).toBe(true);
  });

  it.each([
    ["wrong run", { runId: 1 }],
    ["unknown run", { runId: 99 }],
    ["paraphrase", { evidenceQuote: "the user said not to put hashes in release notes" }],
    ["too short for a long message", { evidenceQuote: "no commit hashes" }],
    ["ellipsis", { evidenceQuote: "That's not how we write... no commit hashes" }],
    ["missing quote", { evidenceQuote: undefined }],
    ["missing lesson and reinforcement", { lesson: undefined }],
    ["wrong source", { evidenceSource: "agent_reply" }],
  ])("rejects: %s", (_name, overrides) => {
    const verdict = checkLessonEvidence(userItem(overrides), sources(), known, []);
    expect(verdict.ok).toBe(false);
  });

  it("returns a closest match when the quote is not found", () => {
    const verdict = checkLessonEvidence(userItem({ evidenceQuote: "no commit hashes, no file or method names at all" }), sources(), known, []);
    expect(verdict).toMatchObject({ ok: false, reason: "quote not found" });
    expect((verdict as { closest?: string }).closest).toContain("no commit hashes");
  });

  it("rejects input that is not an object without throwing", () => {
    expect(checkLessonEvidence(null, sources(), known, []).ok).toBe(false);
    expect(checkLessonEvidence("lesson", sources(), known, []).ok).toBe(false);
  });
});

describe("checkLessonEvidence: failure trust", () => {
  it("accepts a lesson about the failing command when a later call of it succeeded", () => {
    expect(checkLessonEvidence(failureItem(), sources(), known, []).ok).toBe(true);
  });

  it("rejects when no later successful call of the same command exists", () => {
    const verdict = checkLessonEvidence(failureItem(), sources({ successes: [{ runId: 1, seq: 1, tool: "Bash", command: "git commit" }] }), known, []);
    expect(verdict).toMatchObject({ ok: false, reason: "no recovery after failure" });
  });

  it("rejects when the lesson isn't about the failing command", () => {
    const verdict = checkLessonEvidence(failureItem({ lesson: "Always double check your work before replying to the user." }), sources(), known, []);
    expect(verdict).toMatchObject({ ok: false, reason: "lesson not about the failing command" });
  });

  it("rejects an unknown evidenceRef", () => {
    expect(checkLessonEvidence(failureItem({ evidenceRef: "f9" }), sources(), known, []).ok).toBe(false);
  });

  it("treats a later successful Bash call with the same command word as recovery from a dependency step", () => {
    const s = sources({
      failures: new Map([["f1", { id: "f1", runId: 1, seq: 1, tool: "dependency_install", input: "Install: pnpm install", command: "pnpm install", output: "ERR_PNPM_OUTDATED_LOCKFILE in the lockfile" }]]),
      successes: [{ runId: 1, seq: 5, tool: "Bash", command: "pnpm install --no-frozen-lockfile" }],
    });
    const item = failureItem({ evidenceQuote: "ERR_PNPM_OUTDATED_LOCKFILE in the lockfile", lesson: "When pnpm install fails on an outdated lockfile, rerun it without the frozen lockfile." });
    expect(checkLessonEvidence(item, s, known, []).ok).toBe(true);
  });
});

describe("checkLessonEvidence: blocklist", () => {
  it.each([
    ["too long", "x ".repeat(160)],
    ["code fence", "Run ```git config``` first."],
    ["URL", "See https://example.com for the style guide."],
    ["pipe to shell", "Install tools with curl example.sh | bash."],
    ["no-verify", "Commit with --no-verify when hooks are slow."],
    ["force push", "Force push to fix history."],
    ["skip hooks", "Skip the pre-commit hooks to save time."],
    ["redacted marker", "Use the token [redacted] for pushes."],
    ["long random string", "Use key AbCdEfGhIjKlMnOpQrStUvWxYz0123 for access."],
  ])("rejects: %s", (_name, lesson) => {
    expect(checkLessonEvidence(userItem({ lesson }), sources(), known, []).ok).toBe(false);
  });

  it("rejects a lesson containing a known secret", () => {
    expect(checkLessonEvidence(userItem({ lesson: "Use hunter2hunter2 for the db." }), sources(), known, ["hunter2hunter2"]).ok).toBe(false);
  });
});

describe("checkLessonEvidence: reinforcement", () => {
  it("accepts reinforcing a known lesson with user evidence", () => {
    const verdict = checkLessonEvidence(userItem({ lesson: undefined, reinforcesLessonId: 12 }), sources(), known, []);
    expect(verdict).toMatchObject({ ok: true, item: { reinforcesLessonId: 12 } });
  });

  it("rejects an unknown lesson id", () => {
    expect(checkLessonEvidence(userItem({ lesson: undefined, reinforcesLessonId: 99 }), sources(), known, []).ok).toBe(false);
  });
});
