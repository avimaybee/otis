/**
 * Labeled contract-only story shell. Used for fixture IDs whose production UI
 * belongs to a later checkpoint (voice/010, briefs/011, offline/008D, entity
 * timeline/008C). It authorizes no shipped control and counts as no feature
 * acceptance: it only records the expected content contract for review.
 */
export function ContractOnly({ fixtureId, expects, owner }: { fixtureId: string; expects: string; owner: string }) {
  return (
    <div className="sb-contract">
      <p className="sb-contract__id text-xs">{fixtureId}</p>
      <p className="sb-contract__title text-base">Contract only, not implemented</p>
      <p className="sb-contract__body text-sm">{expects}</p>
      <p className="sb-contract__owner text-xs">Owning checkpoint: {owner}</p>
    </div>
  );
}
