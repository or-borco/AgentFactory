# Setting up Jira

Unlike the GitHub App, there's nothing to register ahead of time — connecting Jira is entirely
self-service from the Connections UI, using a Jira Cloud API token. See
`docs/superpowers/specs/2026-09-12-jira-integration-design.md` for the full design and the product
decisions behind what is and isn't supported (linked throughout this doc).

## What this gets you

- Connect one Jira Cloud site per org as a `tasks`-kind connection.
- Create a task by pasting a Jira issue key or URL — this prefills the title and description, and
  pulls in the issue's attachments (text/markdown ones become readable by the agent; others are
  still listed, just not readable — see Design decision 10 in the spec).
- When a run opens a PR for a linked task, the Jira issue gets a comment linking the PR back
  (comment only — there is no status-transition support, and there won't be; see Product
  decision 3 in the spec for why).
- A **Refresh** action and an automatic pre-run check that catches drift between the task and the
  linked issue, prompting you to update before running on stale content.

## 1. Generate a Jira API token

At [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens),
create a **classic API token** (not a *scoped* one — Atlassian's newer scoped tokens are meant to
be used as OAuth-style bearer tokens against `api.atlassian.com`, not HTTP Basic auth against your
site directly, which is what this integration uses).

Use a dedicated Jira service account rather than your personal one if you can — a Jira API token
carries the full permissions of whoever created it, which is the integration's biggest security
tradeoff (see Design decision 1 in the spec, and Risks).

## 2. Connect the site

From **Settings → Connections**, click **Connect Jira**. You'll be asked for:

- **Site URL** — your Jira Cloud site, e.g. `https://your-team.atlassian.net`. Must be an
  `https://*.atlassian.net` address — Jira Data Center/Server isn't supported.
- **Account email** — the email of the Atlassian account that generated the token above.
- **API token** — from step 1.

Only one `tasks`-kind connection is allowed per org — if one already exists (Jira or otherwise),
connecting will fail with "Already connected to {label}. Disconnect it before connecting another."
This is deliberate (Design decision 15 in the spec), not a bug: disconnect the existing one first
if you need to switch sites or accounts.

## 3. Use it

- **Tasks → New task** gets a **From issue** field once a Jira connection exists (it's disabled
  with a tooltip until then). Paste an issue key (`PROJ-123`) or a browse URL and click **Fetch**.
- The task detail page shows a linked-issue badge and the issue's attachments once a task is
  created this way.
- On the Connections page, each Jira connection has a **Configure** panel with a single
  **Comment on PR open** toggle — the only write-back setting there is.
- On a linked task's detail page, **Refresh** checks the linked issue for changes; clicking **Run**
  on a task whose linked issue has changed since it was last synced prompts you to update first
  rather than running on stale content.

## Troubleshooting

**"Client must be authenticated to access this resource" when connecting.** This is Jira Cloud's
own generic auth-rejection message, passed straight through from `JiraTaskProvider.verify()` — not
something our code generates. Isolate whether it's actually Jira rejecting the request, or
something else, by hitting the exact same endpoint directly:

```bash
curl -u "your-email@example.com:your-api-token" \
  -H "Accept: application/json" \
  "https://your-site.atlassian.net/rest/api/3/myself"
```

If curl gets the same error, the credentials/site are the problem, not the app — check, roughly in
order of likelihood:

1. **Token propagation delay.** A freshly-generated token can take a minute or two to actually
   activate even though the UI shows it as created immediately — this alone accounts for most
   "definitely fresh, still fails" reports. Wait a minute and retry.
2. **A scoped token instead of a classic one** — see step 1 above.
3. **An org authentication policy blocking API tokens.** Check `admin.atlassian.com` → your org →
   **Security** → **User security** → **Authentication policies** for anything restricting
   API-token/Basic-auth access. Only relevant if your org has verified a domain; if authentication
   policies aren't set up at all, this isn't it.
4. **A stray character in the token or email** from a copy-paste — paste into a plain text editor
   first to check for invisible leading/trailing whitespace.

If curl succeeds but connecting through the app still fails, that *is* an app-side bug — the
request our server makes should be identical to curl's. Worth checking `CONNECTION_SECRET_KEY` is
actually set (`./scripts/setup-env.sh` / `.\scripts\setup-env.ps1` on Windows, see the main
[README](../../README.md)) before assuming it's the Jira request itself; a missing encryption key
fails at the "store the credential" step, which happens right after a successful `verify()`, and
produces an unrelated 500 that's easy to conflate with the auth error above if you're not looking
closely at which request actually failed.
