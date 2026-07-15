-- Teardown — initial schema.
--
-- Auth model: invite-only, no self-signup, no public read (CLAUDE.md § Auth).
-- Every table has RLS enabled and NO policy grants anon access. Membership is
-- proven by a row in public.profiles, which only exists via an accepted invite.
--
-- IMPORTANT — RLS is only half of it. You must also disable self-signup in the
-- Supabase dashboard (Authentication → Providers → Email → "Enable sign ups" OFF).
-- Without that, a stranger could create an auth.users row; they'd have no profile
-- and so read nothing, but they should not get an account at all.

-- No pgcrypto needed: gen_random_uuid() is core Postgres since 13, and
-- Supabase runs 15+.

-- ---------------------------------------------------------------------------
-- membership
-- ---------------------------------------------------------------------------

create type user_role as enum ('admin', 'member');

create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null unique,
  full_name   text,
  role        user_role not null default 'member',
  created_at  timestamptz not null default now()
);

comment on table profiles is
  'Membership. A row here IS the proof of invitation — RLS keys off it.';

-- Helpers are security definer so they can read profiles from inside policies
-- on profiles itself without recursing through RLS.
create function is_member() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid());
$$;

create function is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

create table invites (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  invited_by  uuid not null references profiles(id),
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,
  unique (email)
);

comment on table invites is 'Only admin can create. Consumed on first sign-in.';

-- ---------------------------------------------------------------------------
-- brand grounding — the reason this tool exists (CLAUDE.md hard constraint 3)
-- ---------------------------------------------------------------------------

create table brands (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  -- Resolved once via Atria brand search; we never paste Facebook URLs again.
  atria_brand_id  text unique,
  is_tracked      boolean not null default false,
  created_at      timestamptz not null default now()
);

create type doc_kind as enum ('brand', 'audience', 'mechanism');

create table brand_docs (
  id              uuid primary key default gen_random_uuid(),
  brand_id        uuid not null references brands(id) on delete cascade,
  kind            doc_kind not null,
  title           text not null,
  -- Path in the Supabase storage bucket; the file itself is not public.
  storage_path    text not null,
  -- Text extracted at upload and injected into every rebuild prompt.
  extracted_text  text,
  version         integer not null default 1,
  uploaded_by     uuid references profiles(id),
  created_at      timestamptz not null default now()
);

create index on brand_docs (brand_id, kind);

comment on column brand_docs.extracted_text is
  'Injected into rebuild prompts. If null for a required kind, rebuild is blocked.';

-- ---------------------------------------------------------------------------
-- ads
-- ---------------------------------------------------------------------------

create type display_format as enum
  ('image', 'video', 'carousel', 'multi_images', 'multi_videos', 'dco', 'dpa');

create table ads (
  id              uuid primary key default gen_random_uuid(),
  atria_ad_id     text not null unique,
  -- Undocumented but always present: the Facebook-side id, for deep links.
  platform_native_id text,
  brand_id        uuid references brands(id) on delete set null,
  atria_brand_id  text,
  brand_name      text,
  -- Atria's own vocabulary: 'active' | 'inactive'.
  status          text not null,
  -- Undocumented: e.g. {facebook,instagram,audience_network,messenger}.
  platforms       text[] not null default '{}',
  display_format  display_format,
  title           text,
  body            text,
  caption         text,
  cta_text        text,
  link_url        text,
  -- Objects, not URL strings: [{ url, width, height }]. Verified live.
  images          jsonb not null default '[]'::jsonb,
  videos          jsonb not null default '[]'::jsonb,

  -- timestamptz, not date: Atria returns full ISO timestamps despite the docs
  -- saying YYYY-MM-DD, and mixes tz-aware with naive values. The ingest layer
  -- normalises naive values to UTC (lib/atria.ts parseAtriaDate) before insert.
  start_date      timestamptz,
  -- "Last seen running", NOT "the ad ended". For active ads this tracks Atria's
  -- last sync and sits ~hours old; only for inactive ads is it a real end.
  -- Never label this as an end date for a running ad.
  end_date        timestamptz,

  -- Human flag: lets a buyer declare a winner directly, overriding run length.
  winner_override boolean,
  synced_at       timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index on ads (brand_id);
create index on ads (status);
create index on ads (start_date desc);

-- NOTE: there is deliberately no impressions column.
-- Atria returns no impressions data — not as a field, not as a sort. The
-- Winner Score below is a longevity proxy, NOT reach. Do not add a column that
-- implies otherwise. See CLAUDE.md hard constraint 1.

-- The one place the winner threshold is defined. Change it here, not inline.
--
-- NOT YET CALIBRATED. 30 days is a placeholder, and a live sample suggests it is
-- far too low to discriminate: 150 ads pulled with order=most_active had a
-- *minimum* run of 733 days and a median of 822. Under this threshold nearly
-- everything reads as a winner, which makes the flag useless. Needs a media
-- buyer's judgement against the real distribution for our tracked brands.
create function winner_min_run_days() returns integer
  language sql immutable as $$ select 30 $$;

-- Run length is the signal: nobody keeps paying for an ad that doesn't convert.
--
-- A view rather than a stored generated column because now() is not immutable:
-- for an active ad, end_date is only "last seen", so the honest run length runs
-- to the present moment, not to whenever Atria last synced.
create view ads_scored as
select
  a.*,
  greatest(
    0,
    floor(
      extract(epoch from (
        case when a.status = 'active' then greatest(a.end_date, now()) else a.end_date end
        - a.start_date
      )) / 86400
    )::int
  ) as run_days,
  coalesce(
    a.winner_override,
    a.status = 'active'
      and (case when a.status = 'active' then greatest(a.end_date, now()) else a.end_date end
           - a.start_date) >= (winner_min_run_days() || ' days')::interval
  ) as is_winner
from ads a;

comment on view ads_scored is
  'run_days/is_winner are a LONGEVITY proxy, not impressions. The UI must show '
  'the start/end dates behind the score and state that it is not reach.';

-- ---------------------------------------------------------------------------
-- deconstruct / rebuild / review
-- ---------------------------------------------------------------------------

create table deconstructions (
  id          uuid primary key default gen_random_uuid(),
  ad_id       uuid not null references ads(id) on delete cascade,
  summary     text,
  -- The signature element: [{ x, y, heading, body }] as percentage coords so
  -- marks stay put across any render size.
  marks       jsonb not null default '[]'::jsonb,
  model       text,
  created_by  uuid references profiles(id),
  created_at  timestamptz not null default now()
);

create index on deconstructions (ad_id);

create type rebuild_status as enum ('draft', 'waiting', 'changes_asked', 'approved');

create table rebuilds (
  id                uuid primary key default gen_random_uuid(),
  ad_id             uuid not null references ads(id) on delete cascade,
  brand_id          uuid not null references brands(id),
  headline          text,
  copy              text,
  image_path        text,
  status            rebuild_status not null default 'draft',
  -- Which brand_docs grounded this generation. Empty => it was ungrounded, which
  -- must not happen: generation is blocked, not warned about.
  grounding_doc_ids uuid[] not null default '{}',
  created_by        uuid references profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint rebuild_must_be_grounded check (cardinality(grounding_doc_ids) > 0)
);

create index on rebuilds (status);
create index on rebuilds (ad_id);

create table review_events (
  id          uuid primary key default gen_random_uuid(),
  rebuild_id  uuid not null references rebuilds(id) on delete cascade,
  from_status rebuild_status,
  to_status   rebuild_status not null,
  note        text,
  actor       uuid references profiles(id),
  created_at  timestamptz not null default now()
);

create index on review_events (rebuild_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS — invite-only, enforced here rather than in the UI
-- ---------------------------------------------------------------------------

alter table profiles        enable row level security;
alter table invites         enable row level security;
alter table brands          enable row level security;
alter table brand_docs      enable row level security;
alter table ads             enable row level security;
alter table deconstructions enable row level security;
alter table rebuilds        enable row level security;
alter table review_events   enable row level security;

-- profiles: you see the team, you edit only yourself, admin manages roles.
create policy profiles_read   on profiles for select using (is_member());
create policy profiles_self   on profiles for update using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_admin  on profiles for all    using (is_admin()) with check (is_admin());

-- invites: admin only, both directions. This is the gate.
create policy invites_admin on invites for all using (is_admin()) with check (is_admin());

-- Working data: any member reads and writes. Members are trusted colleagues;
-- the boundary that matters is member vs. non-member.
create policy brands_rw     on brands          for all using (is_member()) with check (is_member());
create policy brand_docs_rw on brand_docs      for all using (is_member()) with check (is_member());
create policy ads_rw        on ads             for all using (is_member()) with check (is_member());
create policy decon_rw      on deconstructions for all using (is_member()) with check (is_member());
create policy rebuilds_rw   on rebuilds        for all using (is_member()) with check (is_member());
create policy review_rw     on review_events   for all using (is_member()) with check (is_member());

-- Views don't inherit RLS from base tables by default in older PG; on Supabase
-- (PG15+) declare it explicitly so ads_scored can't be used to bypass ads' RLS.
alter view ads_scored set (security_invoker = on);

-- ---------------------------------------------------------------------------
-- storage — research docs and generated images
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('brand-docs', 'brand-docs', false), ('rebuilds', 'rebuilds', false)
on conflict (id) do nothing;

create policy storage_brand_docs on storage.objects for all
  using (bucket_id = 'brand-docs' and is_member())
  with check (bucket_id = 'brand-docs' and is_member());

create policy storage_rebuilds on storage.objects for all
  using (bucket_id = 'rebuilds' and is_member())
  with check (bucket_id = 'rebuilds' and is_member());
