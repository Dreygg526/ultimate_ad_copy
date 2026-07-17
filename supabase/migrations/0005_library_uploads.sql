-- Library becomes a user-curated swipe file, not the Atria tracked-brand feed.
--
-- The `ads` table is reused as the universal library-item store: Deconstruct and
-- Rebuild already key off it (ads_scored.atria_ad_id for lookup, ads.id as the FK
-- for deconstructions/rebuilds), so an uploaded image, a pasted Meta ad, and a
-- legacy Atria ad are all just rows here and the whole downstream workflow keeps
-- working. New rows carry a synthetic atria_ad_id ('up_<uuid>' for uploads,
-- 'm'+library_id for Meta pastes).
--
-- ads_scored MUST be recreated (below): a view's `select a.*` is expanded to an
-- explicit column list at creation time, so columns added to `ads` afterwards do
-- NOT appear in the view until it is dropped and rebuilt. Deconstruct, Rebuild
-- and the Library all read source/kind/storage_path off ads_scored, so without
-- the rebuild they'd get "column ads_scored.source does not exist". Upload/meta
-- rows have null dates -> is_winner false; Winner Score stays a longevity proxy
-- for Atria-era rows only.

-- Atria-origin ads always had a status; uploads don't.
alter table ads alter column status drop not null;

alter table ads
  -- Where the row came from. 'atria' keeps the historical default so the 3,527
  -- legacy rows need no backfill.
  add column if not exists source text not null default 'atria'
    check (source in ('atria', 'upload', 'meta')),
  -- For non-Atria rows: what the buyer added.
  add column if not exists kind text
    check (kind is null or kind in ('image', 'video', 'url')),
  -- Path in the private 'library' bucket for a browser-uploaded file.
  add column if not exists storage_path text,
  -- Original URL: the Meta ad-library URL, or a direct-link reference we don't
  -- re-host.
  add column if not exists source_url text,
  add column if not exists file_bytes bigint,
  add column if not exists mime text,
  add column if not exists created_by uuid references profiles(id);

create index if not exists ads_source_idx on ads (source);

comment on column ads.source is
  'atria = legacy tracked-brand sync; upload = browser-uploaded file or a direct-'
  'link reference; meta = resolved on demand from a Meta Ad Library URL via Atria.';
comment on column ads.storage_path is
  'Object path in the private ''library'' bucket. Null for meta/atria (those use '
  'images[].url from Atria''s CDN) and for direct-link references (those use '
  'source_url).';

-- Rebuild ads_scored so a.*/s.* re-expand to include the new columns. This is
-- verbatim the 0003 definition (windowed brand_percentile — keep it windowed,
-- the correlated-subquery form timed out the Library sort). Only reason it is
-- repeated here is the star-expansion rule above.
drop view if exists ads_scored;

create view ads_scored as
with scored as (
  select
    a.*,
    greatest(
      0,
      floor(
        extract(epoch from (
          -- An active ad's end_date is only "last seen", so run it to now.
          case when a.status = 'active' then greatest(a.end_date, now()) else a.end_date end
          - a.start_date
        )) / 86400
      )::int
    ) as run_days
  from ads a
),
brand_bar as (
  select
    atria_brand_id,
    count(*)::int as active_n,
    percentile_cont(0.75) within group (order by run_days) as p75_run_days
  from scored
  where status = 'active' and run_days is not null and atria_brand_id is not null
  group by atria_brand_id
)
select
  s.*,
  b.active_n as brand_active_n,
  b.p75_run_days as brand_p75_run_days,
  case
    when b.active_n is null or b.active_n = 0 then null
    else round(
      100.0 * count(*) filter (where s.status = 'active') over (
        partition by s.atria_brand_id
        order by s.run_days
        range between unbounded preceding and current row
      ) / b.active_n
    )::int
  end as brand_percentile,
  coalesce(
    s.winner_override,
    s.status = 'active'
      and s.run_days >= case
        when b.active_n >= winner_min_sample() then ceil(b.p75_run_days)::int
        else winner_min_run_days()
      end
  ) as is_winner
from scored s
left join brand_bar b on b.atria_brand_id = s.atria_brand_id;

alter view ads_scored set (security_invoker = on);

-- Private bucket for uploaded creative, same team-wide RLS as brand-docs/rebuilds
-- (see 0001_init.sql). is_member() = a profiles row = an accepted invite.
insert into storage.buckets (id, name, public)
values ('library', 'library', false)
on conflict (id) do nothing;

-- Idempotent so a partial re-run of this migration doesn't error on the policy.
drop policy if exists storage_library on storage.objects;
create policy storage_library on storage.objects for all
  using (bucket_id = 'library' and is_member())
  with check (bucket_id = 'library' and is_member());
