import { NextResponse } from 'next/server';
import { syncTrackedBrands } from '@/lib/ingest';

export const maxDuration = 300;

/**
 * Trigger an ingest of every tracked brand.
 *
 * This runs with the service-role key and so bypasses RLS. Real auth (admin
 * role) is not built yet, so until it is, the route is gated on a shared secret
 * and FAILS CLOSED when that secret is unset — an unguarded write endpoint on a
 * public deployment would hand anyone the ability to hammer our Atria quota.
 * Replace this check with the admin role check once auth lands.
 */
export async function POST(req: Request) {
  const expected = process.env.SYNC_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: 'SYNC_SECRET is not configured; refusing to run.' },
      { status: 503 },
    );
  }
  if (req.headers.get('x-sync-secret') !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const reports = await syncTrackedBrands();
    const failed = reports.filter((r) => r.error);
    return NextResponse.json(
      { ok: failed.length === 0, reports },
      { status: failed.length ? 207 : 200 },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
