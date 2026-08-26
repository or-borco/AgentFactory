// Prompt-structure experiment: which arrangement of the five prompt layers makes the
// model actually honour EVERY instruction, including the terminal ones (opening emoji,
// closing footers) that run #37 silently dropped?
//
// Isolates prompt structure as the only variable: identical layer CONTENT in every
// variant, identical user message, identical model. The PR data is handed to the model
// in the user message so no repo exploration is needed and runs are comparable.
import fs from "node:fs";

const DIR = new URL(".", import.meta.url).pathname;
const segments = JSON.parse(fs.readFileSync(DIR + "segments.json", "utf8"));
const byId = Object.fromEntries(segments.map((s) => [s.id, s.text]));

const USER_MESSAGE = `Write release notes for the last 5 merged changes in this repository.
Codebase: erakauf1/Wisdom-of-thai

The 5 merged pull requests below are authoritative and complete. You have no tools available in
this turn: do not attempt to run commands, read files, or explore the repository. Write the
release notes directly from this list.

- #26 Animated guess reveal with synchronized distribution bars
- #20 Thai temple-inspired UI redesign with festive animations and styling
- #41 CSV formula injection prevention for secure exports
- #40 Stale scoring guard (prevents excluding last guess) plus dependency security updates
- #19 Duplicate group code field removed from form`;

// A compact restatement of the output contract, placed last. Deliberately derived from
// the same instructions already present in team_context / agent_system_prompt — it adds
// no NEW requirement, it only moves them adjacent to the generation point.
const CHECKLIST = `## Output requirements (check before you answer)

Your response must satisfy every one of these. They restate requirements stated above; none are new.

1. Open with the rocket emoji.
2. Group entries under Added / Fixed / Changed.
3. End every entry line with its PR number in square brackets.
4. Past tense; address the reader as "you". Max 40 words per bullet.
5. Include the line: Questions? Ping #platform-releases.
6. End with the footer line: Compiled by the release desk.

Do not claim to have satisfied a requirement you did not satisfy.`;

const ORDERS = {
  // Current production order (control).
  control: ["platform_preamble", "environment", "team_context", "repo_map", "agent_system_prompt"],
  // Repo map moved to the very end — tests "is the big blob crowding out what follows it?"
  repo_last: ["platform_preamble", "environment", "team_context", "agent_system_prompt", "repo_map"],
  // Repo map before the human-authored layers, so instructions sit closest to generation.
  repo_early: ["platform_preamble", "environment", "repo_map", "team_context", "agent_system_prompt"],
};

const VARIANTS = [
  { name: "control", order: ORDERS.control, checklist: false },
  { name: "repo_early", order: ORDERS.repo_early, checklist: false },
  { name: "repo_last", order: ORDERS.repo_last, checklist: false },
  { name: "control+checklist", order: ORDERS.control, checklist: true },
  { name: "repo_early+checklist", order: ORDERS.repo_early, checklist: true },
];

function buildSystem(variant) {
  let text = variant.order.map((id) => byId[id] ?? "").join("");
  if (variant.checklist) text += CHECKLIST + "\n\n---\n\n";
  return text;
}

// Each check is a requirement stated in the prompt. All are string/× checks, no judgement.
const CHECKS = [
  {
    name: "rocket before first group",
    fn: (t) => {
      const r = t.indexOf("\u{1F680}");
      const g = t.search(/Added|Fixed/);
      return r !== -1 && (g === -1 || r < g);
    },
  },
  { name: "Added/Fixed grouping", fn: (t) => /Added/.test(t) && /Fixed/.test(t) },
  {
    name: "every bullet has [#N]",
    fn: (t) => {
      const bullets = t.split("\n").filter((l) => /^\s*[-*]\s+\S/.test(l));
      return bullets.length > 0 && bullets.every((l) => /\[#\d+\]\s*$/.test(l.trimEnd()));
    },
  },
  { name: "ping footer", fn: (t) => t.includes("Questions? Ping #platform-releases.") },
  { name: "zebra footer", fn: (t) => t.includes("Compiled by the release desk.") },
  { name: "no hallucinated tool calls", fn: (t) => !/<function_calls>|<invoke name=/.test(t) },
];

async function callModel(system, apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 2048,
      system,
      messages: [{ role: "user", content: USER_MESSAGE }],
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

const TRIALS = Number(process.env.TRIALS || 3);
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

const results = [];
for (const variant of VARIANTS) {
  const system = buildSystem(variant);
  const trials = [];
  for (let i = 0; i < TRIALS; i++) {
    const text = await callModel(system, apiKey);
    const passed = CHECKS.map((c) => ({ name: c.name, pass: c.fn(text) }));
    trials.push({ text, passed });
    fs.writeFileSync(`${DIR}out-${variant.name.replace(/\W+/g, "_")}-${i}.md`, text);
  }
  results.push({ variant: variant.name, systemBytes: Buffer.byteLength(system), trials });
  const line = CHECKS.map((c) => {
    const n = trials.filter((t) => t.passed.find((p) => p.name === c.name).pass).length;
    return `${c.name}: ${n}/${TRIALS}`;
  }).join("  |  ");
  console.log(`\n### ${variant.name}  (${Buffer.byteLength(system)}b system)\n${line}`);
}

fs.writeFileSync(DIR + "results.json", JSON.stringify(results, null, 2));

// Overall score: fraction of (check × trial) cells passed, excluding the informational
// "rocket present anywhere" check so it isn't double-counted with "opens with rocket".
console.log("\n\n=== SUMMARY (all-requirements pass rate per trial) ===");
const scored = CHECKS;
for (const r of results) {
  const perfect = r.trials.filter((t) =>
    scored.every((c) => t.passed.find((p) => p.name === c.name).pass),
  ).length;
  const cells = r.trials.reduce(
    (a, t) => a + scored.filter((c) => t.passed.find((p) => p.name === c.name).pass).length,
    0,
  );
  console.log(
    `${r.variant.padEnd(22)} fully-compliant trials: ${perfect}/${TRIALS}   checks passed: ${cells}/${scored.length * TRIALS}`,
  );
}
