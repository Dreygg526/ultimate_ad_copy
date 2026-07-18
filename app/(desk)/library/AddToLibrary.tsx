'use client';

import { useActionState, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import * as tus from 'tus-js-client';
import { createClient } from '@/lib/supabase/client';
import { addByUrl, saveUpload, type AddState } from './actions';

// Step 1, rebuilt: the buyer stocks the Library. Files go browser → Storage
// directly and resumably (a 1 GB body can't pass through a server action), then
// a tiny server action records the row. URLs go straight to a server action.

const MAX_BYTES = 1_000_000_000; // 1 GB
const CHUNK = 6 * 1024 * 1024; // Supabase resumable uploads require exactly 6 MB.

function UrlSubmit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn is-quiet" disabled={pending}>
      {pending ? 'Scanning…' : 'Add URL'}
    </button>
  );
}

export function AddToLibrary() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [pct, setPct] = useState<number | null>(null);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [uploadName, setUploadName] = useState<string | null>(null);

  const [urlState, urlAction] = useActionState<AddState, FormData>(addByUrl, { error: null });

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be re-picked after an error
    if (!file) return;

    setUploadErr(null);
    const kind = file.type.startsWith('image/')
      ? 'image'
      : file.type.startsWith('video/')
        ? 'video'
        : null;
    if (!kind) return setUploadErr('Pick an image or a video.');
    if (file.size > MAX_BYTES) return setUploadErr('That file is over the 1 GB limit.');

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return setUploadErr('Session expired — sign in again.');

    const safe = file.name.replace(/[^\w.\-]+/g, '_');
    const path = `${session.user.id}/${crypto.randomUUID()}-${safe}`;

    setUploadName(file.name);
    setPct(0);

    const upload = new tus.Upload(file, {
      endpoint: `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/upload/resumable`,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: { authorization: `Bearer ${session.access_token}`, 'x-upsert': 'true' },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      chunkSize: CHUNK,
      metadata: {
        bucketName: 'library',
        objectName: path,
        contentType: file.type,
        cacheControl: '3600',
      },
      onError: (err) => {
        setPct(null);
        setUploadName(null);
        setUploadErr(err.message || 'Upload failed.');
      },
      onProgress: (sent, total) => setPct(Math.round((sent / total) * 100)),
      onSuccess: async () => {
        const res = await saveUpload({
          path,
          kind,
          bytes: file.size,
          mime: file.type,
          title: file.name,
        });
        setPct(null);
        setUploadName(null);
        if (res.error) return setUploadErr(res.error);
        router.refresh();
      },
    });

    // Resume a prior interrupted upload of the same file if one is pending.
    const prev = await upload.findPreviousUploads();
    if (prev.length) upload.resumeFromPreviousUpload(prev[0]);
    upload.start();
  }

  return (
    <div className="rail-group add-lib">
      <p className="eyebrow">Add to library</p>

      <button
        type="button"
        className="btn"
        onClick={() => fileRef.current?.click()}
        disabled={pct !== null}
      >
        {pct !== null ? `Uploading… ${pct}%` : 'Upload image or video'}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*"
        hidden
        onChange={onPick}
      />

      {pct !== null && (
        <div className="uploadbar" aria-label={`Uploading ${uploadName ?? ''}`}>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
      {uploadErr && <p className="gate-error" style={{ marginTop: 8 }}>{uploadErr}</p>}

      <p className="add-hint">Up to 1 GB each. Video is stored and playable; deconstruction is image-only for now.</p>

      <form action={urlAction} className="add-url">
        <input
          name="url"
          type="url"
          className="input"
          placeholder="Meta ad, advertiser page, or direct file link"
          autoComplete="off"
        />
        <UrlSubmit />
      </form>
      <p className="add-hint">
        Paste an advertiser page URL (…?view_all_page_id=…) to scan it and pull only its winners
        (top-quartile run length — longevity, not reach). Or a single ad, or a direct image/video
        link.
      </p>
      {urlState.error && <p className="gate-error" style={{ marginTop: 6 }}>{urlState.error}</p>}
      {urlState.added != null && !urlState.error && (
        <p className="form-ok">
          Added {urlState.added} winner{urlState.added === 1 ? '' : 's'} from {urlState.brand}
          {urlState.scanned ? ` (scanned ${urlState.scanned} active ads)` : ''}. Scroll the grid to
          see them.
        </p>
      )}
      {urlState.adId && !urlState.error && (
        <p className="form-ok">Added. Refresh or scroll the grid to see it.</p>
      )}
    </div>
  );
}
