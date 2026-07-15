import 'server-only';
import { GoogleGenAI, Type } from '@google/genai';

/**
 * Step 3a, first half: Gemini reads the image.
 *
 * This module only reports what is on the creative and where. It deliberately
 * does not reason about why any of it works — that is Claude's half, in
 * lib/deconstruct.ts. Keeping the split honest matters for the marks: Claude
 * never sees the image, so it can't invent coordinates, and Gemini never writes
 * strategy, so the notes stay in one voice.
 */

// Vision quality is the whole job here — a misread creative poisons everything
// downstream — so this is the pro tier, not flash.
//
// Pinned, not `gemini-pro-latest`: an alias would change what the marks say
// without anything in the repo changing. The cost is that previews retire —
// gemini-3-pro-preview already did, and models.list still advertises it — so if
// this starts 404ing, that's why. Repoint it here.
const VISION_MODEL = 'gemini-3.1-pro-preview';

export interface Observation {
  /** 0–100, percentage of width. Origin is the top-left of the image. */
  x: number;
  /** 0–100, percentage of height. */
  y: number;
  /** What is physically at that point. */
  what: string;
}

export interface VisionRead {
  /** Plain description of the creative as a whole. */
  scene: string;
  /** Text burned into the image, in reading order. Empty if none. */
  text_in_image: string[];
  observations: Observation[];
  model: string;
}

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    scene: { type: Type.STRING },
    text_in_image: { type: Type.ARRAY, items: { type: Type.STRING } },
    observations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          x: { type: Type.NUMBER },
          y: { type: Type.NUMBER },
          what: { type: Type.STRING },
        },
        required: ['x', 'y', 'what'],
      },
    },
  },
  required: ['scene', 'text_in_image', 'observations'],
};

const PROMPT = `You are looking at a native/social ad creative. Report only what is
physically there. Do not evaluate it, do not guess at strategy, do not speculate
about the advertiser's intent — another model does that part.

Return:
- scene: what the image shows, plainly. Two or three sentences.
- text_in_image: every piece of text burned into the image, in reading order,
  verbatim. Empty array if there is none.
- observations: 4 to 8 distinct, individually locatable elements a media buyer
  would point at — the focal subject, each text block, the logo, a face, a
  device frame, a price, a badge, an arrow, a visual seam between two pasted
  halves. One entry per element. Do not include the same element twice, and do
  not describe the image as a whole here.

For each observation, x and y are the CENTRE of that element as a percentage of
the image: x is 0 at the left edge and 100 at the right edge, y is 0 at the top
edge and 100 at the bottom edge. Be precise — these coordinates get drawn as
marks directly on the creative, and a mark in the wrong place is worse than no
mark. Sanity-check each one against what it points at before you answer.`;

/** Fetch the creative from Atria's CDN. Server-side only; the browser never does this. */
async function fetchArt(url: string): Promise<{ data: string; mimeType: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`creative fetch failed: ${res.status} ${url.slice(0, 80)}`);

  const mimeType = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim();
  if (!mimeType.startsWith('image/')) throw new Error(`not an image: ${mimeType}`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0) throw new Error('creative was empty');
  return { data: buf.toString('base64'), mimeType };
}

export async function readCreative(imageUrl: string): Promise<VisionRead> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const art = await fetchArt(imageUrl);
  const ai = new GoogleGenAI({ apiKey });

  const res = await ai.models.generateContent({
    model: VISION_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: art.mimeType, data: art.data } },
          { text: PROMPT },
        ],
      },
    ],
    config: { responseMimeType: 'application/json', responseSchema: SCHEMA },
  });

  const raw = res.text;
  if (!raw) throw new Error('Gemini returned no text');

  let parsed: Omit<VisionRead, 'model'>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Gemini returned non-JSON: ${raw.slice(0, 120)}`);
  }

  // A coordinate outside the frame can't be drawn, and one that's merely wrong
  // is invisible to us here — clamping is all we can honestly do.
  const observations = (parsed.observations ?? [])
    .filter((o) => Number.isFinite(o?.x) && Number.isFinite(o?.y) && o?.what)
    .map((o) => ({
      x: Math.min(100, Math.max(0, o.x)),
      y: Math.min(100, Math.max(0, o.y)),
      what: o.what,
    }));

  if (observations.length === 0) throw new Error('Gemini located nothing on the creative');

  return {
    scene: parsed.scene ?? '',
    text_in_image: parsed.text_in_image ?? [],
    observations,
    model: VISION_MODEL,
  };
}
