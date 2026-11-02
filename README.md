# Fieldnotes Kanban

A small Kanban board with email accounts and per-user Supabase sync. Tasks and subtasks are standalone cards that can move freely between Kanban columns. Subtasks show the original task title and have a distinct visual treatment.

## Set up Supabase

1. Create a Supabase project.
2. In the Supabase SQL Editor, run the contents of `supabase-schema.sql`. If the project already has the older parent/child schema, rerun the script: existing subtasks become standalone cards with their original task title preserved, and the parent relationship is removed. Existing tasks are retained.
3. In Project Settings, copy the project URL and the publishable key (or legacy `anon` key) into `supabase-config.js`.
4. In Authentication URL Configuration, set the Site URL to your GitHub Pages address and add that same address to the allowed redirect URLs.
5. In Authentication settings, choose whether new accounts require email confirmation.
6. Commit and push the changes to `main`. GitHub Pages will deploy the updated board.
7. Open the published site, create your account, and confirm your email if prompted.

The URL and publishable/anon key are intended for browser use. Never put a Supabase secret or service-role key in this project. The table's row-level security policies are what restrict access to each user's own tasks.

On the first sign-in, existing browser tasks are copied into that account's Supabase table once. The browser copy is removed after the database confirms the import.

## Deploy the AI assistant

The assistant uses OpenRouter's `openrouter/free` model router through a Supabase Edge Function. It selects from available free models and only falls back to other free models. OpenRouter currently limits free-model requests to 50 per day for accounts that haven't purchased credits; see OpenRouter's usage information for current limits.

1. Create an API key in your OpenRouter account.
2. In your Supabase project, open **Edge Functions → Secrets** and add `OPENROUTER_API_KEY`. Keep the key out of GitHub and `supabase-config.js`.
3. Deploy the function named `kanban-assistant` from `supabase/functions/kanban-assistant/index.ts`. You can deploy it in the Supabase Dashboard under **Edge Functions**, or use the CLI below (Node.js/npm required):

	```powershell
	npx supabase login
	npx supabase link --project-ref rcujgnbbbgclatffbmml
	npx supabase functions deploy kanban-assistant
	```

4. Commit and push the website changes to `main` so GitHub Pages deploys the assistant interface.
5. Optional: to let the assistant run from other web addresses (for example a Codespaces URL), add an Edge Function secret `ALLOWED_ORIGINS` with comma-separated exact origins, such as `https://<codespace-name>-8080.app.github.dev`. `https://provenri.github.io` is always allowed. Redeploy the function once after updating `index.ts`; later changes to the secret need no redeploy. Avoid wildcards, because they would let anyone's page use your OpenRouter quota.

The function verifies the signed-in Supabase user and reads tasks under the existing row-level security policies. OpenRouter and its selected model provider receive the task titles, notes, and your prompt. In chat, the assistant can propose task creation, edits, moves, and deletions. Breaking down a task proposes standalone subtasks and removal of the original task. The function validates proposals but never writes tasks; review the preview and click **Apply changes** to perform the operations with your signed-in account. Discarding a proposal leaves the board unchanged. Review OpenRouter's privacy settings and usage limits before sharing the site.

## Undo

The **Undo** button in the top bar reverts the last change you made (create, edit, move, delete, or one whole AI **Apply changes**). It is always visible and disabled when there is nothing to undo. History keeps the last 50 changes for the current browser session and is cleared on sign-out or when switching accounts. It needs no schema change or Edge Function deployment.

## Run locally

You can open `index.html` to preview the page, but Supabase authentication needs an allowed web URL. For a full sign-in test, use the GitHub Pages address configured in Supabase. No build step is needed.

## Tests

Browser tests live in `tests/` and use Playwright with an in-memory fake of the Supabase client, so they never touch your real project or data. They cover Undo, drag-and-drop, sorting, subtask colours, error handling and the assistant's Apply changes flow.

```bash
npm install
npx playwright install chromium   # first time only (the Codespace does this for you)
npm test
```

Playwright starts its own static server on port 4173. To inspect a failed run, use `npx playwright show-trace` on the trace in `test-results/`.

## Cloud sandbox (GitHub Codespaces)

The repository includes a `.devcontainer` config. On GitHub, choose **Code → Codespaces → Create codespace on main**. The container has Node 22 and the project's dev dependencies (Playwright with Chromium, `http-server`) installed by `npm install`, and serves the board on port 8080 (forwarded automatically). Open it in your normal browser from the **Ports** tab (globe icon); VS Code's embedded Simple Browser can't open private forwarded ports. Run `node --version` or `npx playwright --version` in the terminal to check.

### Supabase settings for Codespaces

Signing in with an existing email and password works from the codespace without changes. New sign-ups that need email confirmation return to the codespace address, so allow it in Supabase:

1. In the codespace, open the **Ports** tab and copy the forwarded address for port 8080 (`https://<codespace-name>-8080.app.github.dev`).
2. In the Supabase dashboard, go to **Authentication → URL Configuration**.
3. Under **Redirect URLs**, click **Add URL** and paste that address. Alternatively add `https://*.app.github.dev/**` so new codespaces work without further changes. The wildcard is looser, so prefer a single URL if you can.
4. Keep the **Site URL** set to your GitHub Pages address, then click **Save**.

Notes:
- The address changes for each new codespace.
- Port 8080 is private by default, so you must be signed in to GitHub to open it.
- The codespace uses the same Supabase project as the live site, so tasks created there appear on the live board for the same account. Use a separate test account to keep them apart.
## GitHub Pages

In the repository's **Settings → Pages**, deploy from the `main` branch and the `/(root)` folder.