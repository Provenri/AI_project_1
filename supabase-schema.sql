create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 90),
  description text not null default '' check (char_length(description) <= 240),
  status text not null check (status in ('todo', 'progress', 'done')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  parent_id uuid,
  constraint tasks_subtask_status check (parent_id is null or status in ('todo', 'done')),
  created_at timestamptz not null default now()
);

alter table public.tasks add column if not exists parent_id uuid;
create unique index if not exists tasks_id_user_id_unique on public.tasks (id, user_id);
create index if not exists tasks_parent_id_idx on public.tasks (parent_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tasks_parent_owner_fkey'
      and conrelid = 'public.tasks'::regclass
  ) then
    alter table public.tasks
      add constraint tasks_parent_owner_fkey
      foreign key (parent_id, user_id)
      references public.tasks (id, user_id)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'tasks_parent_not_self'
      and conrelid = 'public.tasks'::regclass
  ) then
    alter table public.tasks
      add constraint tasks_parent_not_self
      check (parent_id is null or parent_id <> id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'tasks_subtask_status'
      and conrelid = 'public.tasks'::regclass
  ) then
    alter table public.tasks
      add constraint tasks_subtask_status
      check (parent_id is null or status in ('todo', 'done'));
  end if;
end
$$;

alter table public.tasks enable row level security;
grant select, insert, update, delete on table public.tasks to authenticated;

create or replace function public.enforce_parent_task_completion()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  parent_status text;
begin
  if new.parent_id is null then
    if new.status = 'done' and exists (
      select 1
      from public.tasks as subtask
      where subtask.parent_id = new.id
        and subtask.status <> 'done'
    ) then
      raise exception 'Complete all subtasks before moving the parent task to Done.'
        using errcode = '23514';
    end if;
  else
    select parent.status
      into parent_status
      from public.tasks as parent
      where parent.id = new.parent_id
        and parent.user_id = new.user_id;

    if parent_status = 'done' and new.status <> 'done' then
      raise exception 'Move the parent task out of Done before reopening or adding a subtask.'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_enforce_parent_completion on public.tasks;
create trigger tasks_enforce_parent_completion
  before insert or update on public.tasks
  for each row execute function public.enforce_parent_task_completion();

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