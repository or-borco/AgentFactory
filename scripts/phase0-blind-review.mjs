#!/usr/bin/env node
// Helper for docs/PHASE0-EXIT-GATE.md (issue #69).
//
// Turns 10 pairs of "context" vs "bare" agent branches into an anonymized bundle the tech
// lead can score blind, then joins the scores back to the real labels afterwards.
//
// Usage:
//   node scripts/phase0-blind-review.mjs prepare --base main --pairs pairs.json --out phase0-review-bundle
//   node scripts/phase0-blind-review.mjs unblind --bundle phase0-review-bundle
//
// pairs.json:
//   [
//     { "task": "task-123", "context": "agent/task-123-context", "bare": "agent/task-123-bare" },
//     ...
//   ]

import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    }
  }
  return args;
}

function gitDiff(base, branch) {
  return execFileSync("git", ["diff", `${base}...${branch}`], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
}

// Best-effort scrub: git diff output doesn't normally carry author/commit metadata, but as
// a safety net strip any literal occurrence of the branch name (in case it leaked into a
// comment, filename, or commit-message-derived string) before the reviewer ever sees it.
function scrub(diffText, ...identifiers) {
  let out = diffText;
  for (const id of identifiers) {
    if (!id) continue;
    out = out.split(id).join("[[redacted]]");
  }
  return out;
}

function shuffledIndices(n) {
  const indices = Array.from({ length: n }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

function cmdPrepare(args) {
  const base = args.base;
  const pairsPath = args.pairs;
  const outDir = args.out;
  if (!base || !pairsPath || !outDir) {
    console.error("Usage: prepare --base <ref> --pairs <pairs.json> --out <dir>");
    process.exit(1);
  }

  const pairs = JSON.parse(readFileSync(pairsPath, "utf8"));
  if (!Array.isArray(pairs) || pairs.length === 0) {
    console.error(`${pairsPath} must be a non-empty JSON array of {task, context, bare}`);
    process.exit(1);
  }

  const entries = [];
  for (const pair of pairs) {
    for (const variant of ["context", "bare"]) {
      const branch = pair[variant];
      if (!branch) {
        console.error(`Task ${pair.task}: missing "${variant}" branch`);
        process.exit(1);
      }
      const rawDiff = gitDiff(base, branch);
      const diff = scrub(rawDiff, branch, pair.task);
      entries.push({ task: pair.task, variant, branch, diff });
    }
  }

  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    console.error(`${outDir} already exists and is not empty — refusing to overwrite`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });

  const order = shuffledIndices(entries.length);
  const unblindKey = {};
  const scorecardRows = [["review", "verdict", "notes"]];

  order.forEach((sourceIndex, position) => {
    const label = `review-${String(position + 1).padStart(2, "0")}`;
    const entry = entries[sourceIndex];
    writeFileSync(path.join(outDir, `${label}.diff`), entry.diff, "utf8");
    unblindKey[label] = { task: entry.task, variant: entry.variant };
    scorecardRows.push([label, "", ""]);
  });

  writeFileSync(
    path.join(outDir, "UNBLIND-KEY.json"),
    JSON.stringify(unblindKey, null, 2) + "\n",
    "utf8"
  );
  writeFileSync(
    path.join(outDir, "scorecard.csv"),
    scorecardRows.map((r) => r.map(csvEscape).join(",")).join("\n") + "\n",
    "utf8"
  );

  console.log(`Wrote ${entries.length} anonymized diffs to ${outDir}/`);
  console.log(`Fill in ${outDir}/scorecard.csv (verdict: merge-as-is / merge-with-comments / no).`);
  console.log(`Do not open ${outDir}/UNBLIND-KEY.json until scoring is complete.`);
}

function cmdUnblind(args) {
  const bundle = args.bundle;
  if (!bundle) {
    console.error("Usage: unblind --bundle <dir>");
    process.exit(1);
  }

  const unblindKey = JSON.parse(readFileSync(path.join(bundle, "UNBLIND-KEY.json"), "utf8"));
  const csvRows = parseCsv(readFileSync(path.join(bundle, "scorecard.csv"), "utf8"));
  const [header, ...rows] = csvRows;
  const verdictCol = header.indexOf("verdict");
  const notesCol = header.indexOf("notes");
  const reviewCol = header.indexOf("review");

  const byTask = {};
  for (const row of rows) {
    const label = row[reviewCol];
    const key = unblindKey[label];
    if (!key) continue;
    const verdict = row[verdictCol]?.trim();
    if (!verdict) {
      console.warn(`Warning: ${label} has no verdict yet — scoring is incomplete`);
    }
    byTask[key.task] ??= {};
    byTask[key.task][key.variant] = { verdict, notes: row[notesCol] };
  }

  console.log("task".padEnd(20), "context".padEnd(18), "bare".padEnd(18));
  const tally = { context: {}, bare: {} };
  for (const [task, variants] of Object.entries(byTask)) {
    const c = variants.context?.verdict || "(missing)";
    const b = variants.bare?.verdict || "(missing)";
    tally.context[c] = (tally.context[c] || 0) + 1;
    tally.bare[b] = (tally.bare[b] || 0) + 1;
    console.log(task.padEnd(20), c.padEnd(18), b.padEnd(18));
  }

  console.log("\nAggregate verdict counts:");
  console.log("  context:", JSON.stringify(tally.context));
  console.log("  bare:   ", JSON.stringify(tally.bare));
  console.log(
    "\nThis is a tally, not a conclusion — read the notes and discuss per the issue's"
  );
  console.log('"What each outcome means" section before deciding Phase 1 starts.');
}

function main() {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);
  if (command === "prepare") return cmdPrepare(args);
  if (command === "unblind") return cmdUnblind(args);
  console.error("Usage:");
  console.error("  phase0-blind-review.mjs prepare --base <ref> --pairs <pairs.json> --out <dir>");
  console.error("  phase0-blind-review.mjs unblind --bundle <dir>");
  process.exit(1);
}

main();
