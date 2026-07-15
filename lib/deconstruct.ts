import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod';
import { readCreative, type VisionRead } from '@/lib/vision';

/**
 * Step 3a, second half: Claude reads the structure.
 *
 * Claude is handed Gemini's read of the image plus the ad's own copy, and picks
 * which located elements are worth a mark. It cannot see the creative, so it
 * cannot invent a coordinate — it references an observation by index and we
 * merge the coordinates back in here. That's the whole reason for the split.
 */

const MODEL = 'claude-opus-4-8';

// Claude selects an observation and says why it works. Coordinates are Gemini's.
const MarkSchema = z.object({
  observation: z
    .number()
    .int()
    .describe('Index into the numbered observations list — the element this mark points at.'),
  heading: z.string().describe('Two to four words naming the move. Sentence case, no full stop.'),
  body: z
    .string()
    .describe('One or two sentences on why this works on a cold reader. No hedging, no preamble.'),
});

const DeconstructionSchema = z.object({
  summary: z
    .string()
    .describe(
      'Two or three sentences: what this ad is actually doing to earn the click, in the order the eye takes it.',
    ),
  marks: z.array(MarkSchema).min(3).max(7),
});

export type Deconstruction = z.infer<typeof DeconstructionSchema>;

/** What the UI and the DB want: a mark carries its own position. */
export interface PlacedMark {
  x: number;
  y: number;
  heading: string;
  body: string;
}

export interface DeconstructResult {
  summary: string;
  marks: PlacedMark[];
  model: string;
  vision: VisionRead;
}

export interface AdForDeconstruction {
  brand_name: string | null;
  title: string | null;
  body: string | null;
  caption: string | null;
  cta_text: string | null;
  status: string | null;
  run_days: number | null;
  images: { url: string }[] | null;
}

const SYSTEM = `You deconstruct winning native ads for The Standard Lab's media buyers.

Your readers are expert buyers. They know what a hook is, what a lead is, what a
pattern interrupt is. Never explain the vocabulary and never pad. If a note could
appear under any ad, it is worthless — every note must be about THIS creative.

You are working from another model's read of the image. You cannot see the ad
yourself, so never claim to have seen anything that isn't in that read, and never
describe visual detail it didn't report.

Marks point at specific elements. Choose the elements that actually carry the
ad — the ones a buyer would rebuild first. Skip anything present merely because
every ad has one. Say what the move is and why it lands on a cold reader who did
not ask to see this.`;

function buildPrompt(ad: AdForDeconstruction, vision: VisionRead): string {
  const lines = [
    'THE AD',
    `Brand: ${ad.brand_name ?? 'unknown'}`,
    `Headline: ${ad.title ?? '(none)'}`,
    `Body: ${ad.body ?? '(none)'}`,
    `Caption: ${ad.caption ?? '(none)'}`,
    `CTA: ${ad.cta_text ?? '(none)'}`,
    '',
    'HOW IT HAS PERFORMED',
    // Longevity is the only performance signal we have; be explicit about that
    // so the model never dresses it up as reach.
    `It has run for ${ad.run_days ?? 'an unknown number of'} days and is currently ${
      ad.status === 'active' ? 'still live' : 'stopped'
    }. Run length is the only performance signal available — there is no`,
    'impressions or spend data. Do not describe this ad as high-reach or',
    'high-spend, and do not speculate about its numbers.',
    '',
    'WHAT THE IMAGE SHOWS (read by a vision model, not by you)',
    vision.scene,
    '',
    vision.text_in_image.length
      ? `Text burned into the image: ${vision.text_in_image.map((t) => `"${t}"`).join(' · ')}`
      : 'No text is burned into the image.',
    '',
    'LOCATED ELEMENTS — reference these by index in your marks:',
    ...vision.observations.map((o, i) => `  [${i}] ${o.what}`),
    '',
    `Write the deconstruction. Use between 3 and ${Math.min(
      7,
      vision.observations.length,
    )} marks, each pointing at a different element by its index.`,
  ];
  return lines.join('\n');
}

export async function deconstructAd(ad: AdForDeconstruction): Promise<DeconstructResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const art = ad.images?.[0]?.url;
  if (!art) throw new Error('This ad has no image to deconstruct.');

  const vision = await readCreative(art);
  const client = new Anthropic({ apiKey });

  const message = await client.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    system: SYSTEM,
    messages: [{ role: 'user', content: buildPrompt(ad, vision) }],
    output_config: {
      effort: 'high',
      format: zodOutputFormat(DeconstructionSchema),
    },
  });

  const parsed = message.parsed_output;
  if (!parsed) throw new Error('Claude returned no structured output');

  // Drop marks pointing at an observation that doesn't exist rather than
  // dropping a mark at 0,0 — a mark in the wrong place misleads silently.
  const marks: PlacedMark[] = parsed.marks
    .filter((m) => vision.observations[m.observation] !== undefined)
    .map((m) => {
      const o = vision.observations[m.observation];
      return { x: o.x, y: o.y, heading: m.heading, body: m.body };
    });

  if (marks.length === 0) throw new Error('No mark landed on a located element');

  return { summary: parsed.summary, marks, model: `${MODEL} + ${vision.model}`, vision };
}
