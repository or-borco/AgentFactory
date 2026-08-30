import { describe, expect, it } from "vitest";
import "../setup.js";
import type { RunEvalResult } from "@agentfactory/core";
import { createRun } from "../../repositories/runs.js";
import {
  completeEval,
  createRunEval,
  failEval,
  getRunEval,
  listEvalsForRun,
  markEvalRunning,
} from "../../repositories/run-evals.js";
import { insertAgent, insertOrg, insertSession } from "../fixtures.js";

async function setupRun() {
  const org = await insertOrg();
  const agent = await insertAgent(org.id);
  const session = await insertSession(org.id, agent.id);
  const run = await createRun(session.id);
  return { org, run };
}

const RESULT: RunEvalResult = {
  artefactKind: "diff",
  score: 0.5,
  layers: [
    {
      segmentId: "team_context",
      requirements: [
        { text: "Use conventional commit messages", verdict: "pass", evidence: "feat(core): add parser" },
        { text: "Update the changelog", verdict: "fail", evidence: "No CHANGELOG edit anywhere in the diff" },
      ],
    },
  ],
};

describe("run-evals repository", () => {
  it("creates a queued eval and reads it back", async () => {
    const { org, run } = await setupRun();
    const runEval = await createRunEval(org.id, run.id);

    expect(runEval).toMatchObject({ orgId: org.id, runId: run.id, status: "queued" });
    expect(runEval.result).toBeUndefined();
    expect(runEval.completedAt).toBeUndefined();
    await expect(getRunEval(runEval.id)).resolves.toEqual(runEval);
  });

  it("walks queued → running → done, storing the result and judge model", async () => {
    const { org, run } = await setupRun();
    const runEval = await createRunEval(org.id, run.id);

    await markEvalRunning(runEval.id);
    await expect(getRunEval(runEval.id)).resolves.toMatchObject({ status: "running" });

    const done = await completeEval(runEval.id, RESULT, "claude-sonnet-5");
    expect(done).toMatchObject({ status: "done", result: RESULT, judgeModelId: "claude-sonnet-5" });
    expect(done.completedAt).toBeDefined();
    expect(done.error).toBeUndefined();
  });

  it("fails an eval with a machine-readable reason", async () => {
    const { org, run } = await setupRun();
    const runEval = await createRunEval(org.id, run.id);

    const failed = await failEval(runEval.id, "artefact_unavailable");
    expect(failed).toMatchObject({ status: "failed", error: "artefact_unavailable" });
    expect(failed.result).toBeUndefined();
    expect(failed.completedAt).toBeDefined();
  });

  it("lists evals for a run newest first, scoped to the org", async () => {
    const { org, run } = await setupRun();
    const first = await createRunEval(org.id, run.id);
    const second = await createRunEval(org.id, run.id);

    const listed = await listEvalsForRun(run.id, org.id);
    expect(listed.map((e) => e.id)).toEqual([second.id, first.id]);

    const otherOrg = await insertOrg({ slug: `other-${Date.now()}` });
    await expect(listEvalsForRun(run.id, otherOrg.id)).resolves.toEqual([]);
  });
});
