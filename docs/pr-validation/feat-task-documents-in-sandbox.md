# Validating: task documents in the sandbox (#152)

What to look at to convince yourself this works, in rough order of effort.

## The one-line claim

A document attached to a task now exists as a real file in the agent's checkout, and git cannot
see it. Before this, the agent got 22% of the document as retrieval excerpts and nothing else.

---

## 1. The regression this prevents, reproduced from the run that motivated it

Task T-070 / run 27. The agent had a 5,635-byte spec attached, received 1,504 bytes of it, then:

```
find / -iname "*retry-spec*"
find / -iname "*transcriber-retry*"
```

> *"Since the retry spec isn't in the repo, I'll rely on the retrieved excerpts as the spec instead."*

To reproduce the fixed behaviour end to end:

1. Create a task with `codebase` set to a repo you have connected.
2. Attach `docs/superpowers/specs/2026-09-03-task-70-analysis-design.md` (or any `.md`) to it.
3. Wait for the document's status to reach **indexed** on the task page.
4. Run the task with a message like *"Read the attached document and summarise its section 3."*

**What you should see:**

- The worker log carries a new phase line: `[run N] task documents (1 written): …ms`
- The run's prompt (Context panel → Environment segment) names the file:
  `` `.agentfactory/context/<your-file>.md` `` and says the files are complete.
- The agent reads the file directly rather than running `find`.
- The answer reflects content that is **not** in the retrieval excerpts — section 3 is deep in the
  document and would never win the reserved slice at today's budget.

## 2. The part that would quietly ruin a pull request

The agent's changes are pushed by `pushChangesIfDirty`, which runs `git add -A` and decides there
is something to push from `git status --porcelain`. Without the exclude, attaching a document
would (a) commit it into the user's PR and (b) make a run that changed nothing look dirty.

**Check it by hand, no platform needed:**

```bash
cd "$(mktemp -d)" && git init -q . && git config user.email a@b.c && git config user.name t
echo "# repo" > README.md && git add -A && git commit -qm initial
printf '/.agentfactory/\n' >> .git/info/exclude
mkdir -p .agentfactory/context && echo "# attached spec" > .agentfactory/context/spec.md
git status --porcelain          # expect: empty
git add -A && git diff --cached --name-only   # expect: empty
```

Remove the `printf` line and re-run to see the bug this prevents.

**Or just run the tests that do exactly this against real git:**

```bash
npx vitest run --project unit apps/worker/src/__tests__/task-documents.test.ts
```

`TASK_DOCUMENT_EXCLUDE_PATTERN against real git` builds a real repository in a temp dir and
asserts six things, including that a source change made *alongside* the documents still gets
staged, and that a repo with its own nested `.agentfactory/` directory keeps it.

## 3. Showcase — the prompt text itself

The fastest read on whether this does its job is the environment segment the agent now receives:

```
- The documents attached to this task are already in your checkout at
  `/workspace/.agentfactory/context`: `.agentfactory/context/spec.md`. These are the complete
  files — read them directly rather than searching for them, and prefer them over any excerpt of
  the same document quoted elsewhere in this prompt. They are untracked and excluded from git;
  leave them out of your commits.
```

Two deliberate phrases: *"rather than searching for them"* answers the `find /` directly, and
*"prefer them over any excerpt"* resolves the conflict when the same document appears in both the
retrieved-context layer and on disk.

When something did not fit the 1 MB budget, a second line names it — so the agent cannot read the
directory as the complete set.

---

## Test coverage against the issue's acceptance criteria

| Criterion | Where |
|---|---|
| Document present in sandbox, byte-identical | `task-documents.test.ts` — "writes every indexed document…" asserts the exact `writeFiles` payload |
| Environment names the directory, files, and completeness | `prompt-composition.test.ts` — "names the attached documents and says they are complete" |
| Run that changes nothing pushes nothing | `task-documents.test.ts` — "with it, a materialised document leaves the checkout clean" |
| PR diff contains no `.agentfactory/` paths | `task-documents.test.ts` — "survives `git add -A`" and "leaves nothing behind in the tree" |
| Oversized attachments truncate at file granularity and are declared | `task-documents.test.ts` — "omits a document that would exceed the total budget…" + `prompt-composition.test.ts` — "names documents that did not fit" |
| A write failure never fails the run | `task-documents.test.ts` — "degrades to an empty result when…" (db throw, writeFiles throw, missing blob) |

**29 new unit tests.** Full suite on this branch: unit 515 ✓, db-integration 149 ✓,
queue-integration 11 ✓ (baseline on `main` was 486 / 149 / 11).

## What is not covered, and why

- **No e2e run.** This branch touches only `apps/worker`; the Playwright suite exercises
  `apps/web`. It was green on `main` and nothing here can move it. (It also cannot start locally
  while another `next dev` is running from this directory — Next's guard is per-directory, not
  per-port.)
- **No test drives a real Docker sandbox.** `writeFiles` → `putArchive` is exercised against a
  fake provider. This is the repo's existing convention for every sandbox-touching module
  (`repo-map.ts`, `scm-provider.ts`), and the reason step 1 above is worth doing by hand once.

## Things worth a second opinion in review

- **1 MB total budget** (`TASK_DOCUMENTS_BUDGET_BYTES`) is a judgement call, not a measurement —
  ~150× the document that motivated this, and well under one maximal 2 MB upload.
- **`continue` rather than `break`** on the budget: one oversized attachment does not hide the
  smaller ones behind it. Same reasoning as #154's change to `selectWithinBudget`, opposite to
  what the team-retrieval path does today.
- **`sanitiseDocumentName` is deliberately aggressive.** Titles are user-supplied and become
  paths, so anything outside `[A-Za-z0-9._-]` collapses to a dash and leading dots are stripped.
  A document titled `.env.example` lands as `env.example`.
