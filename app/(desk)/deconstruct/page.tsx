// Step 3a: Gemini reads the image, Claude reads the structure.
export default function DeconstructPage() {
  return (
    <main style={{ padding: 24 }}>
      <p className="eyebrow">Deconstruct</p>
      <p style={{ color: 'var(--ink-soft)', maxWidth: '52ch' }}>
        Pick an ad from the Library to deconstruct it.
      </p>
    </main>
  );
}
