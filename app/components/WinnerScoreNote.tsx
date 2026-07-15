/**
 * The standing disclosure that Winner Score is longevity, not reach.
 *
 * CLAUDE.md makes this non-negotiable: someone will otherwise quote the number
 * in a meeting as measured impressions. It is a component rather than inline
 * markup so it travels with the score wherever the score goes, and so deleting
 * it is a deliberate act rather than a layout tidy-up.
 *
 * Do not remove this to clean up a layout.
 */
export function WinnerScoreNote() {
  return (
    <p className="rail-note">
      Still running, and running longer than three quarters of this brand&rsquo;s
      own live ads. Atria returns no impressions, so this is a longevity proxy —{' '}
      <strong>not reach</strong>. The dates behind every score are shown on the
      clip.
    </p>
  );
}

/**
 * The dates behind a score. Always render this next to a Winner Score;
 * the score alone is not allowed to stand on its own.
 *
 * For a running ad we deliberately print "still running" rather than the
 * end_date: Atria's end_date on an active ad is only "last seen", so showing it
 * would read as the day the ad stopped when it hasn't.
 */
export function RunDates({
  startDate,
  endDate,
  status,
  runDays,
}: {
  startDate: string | null;
  endDate: string | null;
  status: 'active' | 'inactive';
  runDays: number | null;
}) {
  const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');
  return (
    <span className="num" style={{ fontSize: 11, color: 'var(--ink-faint)' }}>
      {day(startDate)} → {status === 'active' ? 'still running' : day(endDate)}
      {runDays !== null && ` · ${runDays}d`}
    </span>
  );
}
