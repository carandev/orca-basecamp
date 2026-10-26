/**
 * Pure reconciliation of one linked item. O = Orca workspace status, B = Basecamp state
 * (to-do: 'open' | 'completed'; card: 'completed' or the numeric column id as a string).
 * `statusToColumn` is the project's `{status: [columnId, ...]}` map (first column = destination), `baseline` the last synced `{orca, bc, lastOpenOrca?}`.
 * Returns `{baseline, writeOrca?, writeBc?, conflict?}`; `at` is added by the caller.
 */
export function reconcile({ kind, baseline, orca, bc, statusToColumn = {}, rule = 'orca-wins' }) {
  const columnsOf = (status) => (Object.hasOwn(statusToColumn, status) ? statusToColumn[status] : null);
  const firstStatusFor = (column) => Object.keys(statusToColumn).find((s) => statusToColumn[s].includes(column)) ?? null;
  /** Where the card must be for status S: where it already is when that column belongs to S, else S's first column. */
  const columnFor = (status, current) => {
    const columns = columnsOf(status);
    if (columns === null) return null;
    return columns.includes(current) ? current : columns[0];
  };

  const next = (nextOrca, nextBc) => {
    const lastOpenOrca = nextOrca !== 'completed' ? nextOrca : baseline?.lastOpenOrca;
    return lastOpenOrca === undefined ? { orca: nextOrca, bc: nextBc } : { orca: nextOrca, bc: nextBc, lastOpenOrca };
  };

  if (!baseline) return { baseline: next(orca, bc) };

  const wantBc = orca === 'completed' ? 'completed' : kind === 'todo' ? 'open' : columnFor(orca, bc);
  const wantOrca =
    bc === 'completed'
      ? 'completed'
      : kind === 'todo'
        ? orca !== 'completed'
          ? orca
          : (baseline.lastOpenOrca ?? 'in-progress')
        : columnsOf(orca)?.includes(bc)
          ? orca
          : firstStatusFor(bc);

  const oEff = orca !== baseline.orca && wantBc !== null;
  const bEff = bc !== baseline.bc && wantOrca !== null;

  if (oEff && bEff) {
    if (wantBc === bc) return { baseline: next(orca, bc) };
    if (rule === 'basecamp-wins') {
      return { baseline: next(wantOrca, bc), writeOrca: wantOrca, conflict: { winner: 'basecamp', orca, bc } };
    }
    return { baseline: next(orca, wantBc), writeBc: wantBc, conflict: { winner: 'orca', orca, bc } };
  }
  if (oEff) return wantBc === bc ? { baseline: next(orca, bc) } : { baseline: next(orca, wantBc), writeBc: wantBc };
  if (bEff) return wantOrca === orca ? { baseline: next(orca, bc) } : { baseline: next(wantOrca, bc), writeOrca: wantOrca };
  return { baseline: next(orca, bc) };
}
