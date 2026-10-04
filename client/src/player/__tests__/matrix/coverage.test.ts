import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOC = join(__dirname, '../../../../../docs/client/player/state-matrix.md');

type Declared = { kind: 'row' | 'pending'; id: string; file: string };

const doc = readFileSync(DOC, 'utf8');
const rowIds = [...doc.matchAll(/^\| ([A-E]\d\d) \|/gm)].map((match) => match[1]!);
const declared: Declared[] = readdirSync(__dirname)
  .filter((file) => /^[A-E]\.test\.ts$/.test(file))
  .flatMap((file) =>
    [
      ...readFileSync(join(__dirname, file), 'utf8').matchAll(/\b(row|pending)\(\s*'([A-Z]\d\d)'/g),
    ].map((match) => ({ kind: match[1] as Declared['kind'], id: match[2]!, file }))
  );
const of = (id: string, kind: Declared['kind']) =>
  declared.filter((entry) => entry.id === id && entry.kind === kind);
const closed = rowIds.filter((id) => of(id, 'row').length && !of(id, 'pending').length);
const partly = rowIds.filter((id) => of(id, 'row').length && of(id, 'pending').length);
const open = rowIds.filter((id) => !of(id, 'row').length && of(id, 'pending').length);

describe(`state matrix coverage — ${rowIds.length} rows: ${closed.length} closed, ${partly.length} partly, ${open.length} pending`, () => {
  it('reads every row of the matrix', () => {
    const total = /Row count:.*= \*\*(\d+)\*\*/.exec(doc)?.[1];
    expect(rowIds).toHaveLength(Number(total));
    expect(new Set(rowIds).size).toBe(rowIds.length);
  });

  it.each(rowIds)('%s has a test in its layer file', (id) => {
    const entries = declared.filter((entry) => entry.id === id);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.file).toBe(`${id[0]}.test.ts`);
    expect(of(id, 'row').length).toBeLessThanOrEqual(1);
    expect(of(id, 'pending').length).toBeLessThanOrEqual(1);
  });

  it('declares no row the matrix does not have', () => {
    expect(declared.filter((entry) => !rowIds.includes(entry.id))).toEqual([]);
  });

  it(`lists the partly closed rows: ${partly.join(' ') || 'none'}`, () => {
    expect(partly.every((id) => of(id, 'row').length === 1)).toBe(true);
  });

  it(`lists the pending rows: ${open.join(' ') || 'none'}`, () => {
    expect(open.length + partly.length + closed.length).toBe(rowIds.length);
  });
});
