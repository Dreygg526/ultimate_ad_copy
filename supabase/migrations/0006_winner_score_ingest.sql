-- Store the Winner Score computed at ingest for page-URL pulls.
--
-- WHY: pasting a Meta *page* URL (…?view_all_page_id=<pageId>) scans that
-- advertiser's active ads, scores them against the brand's own cohort, and
-- stores ONLY the winners (user decision, 2026-07-18). Because the losers are
-- never written, ads_scored.brand_percentile can no longer reconstruct the
-- score — its cohort would be just the winners and collapse toward 100. So the
-- within-brand percentile is computed in code at fetch time (against the full
-- scanned cohort) and frozen here. winner_override is also set on those rows so
-- is_winner stays true regardless of the shrunken stored cohort.
--
-- STILL NOT REACH. winner_score is the same longevity percentile the view
-- computes (share of the brand's active ads at or below this run length), NOT
-- impressions. Atria returns no reach data. The UI must keep showing the dates.
-- See CLAUDE.md hard constraint 1 and lib/atria.ts pickBrandWinners().

alter table ads
  add column if not exists winner_score smallint
    check (winner_score is null or winner_score between 0 and 100);

comment on column ads.winner_score is
  'Within-brand Winner Score (0–100) frozen at ingest for page-URL winner '
  'pulls, because only winners are stored so ads_scored.brand_percentile can no '
  'longer recompute it. LONGEVITY percentile, NOT reach. Null for uploads and '
  'for single-ad meta pastes (those still read brand_percentile from the view).';

-- Recreate ads_scored so `select a.* / s.*` re-expands to include winner_score.
-- A view freezes its column list at creation (see 0005 header), so a bare
-- `alter table ads add column` would NOT surface here. This is verbatim the
-- 0005 body — keep brand_percentile windowed (the correlated-subquery form
-- timed out the Library sort; see 0003).
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
