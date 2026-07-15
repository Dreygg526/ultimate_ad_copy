// Step 3b: Claude writes headline + copy, Gemini generates the image.
// Nothing generates without brand grounding — that gate lives server-side.
export default function RebuildPage() {
  return (
    <main style={{ padding: 24 }}>
      <p className="eyebrow">Rebuild</p>
      <p style={{ color: 'var(--ink-soft)', maxWidth: '52ch' }}>
        Pick a deconstructed ad to rebuild it against a brand.
      </p>
    </main>
  );
}
