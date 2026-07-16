import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod';

/**
 * Step 3b: Claude writes headline + copy, Gemini generates the image.
 *
 * The whole point of this screen is grounding. Atria's own Raya agent already
 * does competitor analysis and image generation — what it cannot do is know our
 * brand, our audience, and our mechanism. A rebuild that isn't grounded is
 * off-strategy by construction, so this module refuses to run without docs
 * rather than warning about it (CLAUDE.md hard constraint 3). The DB enforces
 * the same rule via rebuild_must_be_grounded; this is the earlier of the two
 * gates, and it exists so a buyer gets a sentence instead of a constraint
 * violation.
 */

const MODEL = 'claude-opus-4-8';

// Image generation, not vision — a different model from lib/vision.ts. Pinned
// for the same reason: an alias would change the output with nothing in the
// repo changing.
//
// NOT gemini-3-pro-image, which is what CLAUDE.md names. Checked against the
// live API on 2026-07-16: gemini-3-pro-image returns 503 "experiencing high
// demand" on every call (5 for 5), and the imagen-4.0-* models CLAUDE.md also
// lists now 404 — they retired. This one is verified working: ~20s for a
// ~1.6MB PNG. The 503 reads as transient, so repoint here when it clears; a
// silent runtime fallback is deliberately not used, because it would mean two
// different models producing rebuilds with nothing in the repo saying which.
const IMAGE_MODEL = 'gemini-2.5-flash-image';

const RebuildSchema = z.object({
  headline: z
    .string()
    .describe(
      "The headline as it would run. One line. It must carry OUR mechanism, not the source ad's.",
    ),
  alternates: z
    .array(z.string())
    .min(2)
    .max(3)
    .describe(
      'Two or three alternate headlines, each a genuinely different angle on the same ad — not rewordings of the first. A buyer will pick one.',
    ),
  copy: z
    .string()
    .describe(
      'The body copy as it would run. Match the source ad\'s structural moves — its lead, its rhythm, its turn — but the claims, mechanism, and proof are ours and come only from the research below.',
    ),
  cta: z
    .string()
    .describe(
      'The call to action as it would run on the button or final line. A few words. Ours, not the source ad\'s.',
    ),
  art_direction: z
    .string()
    .describe(
      'A prompt for an image generator describing the creative to shoot. Describe the scene, subject, framing, and mood only — no text, no logos, no lettering of any kind.',
    ),
  notes: z
    .string()
    .describe(
      'One or two sentences naming the structural move taken from the source ad and what substance replaced it, so a buyer can see what was replicated and what was ours.',
    ),
});

export type RebuildDraft = z.infer<typeof RebuildSchema>;

export interface GroundingDoc {
  id: string;
  kind: 'brand' | 'audience' | 'mechanism';
  title: string;
  extracted_text: string | null;
}

export interface SourceAd {
  brand_name: string | null;
  title: string | null;
  body: string | null;
  cta_text: string | null;
  run_days: number | null;
  status: string | null;
}

export interface RebuildInput {
  ad: SourceAd;
  /** The deconstruction, if it has been run — what the ad is doing and why. */
  summary: string | null;
  marks: { heading: string; body: string }[];
  brandName: string;
  docs: GroundingDoc[];
}

export interface RebuildResult extends RebuildDraft {
  model: string;
  /** Exactly the docs that grounded this. Written to rebuilds.grounding_doc_ids. */
  groundingDocIds: string[];
}

const SYSTEM = `You rebuild winning native ads for The Standard Lab's media buyers.

You are given a competitor's ad that is working, and our own brand, audience, and
mechanism research. Your job is to take what makes the source ad work and rebuild
it as OUR ad.

Borrow structure, never substance. The lead type, the rhythm, the placement of the
turn, the register — those are fair game, and they are why we picked this ad. The
claims, the mechanism, the proof, the audience's stakes: those come only from the
research below. Never carry over a claim, a product, an ingredient, a statistic, or
a mechanism from the source ad.

Every factual claim you make must trace to the research. If the research does not
support a claim, do not make it — write around it. Do not invent studies, numbers,
credentials, timelines, or customer stories. An off-strategy rebuild is worse than
no rebuild, because it looks finished.

Your readers are expert buyers. Write the ad, not a description of the ad. No
preamble, no hedging, no explaining your choices except where asked.`;

function buildPrompt(input: RebuildInput): string {
  const { ad, summary, marks, brandName, docs } = input;
  const byKind = (k: GroundingDoc['kind']) => docs.filter((d) => d.kind === k);

  const section = (label: string, kind: GroundingDoc['kind']) => {
    const found = byKind(kind);
    if (!found.length) return [`${label}: (no document uploaded)`];
    return found.flatMap((d) => [`${label} — ${d.title}`, d.extracted_text ?? '', '']);
  };

  return [
    'THE SOURCE AD — a competitor ad that is winning. Structure only.',
    `Brand: ${ad.brand_name ?? 'unknown'}`,
    `Headline: ${ad.title ?? '(none)'}`,
    `Body: ${ad.body ?? '(none)'}`,
    `CTA: ${ad.cta_text ?? '(none)'}`,
    // Be explicit about what the signal is, so the model never dresses longevity
    // up as reach. There is no impressions data — see CLAUDE.md constraint 1.
    `It has run ${ad.run_days ?? 'an unknown number of'} days and is ${
      ad.status === 'active' ? 'still live' : 'stopped'
    }. Run length is the only performance signal we have — there is no impressions`,
    'or spend data. Do not treat it as reach.',
    '',
    summary ? `WHY IT WORKS (from our deconstruction)\n${summary}` : 'It has not been deconstructed yet.',
    ...(marks.length
      ? ['', 'THE MOVES WE MARKED:', ...marks.map((m) => `  - ${m.heading}: ${m.body}`)]
      : []),
    '',
    '='.repeat(60),
    `NOW REBUILD IT FOR: ${brandName}`,
    'Everything below is our own research. It is the only source of truth for any',
    'claim you make.',
    '='.repeat(60),
    '',
    ...section('BRAND', 'brand'),
    ...section('AUDIENCE', 'audience'),
    ...section('MECHANISM', 'mechanism'),
    '',
    `Write the rebuild for ${brandName}. Borrow the source ad's structure; take`,
    'every claim from the research above.',
  ].join('\n');
}

/**
 * The grounding gate. Throws rather than warns — see hard constraint 3.
 * Returns the docs that actually carry text, since a doc row whose extraction
 * is null grounds nothing.
 */
function usableDocs(docs: GroundingDoc[]): GroundingDoc[] {
  return docs.filter((d) => (d.extracted_text ?? '').trim().length > 0);
}

export async function generateRebuild(input: RebuildInput): Promise<RebuildResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const docs = usableDocs(input.docs);
  if (docs.length === 0) {
    throw new Error(
      `${input.brandName} has no research with readable text. Upload brand, audience, or mechanism docs first — nothing generates without grounding.`,
    );
  }

  const client = new Anthropic({ apiKey });
  const message = await client.messages.parse({
    model: MODEL,
    // A rebuild writes a full-length ad (the source liver ad runs ~2,000 words),
    // and adaptive thinking is billed against this same ceiling. At 8,000 the
    // real NAC grounding (~66k chars across three docs) made Claude think enough
    // that the JSON copy field truncated mid-string. 16,000 is the documented
    // non-streaming ceiling (higher needs streaming to dodge HTTP timeouts);
    // messages.parse is non-streaming, so stay at or below it.
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: SYSTEM,
    messages: [{ role: 'user', content: buildPrompt({ ...input, docs }) }],
    output_config: {
      effort: 'high',
      format: zodOutputFormat(RebuildSchema),
    },
  });

  const parsed = message.parsed_output;
  if (!parsed) throw new Error('Claude returned no structured output');

  return {
    ...parsed,
    model: MODEL,
    groundingDocIds: docs.map((d) => d.id),
  };
}

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
  model: string;
}

/**
 * Gemini shoots the creative from Claude's art direction.
 *
 * No text in the image on purpose: the headline and copy are Claude's, they get
 * reviewed as text, and generated lettering is unreliable — a buyer would have
 * to retouch it out anyway.
 */
export async function generateImage(artDirection: string): Promise<GeneratedImage> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model: IMAGE_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `${artDirection}

Photographic, native-feeling, as if shot for a social feed rather than a catalogue.
Absolutely no text, letters, words, numbers, logos, watermarks, or captions anywhere
in the frame.`,
          },
        ],
      },
    ],
  });

  const parts = res.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const inline = part.inlineData;
    if (inline?.data) {
      return {
        bytes: Buffer.from(inline.data, 'base64'),
        mimeType: inline.mimeType ?? 'image/png',
        model: IMAGE_MODEL,
      };
    }
  }

  throw new Error('Gemini returned no image.');
}
