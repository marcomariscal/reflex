-- Reflex: agents, baselines, payments, holds.
-- Lives in the private `reflex` schema, which PostgREST/GraphQL do not expose.
-- RLS is on with no policies as a second lock. Edge functions connect as the
-- table owner via SUPABASE_DB_URL, which RLS does not restrict.

create schema if not exists reflex;
revoke all on schema reflex from public, anon, authenticated;

create table reflex.agents (
  id text primary key,
  key_hash text not null unique,            -- sha256 hex of the agent key
  per_payment_cap_usd numeric not null default 25,
  daily_cap_usd numeric not null default 100,
  velocity_limit int not null default 10,
  velocity_window_s int not null default 60,
  paused_at timestamptz,
  resumed_at timestamptz,                   -- velocity only counts payments after this
  created_at timestamptz not null default now()
);

create table reflex.baselines (
  agent_id text not null references reflex.agents (id) on delete cascade,
  recipient text not null,                  -- 0x address, lowercased
  max_usd numeric not null,                 -- largest payment this payee has been paid
  payment_count int not null default 0,
  source text not null check (source in ('seed', 'approved')),
  seed_max_usd numeric,                     -- non-null on seed rows; admin/reset restores it
  first_seen_at timestamptz not null default now(),
  last_paid_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (agent_id, recipient)
);

create table reflex.payments (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null references reflex.agents (id) on delete cascade,
  url text,
  http_method text,
  reason text not null,
  challenge jsonb not null,                 -- normalized challenge, including raw header
  realm text not null,
  recipient text not null,
  amount_usd numeric not null,
  checks jsonb not null,
  status text not null check (status in ('signed', 'held', 'denied', 'expired', 'failed')),
  credential text,
  tx_hash text,
  error text,
  http_status int,
  receipt text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  signed_at timestamptz,
  settled_at timestamptz
);
create index payments_agent_created on reflex.payments (agent_id, created_at);

create table reflex.holds (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null references reflex.agents (id) on delete cascade,
  payment_id uuid references reflex.payments (id) on delete cascade,
  kind text not null check (kind in ('payment', 'pause')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'expired', 'failed')),
  telegram_message_id bigint,
  decided_by text,
  decided_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  check ((kind = 'payment') = (payment_id is not null))
);
create index holds_agent_created on reflex.holds (agent_id, created_at);
create unique index holds_payment on reflex.holds (payment_id);
-- one open pause card per agent, so a velocity trip can never send two
create unique index holds_one_open_pause on reflex.holds (agent_id) where kind = 'pause' and status = 'pending';

create function reflex.touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger payments_touch before update on reflex.payments for each row execute function reflex.touch();
create trigger baselines_touch before update on reflex.baselines for each row execute function reflex.touch();

alter table reflex.agents enable row level security;
alter table reflex.baselines enable row level security;
alter table reflex.payments enable row level security;
alter table reflex.holds enable row level security;

revoke all on all tables in schema reflex from public, anon, authenticated;
revoke all on all functions in schema reflex from public, anon, authenticated;
