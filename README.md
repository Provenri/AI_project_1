# Fieldnotes Kanban

A small Kanban board with email accounts and per-user task sync through Supabase. Tasks are protected by row-level security so each account can only access its own rows.

## Set up Supabase

1. Create a Supabase project.
2. In the Supabase SQL Editor, run the contents of `supabase-schema.sql`.
3. In Project Settings, copy the project URL and the publishable key (or legacy `anon` key) into `supabase-config.js`.
4. In Authentication URL Configuration, set the Site URL to your GitHub Pages address and add that same address to the allowed redirect URLs.
5. In Authentication settings, choose whether new accounts require email confirmation.
6. Commit and push the changes to `main`. GitHub Pages will deploy the updated board.
7. Open the published site, create your account, and confirm your email if prompted.

The URL and publishable/anon key are intended for browser use. Never put a Supabase secret or service-role key in this project. The table's row-level security policies are what restrict access to each user's own tasks.

On the first sign-in, existing browser tasks are copied into that account's Supabase table once. The browser copy is removed after the database confirms the import.

## Run locally

You can open `index.html` to preview the page, but Supabase authentication needs an allowed web URL. For a full sign-in test, use the GitHub Pages address configured in Supabase. No build step is needed.

## GitHub Pages

In the repository's **Settings → Pages**, deploy from the `main` branch and the `/(root)` folder.