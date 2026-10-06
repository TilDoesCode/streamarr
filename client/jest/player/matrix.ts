/** A state-matrix row id (docs/client/player/state-matrix.md § 1), e.g. `C17`. */
export type RowId = `${'A' | 'B' | 'C' | 'D' | 'E'}${number}`;

/** A row's regression test; the coverage test finds it by `row('<id>'`. */
export function row(id: RowId, title: string, test: () => void | Promise<void>): void {
  it(`${id} ${title}`, async () => {
    await test();
  });
}

/** A row (or the rest of a row) not built yet: listed as a todo with the slice that closes it. */
export function pending(id: RowId, title: string, slice: string): void {
  it.todo(`${id} ${title} — pending (${slice})`);
}
