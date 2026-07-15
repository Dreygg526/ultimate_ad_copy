-- Winner Score: per-brand top quartile, replacing the flat 30-day threshold.
--
-- WHY (calibrated 2026-07-15 against all 3,527 ads from the three tracked
-- brands, not a generic sample):
--
--   * Nothing these advertisers run lasts beyond 56 days. The flat threshold was
--     inherited from a "skincare"/most_active sample whose ads ran 733+ days —
--     giant evergreen DCO campaigns, nothing like our competitors.
--   * A global 30d bar treats the brands wildly unevenly:
--       Michelle Bennett   541 active → 29% flagged
--       Steven West        240 active →  3% flagged  (his active ads max out at 32d)
--       Dr. Patricia Moore  71 active → 49% flagged
--     Steven West would effectively vanish from the winners list because his
--     creative cycle is shorter, not because his ads fail.
--   * Per-brand p75 lands at 25–31% for all three.
--
-- The `active` half of the rule is kept and is well supported: inactive ads have
-- a median run of 1 day (these brands kill fast), and only 2 ads in 3,527 ever
-- ran >= 30 days and then stopped. Requiring active costs us ~nothing.
--
-- STILL NOT REACH. run_days is longevity. Atria returns no impressions. The UI
-- must keep showing the dates behind the score and saying so.

-- Fallback bar for brands with too few active ads to take a percentile of.
-- Also the bar for discovery ads that aren't tied to a tracked brand yet.
create or replace function winner_min_run_days() returns integer
  language sql immutable as $$ select 30 $$;

comment on function winner_min_run_days is
  'Fallback only. The primary rule is the per-brand p75 in ads_scored; this '
  'applies when a brand has too few active ads for a percentile to mean anything.';

-- Below this many active ads, a percentile is noise — use the absolute bar.
create or replace function winner_min_sample() returns integer
  language sql immutable as $$ select 8 $$;

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
  -- The bar is set by a brand's own active ads: what does a long run look like
  -- for THIS advertiser?
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
  -- Where this ad sits among its brand's active ads, for display next to the
  -- flag. Null when the brand has no active cohort to rank against.
  case
    when b.active_n is null or b.active_n = 0 then null
    else round(
      100.0 * (
        select count(*) from scored s2
        where s2.atria_brand_id = s.atria_brand_id
          and s2.status = 'active'
          and s2.run_days <= s.run_days
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

comment on view ads_scored is
  'Winner Score = active AND run length in the top quartile FOR THAT BRAND '
  '(falling back to winner_min_run_days() for brands with under '
  'winner_min_sample() active ads). run_days is a LONGEVITY proxy, NOT '
  'impressions — Atria returns no reach data. The UI must show the start/end '
  'dates behind the score and state that it is not reach.';

alter view ads_scored set (security_invoker = on);
