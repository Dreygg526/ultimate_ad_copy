import { createClient } from '@/lib/supabase/server';
import { Clamp } from '@/app/components/Clamp';
import { AddBrandForm, UploadDocForm } from './BrandForms';

// Prep: research docs → bucket → text extracted → injected into every rebuild.
//
// This screen is what makes Rebuild possible at all. With no docs there is
// nothing to ground against, and an ungrounded rebuild is off-strategy by
// construction — so the DB blocks it and Rebuild sends people here.

const KINDS = [
  { key: 'brand', label: 'Brand', note: 'Who we are and how we sound.' },
  { key: 'audience', label: 'Audience', note: 'Who we are talking to and what they fear.' },
  { key: 'mechanism', label: 'Mechanism', note: 'Why the product works. The thing Raya cannot know.' },
] as const;

interface Doc {
  id: string;
  brand_id: string;
  kind: 'brand' | 'audience' | 'mechanism';
  title: string;
  extracted_text: string | null;
  version: number;
  created_at: string;
}

export default async function BrandPage({
  searchParams,
}: {
  searchParams: Promise<{ brand?: string }>;
}) {
  const sp = await searchParams;
  const db = await createClient();

  // Ours, not the tracked competitors — is_tracked is the whole distinction.
  const { data: brands, error: brandErr } = await db
    .from('brands')
    .select('id, name')
    .eq('is_tracked', false)
    .order('name');

  const list = brands ?? [];
  const current = list.find((b) => b.id === sp.brand) ?? list[0] ?? null;

  const { data: docs } = current
    ? await db
        .from('brand_docs')
        .select('id, brand_id, kind, title, extracted_text, version, created_at')
        .eq('brand_id', current.id)
        .order('version', { ascending: false })
    : { data: [] as Doc[] };

  const rows = (docs ?? []) as Doc[];
  // Latest version per kind is what grounds a rebuild; older ones stay as history.
  const latestOf = (kind: string) => rows.filter((d) => d.kind === kind)[0] ?? null;
  const supersededOf = (kind: string) => rows.filter((d) => d.kind === kind).slice(1);
  const grounded = KINDS.filter((k) => latestOf(k.key)).length;

  return (
    <div className="workbench">
      <aside className="rail">
        <div className="rail-group">
          <p className="eyebrow">Our brands</p>
          {list.length === 0 && (
            <p className="rail-note">
              None yet. Tracked competitors live in the Library; this is for the brands we
              write for.
            </p>
          )}
          {list.map((b) => (
            <a
              key={b.id}
              href={`/brand?brand=${b.id}`}
              className={`source${current?.id === b.id ? ' is-on' : ''}`}
            >
              <span className="source-name">{b.name}</span>
            </a>
          ))}
        </div>

        <div className="rail-group">
          <AddBrandForm />
        </div>
      </aside>

      <main className="sheet">
        <div className="sheet-head">
          <h1 className="sheet-title">{current ? current.name : 'Brand'}</h1>
          <p className="sheet-sub">
            {current
              ? `${grounded} of 3 research kinds on file · ${rows.length} doc${rows.length === 1 ? '' : 's'}`
              : 'Research grounds every rebuild'}
          </p>
        </div>

        {brandErr && <p style={{ color: 'var(--pencil)' }}>Could not load brands: {brandErr.message}</p>}

        {!current && (
          <p style={{ color: 'var(--ink-soft)', maxWidth: '52ch' }}>
            Add a brand on the left, then upload its brand, audience, and mechanism research.
            Rebuild stays blocked until at least one doc is readable — that grounding is the
            reason this tool exists instead of Atria&rsquo;s own agent.
          </p>
        )}

        {current && (
          <>
            <div className="notes-sec">
              <p className="eyebrow">Add research</p>
              <div style={{ marginTop: 10 }}>
                <UploadDocForm brandId={current.id} />
              </div>
              <p className="rail-note" style={{ marginTop: 8, maxWidth: '60ch' }}>
                PDF, DOCX, TXT, MD. Text is extracted on upload and injected into every rebuild
                prompt — a doc we can&rsquo;t read is rejected rather than stored, because it
                would ground nothing while looking like it grounds something.
              </p>
            </div>

            {KINDS.map((k) => {
              const doc = latestOf(k.key);
              const old = supersededOf(k.key);
              return (
                <div key={k.key} className="notes-sec">
                  <p className="eyebrow">
                    {k.label}
                    {doc ? ` · v${doc.version}` : ''}
                  </p>

                  {!doc && (
                    <p className="rail-note" style={{ marginTop: 8 }}>
                      Nothing on file. {k.note}
                    </p>
                  )}

                  {doc && (
                    <div style={{ marginTop: 8 }}>
                      <p className="note-h" style={{ fontSize: 13 }}>
                        {doc.title}
                      </p>
                      {doc.extracted_text ? (
                        <Clamp text={doc.extracted_text} lines={6} />
                      ) : (
                        <p className="gate-error">
                          No text extracted — this doc grounds nothing. Re-upload it.
                        </p>
                      )}
                      <p className="by">
                        {(doc.extracted_text?.length ?? 0).toLocaleString()} characters ·{' '}
                        {doc.created_at.slice(0, 10)}
                        {old.length ? ` · ${old.length} superseded` : ''}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </main>
    </div>
  );
}
