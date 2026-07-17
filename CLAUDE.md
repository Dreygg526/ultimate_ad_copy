# Teardown

Internal tool for **The Standard Lab**'s media buyers. Find native ads that are
winning, deconstruct why they work, and rebuild them — image, headline, copy —
against our own brand, audience, and mechanism research.

Users are Rob, Nemanja, and the admin (`ai_support@thestandardlab.com`). They are
expert media buyers who live in this tool daily. Write for people who know the
domain; don't explain what a hook is.

## The workflow this implements

From the source doc. Every screen maps to a step — keep it that way.

| Step | Screen | What happens |
|---|---|---|
| Prep: brand context | Brand | Research docs → Supabase bucket → text extracted → injected into every rebuild |
| 1. Find ads | Library | User-curated: upload image/video (≤1GB), paste a Meta Ad Library URL, or a direct file link. (The old Atria tracked-brand auto-sync is retired — see the pivot note in State of the build.) |
| 2. Filter for winners | Library rail | Format, status, date window, Winner Score |
| 3a. Deconstruct | Deconstruct | Gemini reads the image, Claude reads the structure |
| 3b. Replicate | Rebuild | Claude writes headline + copy, Gemini generates image |
| 3c. Review | Review | draft → waiting → changes asked → approved |

## Stack

- **Next.js** (App Router, TypeScript) on **Vercel**
- **Supabase** — Postgres, Auth, Storage buckets (account is Pro). RLS on every table.
- **Atria API** — ad ingest. See the hard constraint below.
- **Claude** — deconstruction, headline, copy, brand voice, review
- **Gemini** — vision (reading ad creative) and image generation

Secrets live in `.env.local`, never in the repo. Required: `ATRIA_API_KEY`,
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, plus Supabase URL / anon / service keys.

## Hard constraints — read before changing ingest or scoring

**1. Atria returns no impressions. There is no impressions filter to build.**

The source doc asks to filter by "impressions by date: all-time / 90 / 30 days,"
and the original Facebook Ad Library URLs sort by `total_impressions`. That data
is not in Atria's API — not as a field, not as a sort. This cannot be coded
around. If a task says "sort by impressions," the answer is that the data does
not exist, not that it needs more work.

What we use instead, agreed with the user: **Winner Score** = run length
(`start_date` → `end_date`) + active status, with a manual override
(`ads.winner_override`) so a human can flag a winner directly. The rationale is
that nobody keeps paying for an ad that doesn't convert, so longevity is the
signal.

**The UI must always show the dates behind the score and say it isn't reach.**
This is not decoration. Someone will otherwise quote that number in a meeting as
measured impressions. Do not remove those notes to tidy up a layout.

*Implemented (see `0002_winner_score_per_brand.sql`) as a **per-brand
percentile**, not a fixed threshold.* An ad is a winner if it is active and its
run length is in the **top quartile of that brand's own live ads** (fallback: 30
days, only when a brand has fewer than 8 live ads to compare against). This was
calibrated against all 3,527 real tracked-brand ads, not chosen by feel:

- Nothing in the real corpus runs beyond **56 days**. An early sample suggesting
  otherwise came from a generic `most_active` query and was not representative —
  don't re-derive thresholds from unscoped searches.
- A global 30-day bar flagged 29% / 3% / 49% of the three brands — wildly uneven,
  because the brands rotate creative at different rates. Per-brand p75 lands at
  25–31% for each, which is what "top quartile" should mean.
- Inactive ads have a **median run of 1 day**, and only 2 of 3,527 ever ran ≥30d
  then stopped. That is what justifies the `active` requirement.

**2. The Facebook Ad Library has no public API for non-political ads.** The
official Ad Library API covers political/issue ads only. Do not scrape it —
it violates Meta's ToS, breaks constantly, and risks the infrastructure. Atria
is what makes this workflow automatable at all.

**3. Nothing generates without brand grounding.** Brand + audience + mechanism
research goes into every rebuild prompt. That grounding is the entire reason
this tool exists instead of us using Atria's own "Raya" agent, which already
does competitor analysis, briefs, and image generation but knows nothing about
our mechanism doc. A rebuild that isn't grounded is off-strategy by
construction — block it, don't warn about it.

## Atria API

Base `https://api.tryatria.com`, endpoints under `/open/v1/`.
Auth header `X-API-Key: atria-sk_...`. Docs at `docs.tryatria.com` —
start at `docs.tryatria.com/llms.txt`, which is the agent-facing index with
OpenAPI. The human-facing doc pages are mostly navigation.

Envelope `{code, message, data}` with `code: 0` for success. Gateway errors
(401/429/5xx) bypass the envelope and return flat `{error, message, request_id}`
— check HTTP status before reading `code`.

`GET /open/v1/ad-library/search`
- Filters: `query`, `platform`, `display_format` (image | video | carousel |
  multi_images | multi_videos | dco | dpa), `language`, `start_date`, `end_date`
  (YYYY-MM-DD), `status` (active | inactive), `industry`, `video_length`
- `order`: newest | oldest | most_active | best_match
- `page_size` 1–50 (default 20), `cursor` for pagination; a null `cursor` in the
  response means no more results
- Ad fields: `id`, `brand_id`, `brand_name`, `status`, `display_format`, `title`,
  `body`, `caption`, `cta_text`, `link_url`, `images[]`, `videos[]`,
  `start_date`, `end_date`

### What the live API actually does — verified, and it differs from the docs

Checked against real responses on 2026-07-15. Each of these was an assumption
that turned out wrong, so trust this over the doc page:

- The results array is `data.items`, **not** `data.ads`.
- `images[]` / `videos[]` are objects `{url, width, height}`, **not** URL strings.
- `start_date` / `end_date` are **full ISO timestamps, not `YYYY-MM-DD`** — and
  the timezone designator is *inconsistent* (some `+00:00`, some naive). A naive
  value passed to `new Date()` parses as **local time** and silently shifts run
  length. Always go through `parseAtriaDate()` in `lib/atria.ts`.
- `end_date` means **"last seen running," not "the ad ended."** Every active ad
  carries one, ~0.3 days old. An active ad's run therefore extends to `now()` —
  that is why `ads_scored` computes it that way. Do not "fix" this.
- **`brand_id` for Meta brands is `"m" + facebook_page_id`.** The source-doc page
  URLs map straight to Atria with no name search needed — see
  `brandIdFromFacebookPageId()`. Brand search remains the fallback.

Also available: boards, brand library search, list library brand ads, ad
accounts, image generation, video transcription. The three tracked Facebook
pages from the source doc are resolved to Atria `brand_id`s and stored — we
never paste those URLs again.

Keys are made in-app at Settings & members → API Keys. Max two active per
workspace; the full key shows once.

## Auth

Invite-only. `ai_support@thestandardlab.com` is admin and the only role that can
invite. Invite by email; no self-signup; no public read. Anyone without an
invite gets nothing even with the URL. Enforce in RLS, not just in the UI.

Managed from the **Settings** screen (`/settings`):

- **Invite by email** (admin only) → `inviteUserByEmail` + a `profiles` row (RLS
  keys off profiles, so the row is what actually grants access). Resend / remove
  are there too; an admin can't remove themselves or another admin.
- **Password**: everyone can set their own from Settings (`updateUser`, no email
  round-trip). Forgot-password on `/signin` sends a reset link.
- **Sign out** lives in the top bar (`TopBar` → `signOut` action).
- Every emailed link (invite, reset) returns through `/auth/confirm`, which
  exchanges the token and forwards to `/auth/set-password`. `proxy.ts` lets
  `/auth/*` through unauthenticated because that callback is what establishes the
  session — do not move it behind the auth redirect.
- Admin-only actions use the **service-role client**, which bypasses RLS, so they
  MUST re-check the caller is admin against their own session first
  (`settings/actions.ts → callingAdmin`). This is the one place the RLS-does-it
  rule doesn't hold, by necessity.
- **Depends on Supabase project config** (not in the repo): custom SMTP (built-in
  email is rate-limited/testing-only), the origin in Auth → Redirect URLs,
  `NEXT_PUBLIC_SITE_URL` in prod so links point at the deployed origin, and — the
  one that silently breaks invites — the **email templates must use the
  `token_hash` link this app's `/auth/confirm` expects**, NOT the default
  `{{ .ConfirmationURL }}`. Default templates hand back a PKCE `code` (or an
  implicit-flow fragment) that a server-initiated invite has no `code_verifier`
  for, so the exchange fails and the invitee lands on `/signin?error=link`. Set
  each template to, e.g.:
  `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite&next=/auth/set-password`
  (`type=recovery` for the reset template). The in-app password change works
  without any of these; the emails don't.

## Design — "the proofing desk"

The tool descends from the swipe file: art directors clipping winning ads and
marking them up with a grease pencil. Everything derives from that.

```
--proof:  #DCDED7   pale gray-green proofing stock (page ground)
--surface:#F2F3EF   raised card
--ink:    #14171A   text
--ink-soft:#5A6169  secondary text
--rule:   #B9BDB5   hairlines
--pencil: #D62E1F   grease pencil — ANNOTATION ONLY, never chrome
--stamp:  #2C4C8C   status blue
--go:     #2F6B45   approved green
```

Type: **Archivo** (display, 600–800, tight) · **IBM Plex Sans** (body) ·
**IBM Plex Mono** (scores, dates, IDs, anything tabular). Inline as `@font-face`
data URIs where a CDN isn't available.

**Signature element:** numbered grease-pencil marks drawn directly on the ad
image, wired bidirectionally to the deconstruction list — hover a note, its mark
lights up on the creative. This is the one memorable thing; keep everything
around it quiet.

**Single-theme light, deliberately.** A dark surround changes how you read
creative — the same crop looks warmer and more contrasty on black, and you'd be
grading against the chrome. Proofing has been done on neutral stock for a
century for that reason. Do not add a dark mode.

Spend boldness in one place. The pencil red touches annotation and nothing else.

Mockup (approved direction): https://claude.ai/code/artifact/b259e888-3b9a-44e3-9971-c0a1314b3bdf

## Conventions

- Server Components by default; client components only where interaction needs them.
- Atria calls go through one typed client module. Never fetch Atria from a
  component. Rate-limit and cache — the ad library doesn't change by the second.
- AI calls run server-side only. Model keys never reach the browser.
- Before writing Claude API code, consult the `claude-api` skill for current
  model IDs, params, and pricing. Don't write them from memory. (It matters:
  on `claude-opus-4-8`, `temperature` and `budget_tokens` are now **400 errors**,
  and adaptive thinking must be set explicitly — omitting it means no thinking.)
- **Model IDs are pinned, never aliased.** `claude-opus-4-8` and
  `gemini-3.1-pro-preview`. An alias like `gemini-pro-latest` would change what
  the deconstruction says with nothing in the repo changing — unreproducible
  marks. The cost is that Gemini previews retire: `gemini-3-pro-preview` already
  has, **and `models.list` still advertises it**, so a 404 on a listed model is
  expected rather than mysterious. Repoint `VISION_MODEL` in `lib/vision.ts`.
- Ad creative in mockups/tests is CSS-composed, never a real fetched image —
  no rights issues, no external requests. This does **not** apply to the product
  itself, which renders real creative from Atria's CDN — that is correct.
- Demo brand names (Vireo, Northbound, Halden, Rootwell) are invented
  placeholders. Don't present them as real competitors or clients.

## State of the build

Last updated 2026-07-17.

### Resolved — do not re-litigate

- **Atria API access is NOT plan-gated.** This was the single biggest risk to the
  product ("if API access is gated above our tier, this is a meaningfully smaller
  product"). Verified against the live API: HTTP 200, `code: 0`. Automated ingest
  is viable. This stays the full product.
- **The API key is supplied** and lives in `.env.local`.
- **Atria genuinely returns no impressions / reach / spend.** Confirmed across a
  150-ad sample, not assumed from the docs. Hard constraint 1 stands.

### Working, verified against real data

| Piece | State |
|---|---|
| Ingest | **Retired as the Library backbone** (see pivot note below). `lib/ingest.ts` and `/api/sync` are removed; the ~3,600 legacy Atria rows stay in `ads` (source `atria`) but are filtered out of the Library. Atria is now on-demand only, via `getLibraryAd` (`lib/atria.ts`) for the Meta-URL path. |
| Winner Score | `ads_scored` view (unchanged rule). Now applies only to **Meta-sourced** items, which carry Atria run dates; uploads have no dates → no score. Still shows the dates and "not reach" per hard constraint 1. |
| RLS | Verified **from both sides**: a stranger gets nothing (42501 on writes, `[]` on reads, `signup_disabled` on signup); a member sees everything. Both halves matter — a policy blocking everyone would pass the stranger test alone. The `library` storage bucket uses the same `is_member()` policy as `brand-docs`/`rebuilds`. |
| Library | **Rebuilt around uploads** (`0005_library_uploads.sql`). Upload image/video ≤1GB (browser→Storage resumable via `tus-js-client`), paste a Meta Ad Library URL (resolved through Atria) or a direct file link (stored as a reference). Source/kind filters, title/ID search, per-card delete. Items flow into Deconstruct→Rebuild unchanged (they're `ads` rows). `npm run verify:library`. |
| Deconstruct (3a) | End-to-end on a real ad: Gemini located 8 elements, Claude marked 5, ~30s. `npm run verify:deconstruct [adId]`. |
| Rebuild (3b) | Proven end-to-end on real NAC600 docs (see Known open). Editorial 3-column screen: source + deconstruction, our generated creative, editable headline/alternates/copy/CTA. Grounding gated three ways (action, `lib/rebuild.ts`, DB check). Pinned models: `claude-opus-4-8`, image `gemini-2.5-flash-image` — **NOT** the `gemini-3-pro-image`/`imagen-4.0-*` CLAUDE.md once named; those 503/404'd on 2026-07-16. `npm run verify:rebuild`. |
| Brand | Doc upload → `brand-docs` bucket → text extracted (PDF via Gemini, DOCX via `mammoth`, txt/md direct) → `brand_docs` rows, versioned per kind. Unreadable files are rejected, not stored. |
| Review (3c) | Table queue with Waiting/Mine/All filter (**defaults to All** on landing; `?show=waiting\|mine` override); per-rebuild state machine draft→waiting→{approved,changes_asked}→waiting, writing `review_events`. Concurrency-guarded transitions. The rebuild detail (`/rebuild/[adId]`, where the queue links) shows the source ad's "As it ran" headline/body/CTA so a reviewer sees what was borrowed. |
| Settings / auth | Invite by email, resend, remove, self-service password, sign out. See § Auth. Email delivery depends on Supabase SMTP config (unverified end-to-end); the in-app pieces are wired and typecheck/route-compile clean. |

### Pivot — the Library is now upload-driven (2026-07-17)

The Library stopped being the Atria tracked-brand feed and became a **curated
swipe file the buyer stocks** (user decision, after hitting the feed's limits:
Atria staleness, Meta's unverifiable per-clone impressions, no curation). The
`ads` table is reused as the universal item store — an upload, a Meta paste, and
a legacy Atria row are all `ads` rows — so Deconstruct→Rebuild, which key off
`ads_scored.atria_ad_id` / `ads.id`, kept working. New rows carry a synthetic
`atria_ad_id` (`up_<uuid>` for uploads, `m<library_id>` for Meta pastes).

Non-obvious things worth keeping:
- **1GB uploads go browser→Storage resumably** (`tus-js-client`, `lib/supabase/client.ts`,
  `AddToLibrary.tsx`) — a server action's ~4.5MB body limit can't carry them. Depends
  on the Supabase **Storage file-size limit being raised to ≥1GB** in the dashboard
  (an external config dep, like SMTP).
- **The single-ad Atria endpoint is `/open/v1/ad-library/{id}`**, NOT the docs'
  `/open/v1/library-ads/{id}` (that returns code 40401). Verified live.
- **A view's `select a.*` freezes its column list at creation** — `0005` had to
  drop+recreate `ads_scored` (verbatim the `0003` body) for the new columns to
  surface, not merely `alter table ads`.
- **A Meta row's `source_url` is the Facebook page URL, never the creative.** Art
  comes from `videos[]`/`images[]` (Atria CDN); `source_url` is art only for a
  direct-link upload reference. Getting this order wrong shows broken previews.
- Video is stored/playable but **deconstruction is image-only** (Gemini vision
  needs a still); the button is hidden for video with a note.

**The Gemini/Claude split is load-bearing, not stylistic.** Gemini reports only
*what is on the creative and where*; Claude gets that list plus the ad copy and
says *why it works*. Claude never sees the image, so it cannot invent a
coordinate — it references an element by index and `lib/deconstruct.ts` merges
the position back in. Collapsing this into one vision call would let the model
hallucinate marks onto empty pixels. Keep the split.

## Next

The three build steps (Rebuild 3b, Brand, Review 3c) and the Settings/auth
screen have landed — see the build-state table. Remaining, roughly in order:

1. **Migrations `0003`–`0005` are applied to the live DB via the dashboard, but
   confirm before relying on new columns.** `0005` adds `ads.{source,kind,
   storage_path,source_url,file_bytes,mime,created_by}`, recreates `ads_scored`,
   and creates the `library` bucket + policy. There is no linked project /
   `DATABASE_URL`, so migrations are pasted into the SQL editor by hand.
2. **Video deconstruction** — currently image-only. Options: a poster-frame
   extract, or Atria's transcript endpoint
   (`/open/v1/ad-accounts/{acct}/ads/{id}/transcript`) to feed Claude the spoken hook.
3. **Bulk Meta page-URL ingest** — `addByUrl` handles single-ad `?id=` URLs;
   `?view_all_page_id=` (a whole advertiser) is not wired.
4. **Optional Atria discovery search** — `searchAds()` is still in `lib/atria.ts`
   and unused. If automated discovery is ever wanted back, wire it as an in-app
   "pull into Library" action rather than a tracked-brand auto-sync.
5. **Legacy Atria rows** (~3,600, source `atria`) are hidden, not purged. Purge or
   add a toggle if they're in the way — the user's call.

### Known open

- Grounding-produces-on-brand-copy is now **proven** on real TheStandardLab
  NAC600 docs: the rebuild borrowed the source liver ad's confessional structure
  but swapped in our glutathione/NAC/NAD+ mechanism and avoided the source's
  cirrhosis/death claim. This was the last unproven product assumption.
- Review staleness display is **done**: the queue table and the rebuild detail's
  "Grounded in" flag a doc only when a newer version of that brand+kind exists,
  and stay quiet when current. (Replaces the old unreadable `v4 · v2 · v3` stamps.)
- Mark placement accuracy is Gemini's, and is unmeasured. Spot-checks landed on
  target; if a mark drifts, that is the vision prompt in `lib/vision.ts`, not the
  rendering.
- The mockup hovers the back link to `--pencil`. That contradicts "pencil is
  ANNOTATION ONLY, never chrome", so the build darkens to `--ink` instead. Noted
  in `globals.css` — flip it if the mockup wins. The same rule is why the new
  sign-out button and doc-clamp "see more" are chrome-neutral, never pencil.
