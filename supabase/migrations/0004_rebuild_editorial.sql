-- Rebuild becomes editable, matching the approved mockup: alternate headlines,
-- a CTA, and Claude's rationale get their own fields, and a buyer can edit the
-- copy in place before sending it to review.
--
-- WHY (2026-07-16): the review loop had nowhere for "ask for changes" to land —
-- the copy was read-only, so acting on a note meant regenerating the whole ad.
-- These columns hold what the editorial layout shows and lets a buyer save.
--
-- No new grounding surface here, so hard constraint 3 is untouched: generation
-- still fails without docs via rebuild_must_be_grounded. These are all nullable
-- or defaulted, so existing rebuild rows stay valid.

alter table rebuilds
  add column if not exists alternates    text[] not null default '{}',
  add column if not exists cta           text,
  -- "Notes from Claude": which structural move was borrowed and what was
  -- swapped. Was generated already (as `borrowed`) but never persisted.
  add column if not exists notes         text,
  -- Kept so the image can be regenerated or a buyer can shoot from the same
  -- brief without re-running Claude.
  add column if not exists art_direction text;

comment on column rebuilds.alternates is
  'Alternate headlines Claude offered; a buyer can promote one into headline.';
comment on column rebuilds.notes is
  'Claude''s rationale — the borrowed structural move and what substance replaced it.';
