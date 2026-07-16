-- Winner Score: same numbers, computed with a window function instead of a
-- correlated subquery. No change to the rule — see 0002 for the calibration and
-- for why this is longevity, NOT reach. Atria returns no impressions.
--
-- WHY (2026-07-16): the Library's default sort (`score` → brand_percentile) hit
-- `57014 canceling statement due to statement timeout` and the grid rendered
-- nothing at all.
--
-- 0002 computed brand_percentile with a subquery correlated on the outer row:
--
--     (select count(*) from scored s2
--       where s2.atria_brand_id = s.atria_brand_id
--         and s2.status = 'active'
--         and s2.run_days <= s.run_days)
--
-- which re-scans the whole `scored` CTE once per row: 3,527 x 3,527 ~ 12M row
-- comparisons, against a CTE with no index to help it.
--
-- It survived until now because nothing forced it to run on every row. Selecting
-- brand_percentile with `limit 60` pushes the limit down and computes it 60
-- times (~280ms, fine). ORDER BY brand_percentile has to compute all 3,527
-- before it can sort, and that is over the 8s statement timeout. The rail counts
-- kept working throughout because count(id) lets the planner prune the unused
-- column and never evaluate it — which is why the page showed correct totals
-- above an empty, errored grid.
--
-- The rewrite counts the same rows with a window frame instead. ORDER BY
-- run_days with `range between unbounded preceding and current row` frames every
-- active row at or below this row's run_days -- RANGE (not ROWS) is load-bearing:
-- it includes peers, matching the subquery's `<=`. FILTER restricts the count to
-- active rows while the partition still carries the inactive ones, so an ended ad
-- is still ranked against its brand's live cohort, exactly as before.
--
-- Verified equivalent on all 3,527 real ads (PGlite, both views over the same
-- rows with now() frozen): 0 mismatches on brand_percentile, is_winner, and
-- run_days; 248 winners either way, matching production. ~97x faster on the
-- ordered query (1071ms -> 11ms).

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

comment on view ads_scored is
  'Winner Score = active AND run length in the top quartile FOR THAT BRAND '
  '(falling back to winner_min_run_days() for brands with under '
  'winner_min_sample() active ads). run_days is a LONGEVITY proxy, NOT '
  'impressions — Atria returns no reach data. The UI must show the start/end '
  'dates behind the score and state that it is not reach. brand_percentile uses '
  'a windowed count, not a correlated subquery: the subquery form was O(n^2) and '
  'timed out the Library''s default sort. Keep it windowed.';

alter view ads_scored set (security_invoker = on);
