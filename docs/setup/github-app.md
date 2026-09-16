# Setting up the GitHub App

Connections to GitHub (cloning repos, opening PRs) go through a single GitHub App shared by the
web app and worker. Rather than hand-filling GitHub's app-creation form, the repo has a one-time
admin route that uses GitHub's manifest flow to create it for you.

Run these from the repo root, after you've completed the main [setup](../../README.md) through
step 1 (`./scripts/setup-env.sh`, or `.\scripts\setup-env.ps1` on Windows).

1. Start the web app (`pnpm dev`) and log in (the seeded `demo@acme.test` user works; the route
   just requires an authenticated session, no separate admin role today).
2. Visit [http://localhost:3000/api/admin/github-app/register](http://localhost:3000/api/admin/github-app/register).
   This redirects to GitHub with a pre-filled app manifest (name, permissions, callback URLs)
   and asks you to confirm creation.
3. After confirming, GitHub redirects back to the app's callback route, which exchanges the
   one-time code for real credentials and prints them out.
4. Copy the printed values into the root `.env.local`:
   ```
   GITHUB_APP_ID=...
   GITHUB_APP_SLUG=...          # web only
   GITHUB_APP_PRIVATE_KEY=...
   ```
5. Restart the dev server(s) so the new env vars are picked up.
6. Install the app on the GitHub org/repos you want to connect from the org's Connections page in
   the UI (or from the app's settings page on GitHub directly).

Because this registers a real (unlisted) GitHub App tied to whatever origin you ran it from, doing
this against `http://localhost:3000` is fine for local dev — you'll just re-run it if your local
URL ever changes.
