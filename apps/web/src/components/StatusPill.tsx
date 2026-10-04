/**
 * Lead status pill. Warm and hot use the highlight outline; every other state
 * stays neutral and won uses success text. Domain status names are unchanged.
 */
export function StatusPill({ status }: { status: string }) {
  if (status === 'hot') {
    return <span className="inline-flex h-[22px] items-center gap-1 rounded-full border border-highlight px-2 text-xs text-highlight"><span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-highlight" />hot</span>;
  }
  if (status === 'warm') {
    return <span className="inline-flex h-[22px] items-center rounded-full border border-highlight px-2 text-xs text-highlight">warm</span>;
  }
  if (status === 'won') {
    return <span className="inline-flex h-[22px] items-center rounded-full border border-border px-2 text-xs text-success">won</span>;
  }
  return <span className="inline-flex h-[22px] items-center rounded-full border border-border px-2 text-xs text-muted-foreground">{status}</span>;
}
