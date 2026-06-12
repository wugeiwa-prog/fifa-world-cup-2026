# Cross-device betting sync

The page now uses Supabase REST sync for the betting leaderboard and public betting state.
Current frontend config is already filled in `world-cup-2026-schedule.html`.

Synced public data:

- up to 11 player nicknames
- virtual coin balances
- bet slips and settlement status
- daily leaderboard snapshots

Not synced:

- local password hashes
- browser access password state
- any real-money data

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
The anon public key is enough only because the table policies above allow public read and public upsert for the single `global` row.
This is suitable for the current entertainment-only static site, but it is not a fraud-proof betting backend.
