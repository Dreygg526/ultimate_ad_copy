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
      "The headline as it would run. One line. Mirror the source headline's shape, length and rhythm as closely as you can — it must carry OUR mechanism, not the source ad's.",
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
      "The body copy as it would run. Mirror the source ad paragraph by paragraph, at roughly the same total length and the same sentence rhythm: same lead, same order of beats, same placement of the turn, same closer. Only the substance changes — product, mechanism, claims and proof are ours and come only from the research below.",
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
  // The buyer's proof that the rebuild actually mirrors the source rather than
  // being a fresh ad. Without this you have to read both in full to tell.
  mirror: z
    .array(z.string())
    .min(3)
    .max(8)
    .describe(
      'Paragraph-by-paragraph map, in order, one line each, formatted "theirs → ours": a short quote or description of the source beat, then what you wrote in its place. This is how a buyer checks the replication at a glance.',
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
mechanism research. Your job is to REPLICATE that ad as closely as you can with our
substance swapped in. Not a new ad in the same spirit — the same ad, rebuilt.

Replicate the form, replace the substance. Work through the source ad beat by beat
and write our version of each beat in the same position. Same lead. Same number of
paragraphs, in the same order. Roughly the same length overall and the same sentence
rhythm — if theirs opens with a four-word fragment, ours opens with a four-word
fragment. Same placement of the turn. Same register, same person, same tense, same
closer. If the source repeats a phrase, repeat ours. If it uses a list, use a list of
the same length. A buyer should be able to lay the two side by side and see the
source's skeleton under our words.

What must NOT carry over is substance: the claims, the mechanism, the proof, the
product, the ingredients, the statistics, the customer stories. Those come only from
the research below. Copying a competitor's claim onto our product is a compliance
problem, not a style choice — so mirror the sentence that carried their claim, and
put a claim of ours that the research actually supports in its place. If the research
supports nothing that fits that slot, write the closest true thing at the same length
rather than inventing or dropping the beat.

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
    'THE SOURCE AD — a competitor ad that is winning. Replicate its form exactly;',
    'replace its substance with ours.',
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
    `Write the rebuild for ${brandName}. Go through the source ad above beat by beat`,
    'and write our version of each beat in the same position, at the same length, in',
    'the same rhythm. Every claim comes from the research above. Then fill in the',
    'mirror field so a buyer can check the replication line by line.',
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

/** The structured output arrives as a text block; thinking blocks sit alongside it. */
function textOf(content: { type: string }[]): string | null {
  const block = content.find((b): b is { type: 'text'; text: string } => b.type === 'text');
  return block?.text ?? null;
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
  const params = {
    model: MODEL,
    // STREAMING, not messages.parse. A rebuild replicates a full-length ad (the
    // source liver ad runs ~2,000 words) and adaptive thinking is billed against
    // the same ceiling. messages.parse is non-streaming, so it was capped at
    // 16,000 — and a long source blew through that mid-JSON, surfacing as
    // "Unterminated string in JSON at position 3628" rather than as a token
    // limit. Streaming lifts the ceiling and dodges the HTTP timeout that made
    // 16,000 the cap in the first place.
    max_tokens: 32000,
    thinking: { type: 'adaptive' as const },
    system: SYSTEM,
    messages: [{ role: 'user' as const, content: buildPrompt({ ...input, docs }) }],
    output_config: {
      // 'low', deliberately. The user's call, made explicitly: a concept in the
      // buyer's hands beats a better concept they won't wait for. Most of the
      // wall-clock here is generating a 2,000-word replication, and low effort
      // cuts the thinking that runs before a single word of it appears.
      effort: 'low' as const,
      format: zodOutputFormat(RebuildSchema),
    },
  };

  // Fast mode runs the SAME model at up to 2.5x output tokens/sec — the ideal
  // lever here, since the bottleneck is emitting a long ad and it buys speed
  // without trading away the copy. It is OFF by default because this workspace
  // has no fast-mode capacity: checked live 2026-07-22, every request 429s with
  // "rate limit of 0 fast mode input tokens per minute". Leaving it on cost a
  // wasted round-trip before every generation. Set CLAUDE_FAST_MODE=1 if that
  // capacity is ever bought — the fallback below keeps it safe either way.
  let text: string | null = null;
  if (process.env.CLAUDE_FAST_MODE === '1') {
    try {
      const fast = await client.beta.messages
        .stream({ ...params, speed: 'fast', betas: ['fast-mode-2026-02-01'] })
        .finalMessage();
      text = textOf(fast.content);
    } catch (e) {
      console.warn('[rebuild] fast mode unavailable, using standard speed:', e);
    }
  }

  if (text === null) {
    const standard = await client.messages.stream(params).finalMessage();
    text = textOf(standard.content);
  }

  if (!text) throw new Error('Claude returned no structured output');

  let parsed: RebuildDraft;
  try {
    parsed = RebuildSchema.parse(JSON.parse(text));
  } catch {
    // Truncation lands here now instead of as a raw JSON error. Say which it is.
    throw new Error(
      'Claude returned copy that did not parse — most likely the source ad is long enough to exceed the output ceiling. Try a shorter source ad.',
    );
  }

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
