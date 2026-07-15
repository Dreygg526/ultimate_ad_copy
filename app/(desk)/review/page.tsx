// Step 3c: draft → waiting → changes asked → approved.
export default function ReviewPage() {
  return (
    <main style={{ padding: 24 }}>
      <p className="eyebrow">Review</p>
      <p style={{ color: 'var(--ink-soft)', maxWidth: '52ch' }}>
        Rebuilds waiting on a decision appear here.
      </p>
    </main>
  );
}
