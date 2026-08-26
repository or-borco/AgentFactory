# Prompt-ordering experiment harness

Scripts behind `docs/superpowers/experiments/2026-08-26-prompt-layer-ordering.md`.

They replay a real run's stored prompt layers against the API under different orderings and
score each response mechanically against the instructions those layers contained.

Both read `segments.json` from their own directory — the `prompt_segments` jsonb of the run you
want to replay:

```bash
docker exec agentfactory-postgres-1 psql -U agentfactory -d agentfactory -At \
  -c "select jsonb_agg(seg order by ord) from runs r, jsonb_array_elements(r.prompt_segments) with ordinality a(seg,ord) where r.id=<RUN_ID>;" \
  > segments.json
```

Then, with `ANTHROPIC_API_KEY` exported:

```bash
TRIALS=5 node run-experiment.mjs   # single turn
TRIALS=5 node run-agentic.mjs      # long intervening transcript
```

The user message and the compliance checks are hard-coded to the release-notes task that
prompted the original experiment. Repointing them at a different run means editing both to match
that run's task and the instructions its layers actually state.
