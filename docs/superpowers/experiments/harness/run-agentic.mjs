// Experiment 2 — the condition that actually failed in production.
//
// Experiment 1 was single-turn and showed the footers passing 5/5 even for the control
// order, which does NOT reproduce run #37, where the two closing footers were dropped.
// The difference is that a real run spends a long agentic turn exploring the repo before
// answering, so many KB of tool traffic sit between the system prompt and the moment of
// generation. This reproduces that: an identical synthetic exploration transcript is
// replayed for every variant, so the only thing that varies is layer ORDER.
import fs from "node:fs";

const DIR = new URL(".", import.meta.url).pathname;
const segments = JSON.parse(fs.readFileSync(DIR + "segments.json", "utf8"));
const byId = Object.fromEntries(segments.map((s) => [s.id, s.text]));

const ORDERS = {
  control: ["platform_preamble", "environment", "team_context", "repo_map", "agent_system_prompt"],
  repo_early: ["platform_preamble", "environment", "repo_map", "team_context", "agent_system_prompt"],
};

const gitLog = `6f8c84a Merge pull request #26 from erakauf1/animated-reveal
a1b2c3d Merge pull request #20 from erakauf1/thai-ui
7c8d9ef Merge pull request #41 from erakauf1/csv-injection
8e9f0ab Merge pull request #40 from erakauf1/stale-scoring-guard
9d0a1bc Merge pull request #19 from erakauf1/remove-dup-group-code
${Array.from({ length: 40 }, (_, i) => `${(1000 + i).toString(16)} chore: routine commit ${i}`).join("\n")}`;

const fileDump = Array.from(
  { length: 60 },
  (_, i) => `src/components/Module${i}.tsx  (${200 + i * 7} lines)  exports Module${i}, useModule${i}`,
).join("\n");

// Simulated exploration: the assistant "uses tools", the user turn returns results.
// ~6 KB of intervening traffic, matching the scale of a real run's transcript.
const TRANSCRIPT = [
  { role: "user", content: `Write release notes for the last 5 merged changes in this repository.\nCodebase: erakauf1/Wisdom-of-thai` },
  { role: "assistant", content: "I'll start by checking the git history for recent merges." },
  { role: "user", content: `Tool result (git log --oneline --all | head -45):\n\n${gitLog}` },
  { role: "assistant", content: "Now let me look at the repository structure to understand what each change touched." },
  { role: "user", content: `Tool result (find src -name '*.tsx'):\n\n${fileDump}` },
  { role: "assistant", content: "Let me read the existing release notes to match the established style." },
  {
    role: "user",
    content:
      "Tool result (cat RELEASE_NOTES.md):\n\n# Release Notes\n\n## v0.4.0\n- Added group scoring\n- Fixed timer drift\n\n## v0.3.0\n- Added CSV export\n- Fixed mobile layout",
  },
  {
    role: "user",
    content:
      "That's everything you need. The 5 merged PRs are #26 (animated guess reveal with synchronized distribution bars), #20 (Thai temple-inspired UI redesign with festive animations), #41 (CSV formula injection prevention for secure exports), #40 (stale scoring guard preventing exclusion of the last guess, plus dependency security updates), and #19 (duplicate group code field removed from form).\n\nWrite the final release notes now. You have no tools available in this turn: do not attempt to run commands or read files.",
  },
];

const CHECKS = {
  "rocket first": (t) => {
    const a = t.indexOf("\u{1F680}");
    const g = t.search(/Added|Fixed/);
    return a !== -1 && (g === -1 || a < g);
  },
  grouping: (t) => /Added/.test(t) && /Fixed/.test(t),
  "PR ref per bullet": (t) => {
    const b = t.split("\n").filter((l) => /^\s*([-*]|\d+\.)\s+\S/.test(l));
    return b.length > 0 && b.every((l) => /\[#\d+\]\s*(\(no-issue\))?\s*[.)]?\s*$/.test(l.trimEnd()));
  },
  "ping footer": (t) => t.includes("Questions? Ping #platform-releases."),
  "zebra footer": (t) => t.includes("Compiled by the release desk."),
  "no fake tools": (t) => !/<function_calls>|<invoke name=/.test(t),
};

async function callModel(system, apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 2048, system, messages: TRANSCRIPT }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

const TRIALS = Number(process.env.TRIALS || 5);
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

const names = Object.keys(CHECKS);
const transcriptBytes = TRANSCRIPT.reduce((a, m) => a + Buffer.byteLength(m.content), 0);
console.log(`intervening transcript: ${transcriptBytes} bytes\n`);
console.log("variant".padEnd(14) + names.map((n) => n.slice(0, 12).padStart(13)).join("") + "   FULL");

const all = [];
for (const [name, order] of Object.entries(ORDERS)) {
  const system = order.map((id) => byId[id] ?? "").join("");
  const texts = [];
  for (let i = 0; i < TRIALS; i++) {
    texts.push(await callModel(system, apiKey));
    fs.writeFileSync(`${DIR}agentic-${name}-${i}.md`, texts[i]);
  }
  const per = names.map((n) => texts.filter((t) => CHECKS[n](t)).length);
  const full = texts.filter((t) => names.every((n) => CHECKS[n](t))).length;
  console.log(name.padEnd(14) + per.map((p) => `${p}/${TRIALS}`.padStart(13)).join("") + `   ${full}/${TRIALS}`);
  all.push({ variant: name, texts });
}
fs.writeFileSync(DIR + "agentic-results.json", JSON.stringify(all, null, 2));
