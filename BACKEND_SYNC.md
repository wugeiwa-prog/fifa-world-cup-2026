# Cross-device betting sync

The page supports optional Supabase REST sync for the local betting database.

1. Create a Supabase project.
2. Run this SQL:

```sql
create table if not exists public.wc2026_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.wc2026_state enable row level security;

create policy "public read wc2026 state"
on public.wc2026_state for select
to anon
using (true);

create policy "public upsert wc2026 state"
on public.wc2026_state for insert
to anon
with check (id = 'global');

create policy "public update wc2026 state"
on public.wc2026_state for update
to anon
using (id = 'global')
with check (id = 'global');
```

3. In `world-cup-2026-schedule.html`, fill:

```js
const REMOTE_SYNC={
  enabled:true,
  provider:"supabase",
  url:"https://YOUR_PROJECT.supabase.co",
  anonKey:"YOUR_SUPABASE_ANON_KEY",
  table:"wc2026_state",
  rowId:"global"
};
```

Do not use a Supabase service-role key in the frontend.
