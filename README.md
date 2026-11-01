# Fieldnotes Kanban

A small Kanban board with email accounts, per-user Supabase sync, and nested task checklists. Parent tasks appear in Kanban columns; subtasks are checkable items inside each parent card, with a completion count and progress bar. A parent can move to Done only when all its subtasks are done.

## Set up Supabase

1. Create a Supabase project.
2. In the Supabase SQL Editor, run the contents of `supabase-schema.sql`. If the project already has a `tasks` table, rerun the script to add the `parent_id` relationship and completion trigger; the migration is idempotent.
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

The function verifies the signed-in Supabase user and reads tasks under the existing row-level security policies. OpenRouter and its selected model provider receive the task titles, notes, and your prompt. In chat, the assistant can propose task creation, edits, moves, and deletions. The function validates proposals but never writes tasks; review the preview and click **Apply changes** to perform the operations with your signed-in account. Discarding a proposal leaves the board unchanged. Review OpenRouter's privacy settings and usage limits before sharing the site.

## Run locally

You can open `index.html` to preview the page, but Supabase authentication needs an allowed web URL. For a full sign-in test, use the GitHub Pages address configured in Supabase. No build step is needed.

## GitHub Pages

In the repository's **Settings → Pages**, deploy from the `main` branch and the `/(root)` folder.