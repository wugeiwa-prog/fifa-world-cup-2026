# Supabase 多表同步

当前代码优先读写多表；如果新表未创建，会自动回退旧的 `wc2026_state` 单行 JSON。

在 Supabase SQL Editor 执行：

```sql
create table if not exists public.wc2026_users (
  name text primary key,
  balance integer not null default 1000,
  created_at bigint not null,
  updated_at bigint not null
);

create table if not exists public.wc2026_bets (
  id text primary key,
  user_name text not null,
  mid text not null,
  type text not null,
  pick text not null,
  odds numeric not null,
  stake integer not null,
  status text not null,
  payout integer,
  placed_at bigint not null,
  settled_at bigint,
  updated_at bigint not null
);

create table if not exists public.wc2026_daily (
  day text not null,
  user_name text not null,
  balance integer not null,
  primary key (day, user_name)
);

create table if not exists public.wc2026_results (
  mid text primary key,
  score text not null,
  status text not null,
  source text,
  source_url text,
  updated_at timestamptz not null default now()
);

create table if not exists public.wc2026_odds (
  mid text primary key,
  h numeric not null,
  d numeric not null,
  a numeric not null,
  source text,
  url text,
  market text default '1X2',
  updated_at timestamptz not null default now()
);

create table if not exists public.wc2026_comments (
  id text primary key,
  user_name text not null,
  text text not null,
  created_at bigint not null,
  updated_at bigint not null
);

create table if not exists public.wc2026_comment_replies (
  id text primary key,
  comment_id text not null references public.wc2026_comments(id) on delete cascade,
  user_name text not null,
  text text not null,
  created_at bigint not null
);

create table if not exists public.wc2026_sync_meta (
  key text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.wc2026_users enable row level security;
alter table public.wc2026_bets enable row level security;
alter table public.wc2026_daily enable row level security;
alter table public.wc2026_results enable row level security;
alter table public.wc2026_odds enable row level security;
alter table public.wc2026_comments enable row level security;
alter table public.wc2026_comment_replies enable row level security;
alter table public.wc2026_sync_meta enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'wc2026_users','wc2026_bets','wc2026_daily','wc2026_results',
    'wc2026_odds','wc2026_comments','wc2026_comment_replies','wc2026_sync_meta'
  ] loop
    execute format('drop policy if exists "public read %1$s" on public.%1$I', t);
    execute format('drop policy if exists "public insert %1$s" on public.%1$I', t);
    execute format('drop policy if exists "public update %1$s" on public.%1$I', t);
    execute format('create policy "public read %1$s" on public.%1$I for select to anon using (true)', t);
    execute format('create policy "public insert %1$s" on public.%1$I for insert to anon with check (true)', t);
    execute format('create policy "public update %1$s" on public.%1$I for update to anon using (true) with check (true)', t);
  end loop;
end $$;
```

如旧 `wc2026_state` 里已有数据，继续执行一次迁移：

```sql
with s as (select data from public.wc2026_state where id='global')
insert into public.wc2026_users(name,balance,created_at,updated_at)
select key, coalesce((value->>'balance')::int,1000), coalesce((value->>'createdAt')::bigint,0), coalesce((value->>'updatedAt')::bigint,0)
from s, jsonb_each(s.data->'users')
on conflict (name) do update set balance=excluded.balance, updated_at=excluded.updated_at;

with s as (select data from public.wc2026_state where id='global')
insert into public.wc2026_bets(id,user_name,mid,type,pick,odds,stake,status,payout,placed_at,settled_at,updated_at)
select b->>'id', b->>'user', b->>'mid', b->>'type', b->>'pick',
       (b->>'odds')::numeric, (b->>'stake')::int, b->>'status',
       nullif(b->>'payout','')::int, coalesce((b->>'placedAt')::bigint,0),
       nullif(b->>'settledAt','')::bigint, coalesce((b->>'updatedAt')::bigint,(b->>'settledAt')::bigint,(b->>'placedAt')::bigint,0)
from s, jsonb_array_elements(coalesce(s.data->'bets','[]'::jsonb)) b
where b ? 'id'
on conflict (id) do update set status=excluded.status,payout=excluded.payout,settled_at=excluded.settled_at,updated_at=excluded.updated_at;

with s as (select data from public.wc2026_state where id='global')
insert into public.wc2026_daily(day,user_name,balance)
select d.key, r->>'user', (r->>'balance')::int
from s, jsonb_each(coalesce(s.data->'daily','{}'::jsonb)) d, jsonb_array_elements(d.value) r
on conflict (day,user_name) do update set balance=excluded.balance;

with s as (select data from public.wc2026_state where id='global')
insert into public.wc2026_results(mid,score,status,source,source_url,updated_at)
select key, value->>'score', coalesce(value->>'status','final'), value->>'source', value->>'sourceUrl',
       coalesce(nullif(value->>'updatedAt','')::timestamptz, now())
from s, jsonb_each(coalesce(s.data->'results','{}'::jsonb))
where value ? 'score'
on conflict (mid) do update set score=excluded.score,status=excluded.status,updated_at=excluded.updated_at;

with s as (select data from public.wc2026_state where id='global')
insert into public.wc2026_odds(mid,h,d,a,source,url,market,updated_at)
select key, (value->>'h')::numeric, (value->>'d')::numeric, (value->>'a')::numeric,
       value->>'source', value->>'url', coalesce(value->>'market','1X2'),
       coalesce(nullif(value->>'updatedAt','')::timestamptz, now())
from s, jsonb_each(coalesce(s.data->'odds','{}'::jsonb))
where value ? 'h'
on conflict (mid) do update set h=excluded.h,d=excluded.d,a=excluded.a,updated_at=excluded.updated_at;

with s as (select data from public.wc2026_state where id='global')
insert into public.wc2026_comments(id,user_name,text,created_at,updated_at)
select c->>'id', c->>'user', c->>'text', coalesce((c->>'createdAt')::bigint,0), coalesce((c->>'updatedAt')::bigint,(c->>'createdAt')::bigint,0)
from s, jsonb_array_elements(coalesce(s.data->'comments','[]'::jsonb)) c
where c ? 'id'
on conflict (id) do update set text=excluded.text,updated_at=excluded.updated_at;

with s as (select data from public.wc2026_state where id='global')
insert into public.wc2026_comment_replies(id,comment_id,user_name,text,created_at)
select r->>'id', c->>'id', r->>'user', r->>'text', coalesce((r->>'createdAt')::bigint,0)
from s, jsonb_array_elements(coalesce(s.data->'comments','[]'::jsonb)) c,
     jsonb_array_elements(coalesce(c->'replies','[]'::jsonb)) r
where r ? 'id'
on conflict (id) do update set text=excluded.text;

with s as (select data from public.wc2026_state where id='global')
insert into public.wc2026_sync_meta(key,data,updated_at)
select 'resultSync', coalesce(data->'resultSync','{}'::jsonb), now() from s
union all
select 'oddsSync', coalesce(data->'oddsSync','{}'::jsonb), now() from s
on conflict (key) do update set data=excluded.data, updated_at=excluded.updated_at;
```

说明：这是朋友间娱乐项目，前端仍使用 anon public key；RLS 允许公开读写这些竞猜表，不适合作为严肃防作弊系统。
