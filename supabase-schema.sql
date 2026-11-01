create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 90),
  description text not null default '' check (char_length(description) <= 240),
  status text not null check (status in ('todo', 'progress', 'done')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  is_subtask boolean not null default false,
  source_task_title text,
  created_at timestamptz not null default now()
);

alter table public.tasks add column if not exists is_subtask boolean not null default false;
alter table public.tasks add column if not exists source_task_title text;

drop trigger if exists tasks_enforce_parent_completion on public.tasks;
drop function if exists public.enforce_parent_task_completion();
alter table public.tasks drop constraint if exists tasks_parent_owner_fkey;
alter table public.tasks drop constraint if exists tasks_parent_not_self;
alter table public.tasks drop constraint if exists tasks_subtask_status;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'tasks'
      and column_name = 'parent_id'
  ) then
    execute $migration$
      update public.tasks as child
      set is_subtask = true,
          source_task_title = parent.title
      from public.tasks as parent
      where child.parent_id = parent.id
        and child.is_subtask = false
    $migration$;

    alter table public.tasks drop column parent_id cascade;
  end if;
end
$$;

drop index if exists public.tasks_parent_id_idx;
drop index if exists public.tasks_id_user_id_unique;
alter table public.tasks drop constraint if exists tasks_task_kind_metadata;
alter table public.tasks
  add constraint tasks_task_kind_metadata
  check (
    (is_subtask = false and source_task_title is null)
    or (is_subtask = true and char_length(btrim(source_task_title)) between 1 and 90)
  );

alter table public.tasks enable row level security;
grant select, insert, update, delete on table public.tasks to authenticated;

drop policy if exists "Users can read their own tasks" on public.tasks;
create policy "Users can read their own tasks"
  on public.tasks for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can create their own tasks" on public.tasks;
create policy "Users can create their own tasks"
  on public.tasks for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own tasks" on public.tasks;
create policy "Users can update their own tasks"
  on public.tasks for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own tasks" on public.tasks;
create policy "Users can delete their own tasks"
  on public.tasks for delete to authenticated
  using (auth.uid() = user_id);