/** A Dev World case the lab can start: one release per media variant plus the resolve scenarios. */
export type VariantCase = {
  id: string;
  label: string;
  title: string;
  workId: string;
  releaseId?: string;
  /** What the case exercises beyond its media (dead rank-1 release, degraded release). */
  scenario?: 'fallback' | 'degraded';
};

type ManifestRelease = {
  releaseId: string;
  variant: string;
  variantLabel?: string;
  health: string;
  rank: number;
};
type ManifestTitle = { title: string; workId?: string; releases?: ManifestRelease[] };
type Manifest = {
  titles?: ManifestTitle[];
  scenarios?: { deadFallback?: { workId: string }[] };
};

/** Builds the case list from the Dev World manifest (`GET /devworld.json`). */
export function variantCases(manifest: Manifest): VariantCase[] {
  const cases: VariantCase[] = [];
  const seen = new Set<string>();
  const titles = manifest.titles ?? [];
  for (const title of titles) {
    for (const release of title.releases ?? []) {
      if (!title.workId || release.health !== 'ready' || seen.has(release.variant)) continue;
      seen.add(release.variant);
      cases.push({
        id: release.variant,
        label: release.variantLabel ?? release.variant,
        title: title.title,
        workId: title.workId,
        releaseId: release.releaseId,
      });
    }
  }
  cases.sort((a, b) => a.id.localeCompare(b.id));
  const dead = manifest.scenarios?.deadFallback?.find((item) =>
    item.workId.startsWith('tmdb-movie')
  );
  const deadTitle = titles.find((title) => title.workId === dead?.workId);
  if (dead && deadTitle)
    cases.push({
      id: 'fallback',
      label: dead.workId,
      title: deadTitle.title,
      workId: dead.workId,
      scenario: 'fallback',
    });
  const degraded = titles.find((title) =>
    (title.releases ?? []).some((release) => release.rank === 1 && release.health === 'degraded')
  );
  if (degraded?.workId)
    cases.push({
      id: 'degraded',
      label: degraded.workId,
      title: degraded.title,
      workId: degraded.workId,
      scenario: 'degraded',
    });
  return cases;
}

export async function loadVariantCases(
  serverUrl: string,
  signal?: AbortSignal
): Promise<VariantCase[]> {
  const response = await fetch(`${serverUrl.replace(/\/+$/, '')}/devworld.json`, { signal });
  if (!response.ok) throw new Error(`devworld.json ${response.status}`);
  return variantCases((await response.json()) as Manifest);
}
