import type { TFunction } from 'i18next';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { toAppError } from '@/api/errors';
import { seasonName } from '@/browse/season-name';
import { useBackHandler } from '@/components/focus';
import { ArrowLeft, CircleCheck, Download, Lock, Package } from '@/components/icons';
import { EmptyState } from '@/components/states/empty-state';
import { ErrorState } from '@/components/states/error-state';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useToast } from '@/components/ui/toast';
import {
  downloadErrorText,
  useDownloadActions,
  useDownloadCandidates,
  useDownloadFor,
  useDownloadPlan,
  useDownloadsSupported,
  useDownloadSpace,
  useSeasonDownloadCandidates,
  useSeasonDownloads,
  type CandidateWithSpace,
  type DownloadCandidate,
  type PackWithSpace,
} from '@/downloads';
import { META_SEPARATOR } from '@/lib/media-labels';
import { parseWorkId } from '@/lib/work-id';
import { useShell } from '@/shell/use-shell';
import { colors, useDesign, useFocusGap } from '@/theme';

import { CandidateCard, SpaceLine } from './candidate-card';
import {
  defaultAnchor,
  defaultCandidate,
  eachRows,
  packRows,
  packSelections,
  releaseOf,
  requestItems,
  seasonWorkIdOf,
  selectionOf,
  similarRows,
  type ReviewRow,
  type SeasonMode,
} from './download-model';
import { useSizeText } from './download-text';
import { AnchorEpisodeRow } from './anchor-episode-row';
import { ReviewRowItem, rowFocusTarget } from './review-row';

export type DownloadRequest = {
  /** Movie, episode or season work id. */
  workId: string;
  /** Movie title, or "Series · S1 E2 · Episode". */
  title: string;
  seriesTitle?: string | null;
};

type Scope = 'single' | 'season';
type Step =
  | { kind: 'main' }
  | { kind: 'pick'; workId: string; purpose: 'anchor' | 'row' }
  | { kind: 'anchor' }
  | { kind: 'started'; count: number };

type ModeState<T> = Record<SeasonMode, T>;
const emptyModes = <T,>(make: () => T): ModeState<T> => ({
  pack: make(),
  similar: make(),
  each: make(),
});

export type DownloadFlowParts = {
  /** Title, subtitle and the scope/mode switches. */
  header: ReactNode;
  body: ReactNode;
  /** Summary and the confirm button (pinned under the list). */
  footer: ReactNode;
  /** Changes with the step: frames restart their scroll position. */
  stepKey: string;
};

/** The download sheet's content: movie/episode versions, or a season as pack, "rest similar" or each yourself. */
export function useDownloadFlow({
  request,
  onClose,
  onOpenDownloads,
}: {
  request: DownloadRequest;
  onClose: () => void;
  onOpenDownloads: () => void;
}): DownloadFlowParts {
  const { t, i18n } = useTranslation();
  const design = useDesign();
  const { s } = useShell();
  const toast = useToast();
  const size = useSizeText();
  const actions = useDownloadActions();
  const support = useDownloadsSupported();
  const space = useDownloadSpace();
  const ref = parseWorkId(request.workId);
  const seasonWorkId = seasonWorkIdOf(request.workId);
  const startedFrom = ref?.kind === 'episode' ? request.workId : null;
  const [scope, setScope] = useState<Scope>(ref?.kind === 'season' ? 'season' : 'single');
  const [step, setStep] = useState<Step>({ kind: 'main' });
  const [picked, setPicked] = useState<string>();
  const [modeChoice, setModeChoice] = useState<SeasonMode>();
  const [packChoice, setPackChoice] = useState<string>();
  const [anchorChoice, setAnchorChoice] = useState<{ workId: string; releaseId: string }>();
  const [overrides, setOverrides] = useState(() => emptyModes<Record<string, string>>(() => ({})));
  const [deselected, setDeselected] = useState(() => emptyModes(() => new Set<string>()));
  const [returnTo, setReturnTo] = useState<string>();
  const [busy, setBusy] = useState(false);
  const allowed = support.supported;
  const single = scope === 'single';

  const singleQuery = useDownloadCandidates(request.workId, { enabled: allowed && single });
  const seasonQuery = useSeasonDownloadCandidates(seasonWorkId, {
    enabled: allowed && !single && !!seasonWorkId,
  });
  const own = useDownloadFor(single ? request.workId : null);
  const seasonDownloads = useSeasonDownloads(seasonWorkId);
  const season = seasonQuery.data;
  const episodes = useMemo(() => season?.episodes ?? [], [season]);
  const packs = useMemo(
    () => (season?.packs ?? []).filter((pack) => pack.offline.playable),
    [season]
  );
  const mode: SeasonMode = modeChoice ?? (packs.length ? 'pack' : 'similar');
  const rowInput = {
    episodes,
    existing: seasonDownloads.items,
    overrides: overrides[mode],
    deselected: deselected[mode],
  };
  // A pack fits by what it would download now (minus episodes on the device or deselected), not by its full size.
  const packSelection = packSelections({ ...rowInput, deselected: deselected.pack }, packs);
  const packVerdict = (item: PackWithSpace) => {
    const chosenEpisodes = packSelection.get(item);
    return chosenEpisodes?.count
      ? space.verdict(chosenEpisodes.bytes, chosenEpisodes.estimate)
      : item.space;
  };
  const pack =
    packs.find((item) => releaseOf(item) === packChoice) ?? defaultPack(packs, packVerdict);
  // Failed downloads are not held: the plan and the anchor may pick them again.
  const held = new Set(
    seasonDownloads.items.filter((item) => item.state !== 'failed').map((item) => item.workId)
  );
  const anchor = anchorChoice ?? defaultAnchor(episodes, startedFrom, held);
  // The plan's query key holds the ids themselves, so a new array per render asks nothing again.
  const planTargets = episodes
    .filter(
      (episode) =>
        !!episode.workId &&
        episode.workId !== anchor?.workId &&
        !held.has(episode.workId) &&
        episode.candidates.some((item) => item.offline.playable)
    )
    .map((episode) => episode.workId!);
  const plan = useDownloadPlan(
    mode === 'similar' && !single ? (anchor ?? null) : null,
    planTargets
  );
  const rows: ReviewRow[] =
    mode === 'pack'
      ? packRows(rowInput, pack)
      : mode === 'each'
        ? eachRows(rowInput)
        : similarRows(rowInput, planTargets.length ? plan.data?.items : [], anchor ?? null);
  const selection = selectionOf(rows);
  const seasonVerdict = space.verdict(selection.bytes, selection.estimate);

  const downloadable = singleQuery.data?.downloadable ?? [];
  // A failed download can be replaced: the server's suggestion first, else the best other version.
  const failed = own.download?.state === 'failed' ? own.download : null;
  const keepsOwn = !!own.download && !failed;
  const failedRelease = failed?.releaseId;
  const suggested = failed?.error?.params?.suggestedReleaseId;
  const chosen =
    downloadable.find((item) => releaseOf(item) === picked) ??
    (failed
      ? (downloadable.find((item) => releaseOf(item) === suggested) ??
        defaultCandidate(downloadable.filter((item) => releaseOf(item) !== failedRelease)))
      : undefined) ??
    defaultCandidate(downloadable);
  // The fit is read again at every render and on press: a picked version stays visible but blocked once it no longer fits.
  const chosenFits = !!chosen && space.verdict(chosen.sizeBytes, !chosen.sizeExact).fits;

  const back = () => {
    if (step.kind === 'pick' || step.kind === 'anchor') {
      setReturnTo(step.kind === 'anchor' || step.purpose === 'anchor' ? 'anchor' : step.workId);
      setStep({ kind: 'main' });
      return true;
    }
    return false;
  };
  useBackHandler(back, step.kind === 'pick' || step.kind === 'anchor');

  const start = async (items: ReturnType<typeof requestItems>) => {
    if (!items.length || busy) return;
    setBusy(true);
    try {
      const started = await actions.start(items);
      setStep({ kind: 'started', count: started.length || items.length });
    } catch {
      toast.show({ message: t('downloads.sheet.startFailed'), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const seasonTitle = season ? seasonName(t, null, season.seasonNumber) : null;
  const subtitle =
    !single && request.seriesTitle && seasonTitle
      ? `${request.seriesTitle}${META_SEPARATOR}${seasonTitle}`
      : request.title;
  const free = space.availableBytes;
  const headerGap = s(14);

  const scopeSwitch =
    startedFrom && seasonWorkId && step.kind === 'main' ? (
      <SegmentedControl
        testID="download-scope"
        label={t('downloads.sheet.scope.label')}
        stretch={design.formFactor === 'phone'}
        value={scope}
        onChange={(next) => setScope(next)}
        segments={[
          { value: 'single', label: t('downloads.sheet.scope.episode') },
          { value: 'season', label: t('downloads.sheet.scope.season') },
        ]}
      />
    ) : null;
  const modeSwitch =
    !single && season && step.kind === 'main' ? (
      <View style={{ gap: s(8) }}>
        <SegmentedControl
          testID="download-mode"
          label={t('downloads.sheet.mode.label')}
          stretch={design.formFactor === 'phone'}
          value={mode}
          onChange={(next) => setModeChoice(next)}
          segments={[
            ...(packs.length
              ? [{ value: 'pack' as const, label: t('downloads.sheet.mode.pack') }]
              : []),
            { value: 'similar', label: t('downloads.sheet.mode.similar') },
            { value: 'each', label: t('downloads.sheet.mode.each') },
          ]}
        />
        <Text testID="download-mode-hint" variant="caption" tone="muted">
          {t(`downloads.sheet.modeHint.${mode}`)}
        </Text>
      </View>
    ) : null;

  const header =
    step.kind === 'pick' ? (
      <PickHeader
        title={t('downloads.sheet.pickTitle', {
          code: episodeCode(t, episodes, step.workId, season?.seasonNumber ?? 0),
        })}
        onBack={back}
      />
    ) : step.kind === 'anchor' ? (
      <PickHeader title={t('downloads.sheet.anchorEpisodeTitle')} onBack={back} />
    ) : (
      <View style={{ gap: headerGap }}>
        <View style={{ gap: s(4) }}>
          <Text role="heading" variant="heading" testID="download-sheet-title">
            {t('downloads.sheet.title')}
          </Text>
          <Text tone="muted" numberOfLines={2} testID="download-sheet-subtitle">
            {subtitle}
          </Text>
        </View>
        {step.kind === 'main' && allowed ? scopeSwitch : null}
        {step.kind === 'main' && allowed ? modeSwitch : null}
        {step.kind === 'main' && allowed && free !== null ? (
          <Text testID="download-free" variant="caption" tone="muted">
            {t('downloads.sheet.free', { size: size(free) })}
          </Text>
        ) : null}
      </View>
    );

  const stepKey = `${step.kind}-${scope}-${mode}-${step.kind === 'pick' ? step.workId : ''}`;

  if (!support.supported)
    return {
      header,
      stepKey,
      footer: <CloseFooter onClose={onClose} preferred />,
      body:
        support.reason === 'permission' ? (
          <EmptyState
            testID="download-not-allowed"
            icon={Lock}
            title={t('downloads.sheet.notAllowedTitle')}
            message={t('downloads.sheet.notAllowedMessage')}
          />
        ) : (
          <EmptyState
            testID="download-unsupported"
            icon={Download}
            title={t('downloads.sheet.unsupportedTitle')}
            message={t('downloads.sheet.unsupportedMessage')}
          />
        ),
    };

  if (step.kind === 'started')
    return {
      header,
      stepKey,
      footer: null,
      body: (
        <EmptyState
          testID="download-started"
          icon={CircleCheck}
          iconColor={colors.success.DEFAULT}
          title={t('downloads.sheet.started.title', { count: step.count })}
          message={t('downloads.sheet.started.message')}
          actions={
            <>
              <Button
                testID="download-open-downloads"
                icon={Download}
                label={t('downloads.sheet.started.open')}
                hasTVPreferredFocus
                onPress={onOpenDownloads}
              />
              <Button
                testID="download-done"
                variant="secondary"
                label={t('common.done')}
                onPress={onClose}
              />
            </>
          }
        />
      ),
    };

  if (step.kind === 'anchor') {
    const usable = episodes.filter(
      (item) => !!item.workId && item.candidates.some((candidate) => candidate.offline.playable)
    );
    return {
      header,
      stepKey,
      footer: null,
      body: (
        <CardList>
          {usable.map((item, index) => (
            <AnchorEpisodeRow
              key={item.workId}
              episode={item}
              seasonNumber={season?.seasonNumber ?? 0}
              held={held.has(item.workId!)}
              current={item.workId === anchor?.workId}
              preferred={anchor ? item.workId === anchor.workId : index === 0}
              onPress={() => setStep({ kind: 'pick', workId: item.workId!, purpose: 'anchor' })}
            />
          ))}
        </CardList>
      ),
    };
  }

  if (step.kind === 'pick') {
    const episode = episodes.find((item) => item.workId === step.workId);
    const choices = (episode?.candidates ?? []).filter((item) => item.offline.playable);
    const pickStreamOnly = episode?.streamOnlyCount ?? 0;
    const current =
      step.purpose === 'anchor'
        ? anchor?.releaseId
        : rows.find((item) => item.workId === step.workId)?.candidate?.version.releaseId;
    const apply = (candidate: CandidateWithSpace) => {
      const releaseId = releaseOf(candidate);
      if (step.purpose === 'anchor') {
        setAnchorChoice({ workId: step.workId, releaseId });
        setOverrides((now) => ({ ...now, similar: {} }));
      } else {
        setOverrides((now) => ({ ...now, [mode]: { ...now[mode], [step.workId]: releaseId } }));
        setDeselected((now) => {
          const next = new Set(now[mode]);
          next.delete(step.workId);
          return { ...now, [mode]: next };
        });
      }
      setReturnTo(step.purpose === 'anchor' ? 'anchor' : step.workId);
      setStep({ kind: 'main' });
    };
    return {
      header,
      stepKey,
      footer: null,
      body: (
        <CardList>
          {choices.map((candidate, index) => (
            <CandidateCard
              key={releaseOf(candidate) || index}
              testID={`download-pick-${index}`}
              candidate={candidate}
              space={candidate.space}
              selected={releaseOf(candidate) === current}
              preferred={current ? releaseOf(candidate) === current : index === 0}
              onPress={() => apply(candidate)}
            />
          ))}
          {pickStreamOnly ? <StreamOnlyLine count={pickStreamOnly} /> : null}
        </CardList>
      ),
    };
  }

  if (single) {
    const query = singleQuery.query;
    const error = query.error && !singleQuery.data ? toAppError(query.error) : undefined;
    const streamOnly = singleQuery.data?.streamOnlyCount ?? 0;
    let body: ReactNode;
    if (keepsOwn)
      body = (
        <AlreadyThere
          downloadState={own.state}
          locked={!!own.locked}
          onOpenDownloads={onOpenDownloads}
        />
      );
    else if (error)
      body = (
        <ErrorState
          testID="download-error"
          code={error.code}
          params={error.params}
          actions={['retry']}
          autoFocus
          onAction={() => void query.refetch()}
        />
      );
    else if (!singleQuery.data) body = <CardSkeletons />;
    else if (!downloadable.length)
      body = (
        <EmptyState
          testID="download-empty"
          icon={Download}
          title={t('downloads.sheet.emptyTitle')}
          message={t('downloads.sheet.emptyMessage')}
          detail={streamOnly ? t('downloads.sheet.streamOnly', { count: streamOnly }) : undefined}
        />
      );
    else
      body = (
        <CardList>
          {failed?.error ? (
            <FormMessage
              testID="download-failed"
              tone="warning"
              title={downloadErrorText(t, failed.error, i18n.language).title}
              message={t('downloads.sheet.failedPickOther', {
                reason: downloadErrorText(t, failed.error, i18n.language).message,
              })}
            />
          ) : null}
          {downloadable.map((candidate, index) => (
            <CandidateCard
              key={releaseOf(candidate) || index}
              testID={`download-candidate-${index}`}
              candidate={candidate}
              extra={
                failedRelease && releaseOf(candidate) === failedRelease ? (
                  <Text
                    testID={`download-candidate-${index}-failed`}
                    variant="caption"
                    style={{ color: colors.danger.DEFAULT }}>
                    {t('downloads.sheet.row.failedBefore')}
                  </Text>
                ) : undefined
              }
              space={candidate.space}
              selected={candidate === chosen}
              preferred={candidate === chosen || (!chosen && index === 0)}
              onPress={() => setPicked(releaseOf(candidate))}
            />
          ))}
          {streamOnly ? <StreamOnlyLine count={streamOnly} /> : null}
        </CardList>
      );
    const ready = !keepsOwn && !!chosen && chosenFits && downloadable.length > 0;
    return {
      header,
      stepKey,
      body,
      footer:
        keepsOwn || (singleQuery.data && !downloadable.length) ? (
          <CloseFooter onClose={onClose} preferred={!keepsOwn} />
        ) : (
          <ConfirmFooter
            testID="download-confirm"
            label={
              chosen
                ? t('downloads.sheet.start', { size: size(chosen.sizeBytes, !chosen.sizeExact) })
                : t('downloads.sheet.action')
            }
            disabled={!ready || busy}
            busy={busy}
            reason={
              singleQuery.data && downloadable.length && space.availableBytes === null
                ? t('downloads.sheet.spaceUnknownReason')
                : singleQuery.data && downloadable.length && !chosen
                  ? t('downloads.sheet.noneFits')
                  : chosen && !chosenFits
                    ? t('downloads.sheet.chosenTooBig', {
                        missing: size(
                          space.verdict(chosen.sizeBytes, !chosen.sizeExact).missingBytes,
                          !chosen.sizeExact
                        ),
                      })
                    : undefined
            }
            onPress={() => {
              if (!chosen || !space.verdict(chosen.sizeBytes, !chosen.sizeExact).fits) return;
              void start(
                requestItems([{ workId: request.workId, title: null, candidate: chosen }], {
                  seriesTitle: request.seriesTitle,
                })
              );
            }}
          />
        ),
    };
  }

  const seasonError =
    seasonQuery.query.error && !season ? toAppError(seasonQuery.query.error) : undefined;
  const planError =
    mode === 'similar' && plan.query.error && !plan.data ? toAppError(plan.query.error) : undefined;
  const toggle = (workId: string) =>
    setDeselected((now) => {
      const next = new Set(now[mode]);
      if (next.has(workId)) next.delete(workId);
      else next.add(workId);
      return { ...now, [mode]: next };
    });
  const anchorEpisode = anchor ? episodes.find((item) => item.workId === anchor.workId) : undefined;
  const anchorCandidate = anchorEpisode?.candidates.find(
    (item) => releaseOf(item) === anchor?.releaseId
  );
  const hasAny = episodes.some((episode) =>
    episode.candidates.some((item) => item.offline.playable)
  );
  const firstFocusable = rows.find((item) => rowFocusTarget(item, mode !== 'pack'));

  let body: ReactNode;
  if (seasonError)
    body = (
      <ErrorState
        testID="download-error"
        code={seasonError.code}
        params={seasonError.params}
        actions={['retry']}
        autoFocus
        onAction={() => void seasonQuery.query.refetch()}
      />
    );
  else if (!season) body = <CardSkeletons />;
  else if (!hasAny && !packs.length)
    body = (
      <EmptyState
        testID="download-empty"
        icon={Download}
        title={t('downloads.sheet.emptyTitle')}
        message={t('downloads.sheet.seasonEmptyMessage')}
      />
    );
  else
    body = (
      <CardList>
        {mode === 'pack'
          ? packs.map((item, index) => (
              <CandidateCard
                key={releaseOf(item) || index}
                testID={`download-pack-${index}`}
                candidate={packCandidate(item)}
                space={packVerdict(item)}
                selected={item === pack}
                preferred={item === pack && !returnTo}
                onPress={() => setPackChoice(releaseOf(item))}
                extra={
                  <PackLine
                    pack={item}
                    total={episodes.length}
                    selectedBytes={packSelection.get(item)?.bytes ?? 0}
                    selectedEstimate={!!packSelection.get(item)?.estimate}
                    testID={`download-pack-${index}-line`}
                  />
                }
              />
            ))
          : null}
        {mode === 'similar' ? (
          <AnchorLine
            code={
              anchorEpisode
                ? episodeCode(t, episodes, anchorEpisode.workId ?? '', season.seasonNumber)
                : null
            }
            candidate={anchorCandidate}
            preferred={returnTo === 'anchor' || !returnTo}
            onChangeVersion={() =>
              anchorEpisode &&
              setStep({ kind: 'pick', workId: anchorEpisode.workId!, purpose: 'anchor' })
            }
            onChangeEpisode={() => setStep({ kind: 'anchor' })}
          />
        ) : null}
        {planError ? (
          <ErrorState
            testID="download-plan-error"
            compact
            code={planError.code}
            params={planError.params}
            actions={['retry']}
            onAction={() => void plan.query.refetch()}
          />
        ) : null}
        <Text variant="overline" tone="muted" style={{ marginTop: s(8) }}>
          {t('downloads.sheet.episodes')}
        </Text>
        {rows.map((item) => (
          <ReviewRowItem
            key={item.workId || item.episodeNumber}
            row={item}
            seasonNumber={season.seasonNumber}
            preferred={
              returnTo === item.workId || (mode === 'each' && !returnTo && item === firstFocusable)
            }
            onToggle={() => toggle(item.workId)}
            onChange={
              mode === 'pack'
                ? undefined
                : () => setStep({ kind: 'pick', workId: item.workId, purpose: 'row' })
            }
          />
        ))}
      </CardList>
    );

  const sizeLabel = size(selection.bytes, selection.estimate);
  return {
    header,
    stepKey,
    body,
    footer: !season ? null : !hasAny && !packs.length ? (
      <CloseFooter onClose={onClose} preferred />
    ) : (
      <ConfirmFooter
        testID="download-confirm"
        summary={
          selection.count
            ? t('downloads.sheet.summary', { count: selection.count, size: sizeLabel })
            : undefined
        }
        space={selection.count ? seasonVerdict : null}
        label={
          selection.count
            ? t('downloads.sheet.startSeason', { count: selection.count, size: sizeLabel })
            : t('downloads.sheet.action')
        }
        disabled={!selection.count || !seasonVerdict.fits || busy}
        busy={busy}
        reason={
          space.availableBytes === null
            ? t('downloads.sheet.spaceUnknownReason')
            : !selection.count
              ? t('downloads.sheet.nothingSelected')
              : !seasonVerdict.fits
                ? t('downloads.sheet.tooBig', {
                    needed: sizeLabel,
                    available: size(seasonVerdict.availableBytes),
                  })
                : undefined
        }
        onPress={() => {
          if (!selection.count || !space.verdict(selection.bytes, selection.estimate).fits) return;
          void start(requestItems(selection.rows, { seriesTitle: request.seriesTitle }));
        }}
      />
    ),
  };
}

function defaultPack(
  packs: readonly PackWithSpace[],
  verdict: (pack: PackWithSpace) => { fits: boolean }
): PackWithSpace | undefined {
  return (
    packs.find((pack) => pack.recommended && verdict(pack).fits) ??
    packs.find((pack) => verdict(pack).fits) ??
    packs[0]
  );
}

function episodeCode(
  t: TFunction,
  episodes: readonly { workId: string | null; episodeNumber: number }[],
  workId: string,
  season: number
): string {
  const episode = episodes.find((item) => item.workId === workId);
  return String(t('media.episodeCode', { season, episode: episode?.episodeNumber ?? 0 }));
}

const packCandidate = (pack: PackWithSpace): DownloadCandidate => ({
  version: pack.version,
  offline: pack.offline,
  sizeBytes: pack.sizeBytes,
  sizeExact: pack.sizeExact,
  sizeSource: pack.sizeExact ? 'resolved' : 'estimate',
  seasonPack: true,
  packEpisodes: pack.episodes,
  recommended: pack.recommended,
});

function PackLine({
  pack,
  total,
  selectedBytes,
  selectedEstimate,
  testID,
}: {
  pack: PackWithSpace;
  total: number;
  selectedBytes: number;
  selectedEstimate: boolean;
  testID: string;
}) {
  const { t } = useTranslation();
  const { s } = useShell();
  const size = useSizeText();
  const covered = [...(pack.episodes ?? [])].sort((a, b) => a - b);
  const first = covered[0] ?? 0;
  const last = covered[covered.length - 1] ?? 0;
  const contiguous = last - first + 1 === covered.length;
  return (
    <View style={{ gap: s(4) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(8) }}>
        <Package size={s(16)} color={colors.foreground.muted} />
        <Text testID={`${testID}-episodes`} variant="caption" tone="muted" numberOfLines={1}>
          {pack.complete
            ? t('downloads.sheet.packComplete', {
                count: covered.length,
                total: total || covered.length,
              })
            : !covered.length
              ? t('versions.seasonPack')
              : contiguous
                ? t('downloads.sheet.packPartial', { from: first, to: last, count: covered.length })
                : t('downloads.sheet.packList', {
                    list: covered.join(', '),
                    count: covered.length,
                  })}
        </Text>
      </View>
      <Text testID={testID} variant="caption" tone="muted" numberOfLines={1}>
        {t('downloads.sheet.packSizes', {
          total: size(pack.sizeBytes, !pack.sizeExact),
          selected: size(selectedBytes, selectedEstimate),
        })}
      </Text>
    </View>
  );
}

/** "Similar to S1, E2": the anchor's version (press to change it) and "Pick another episode"; says so when nothing fits. */
function AnchorLine({
  code,
  candidate,
  onChangeVersion,
  onChangeEpisode,
  preferred,
}: {
  code: string | null;
  candidate: DownloadCandidate | undefined;
  onChangeVersion: () => void;
  onChangeEpisode: () => void;
  preferred: boolean;
}) {
  const { t } = useTranslation();
  const { s } = useShell();
  return (
    <View testID="download-anchor" style={{ gap: s(8) }}>
      {candidate && code ? (
        <>
          <Text variant="overline" tone="muted">
            {t('downloads.sheet.similarTo', { code })}
          </Text>
          <CandidateCard
            testID="download-anchor-card"
            candidate={candidate}
            selected
            preferred={preferred}
            onPress={onChangeVersion}
            extra={
              <Text variant="caption" tone="accent">
                {t('downloads.sheet.anchorChange')}
              </Text>
            }
          />
        </>
      ) : (
        <FormMessage
          testID="download-no-anchor"
          tone="warning"
          title={t('downloads.sheet.noAnchorTitle')}
          message={t('downloads.sheet.noAnchorMessage')}
        />
      )}
      <View style={{ alignSelf: 'flex-start' }}>
        <Button
          testID="download-anchor-episode"
          size="sm"
          variant="secondary"
          label={t('downloads.sheet.anchorEpisode')}
          hasTVPreferredFocus={!candidate && preferred}
          onPress={onChangeEpisode}
        />
      </View>
    </View>
  );
}

function AlreadyThere({
  downloadState,
  locked,
  onOpenDownloads,
}: {
  downloadState: string | null;
  /** On the device but the age rules now exclude it: only Remove (in Downloads). */
  locked: boolean;
  onOpenDownloads: () => void;
}) {
  const { t } = useTranslation();
  const done = downloadState === 'done';
  return (
    <EmptyState
      testID="download-already"
      icon={locked ? Lock : done ? CircleCheck : Download}
      iconColor={done && !locked ? colors.success.DEFAULT : colors.foreground.muted}
      title={
        locked
          ? t('downloads.detail.locked')
          : t(done ? 'downloads.sheet.already.done' : 'downloads.sheet.already.inProgress')
      }
      message={locked ? t('downloads.sheet.already.locked') : undefined}
      actions={
        <Button
          testID="download-open-downloads"
          variant="secondary"
          icon={Download}
          label={t('downloads.sheet.started.open')}
          hasTVPreferredFocus
          onPress={onOpenDownloads}
        />
      }
    />
  );
}

function StreamOnlyLine({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <Text
      testID="download-stream-only"
      variant="caption"
      tone="muted"
      style={{ textAlign: 'center' }}>
      {t('downloads.sheet.streamOnly', { count })}
    </Text>
  );
}

function CardList({ children }: { children: ReactNode }) {
  const { s } = useShell();
  const gap = useFocusGap(s(12), 'ring');
  return <View style={{ gap }}>{children}</View>;
}

function CardSkeletons() {
  const { s } = useShell();
  return (
    <CardList>
      {[0, 1, 2].map((index) => (
        <View key={index} testID="download-loading">
          <Skeleton height={s(124)} radius={s(22)} />
        </View>
      ))}
    </CardList>
  );
}

function PickHeader({ title, onBack }: { title: string; onBack: () => void }) {
  const { t } = useTranslation();
  const { s } = useShell();
  return (
    <View style={{ gap: s(10), alignItems: 'flex-start' }}>
      <Button
        testID="download-pick-back"
        variant="ghost"
        size="sm"
        icon={ArrowLeft}
        label={t('common.back')}
        onPress={onBack}
      />
      <Text role="heading" variant="heading" testID="download-pick-title">
        {title}
      </Text>
    </View>
  );
}

/** `preferred`: the only control of the step (permission off, nothing to download), so TV focus starts here. */
function CloseFooter({ onClose, preferred = false }: { onClose: () => void; preferred?: boolean }) {
  const { t } = useTranslation();
  return (
    <Button
      testID="download-close"
      variant="secondary"
      label={t('common.close')}
      hasTVPreferredFocus={preferred}
      onPress={onClose}
    />
  );
}

function ConfirmFooter({
  testID,
  label,
  disabled,
  busy,
  reason,
  summary,
  space,
  onPress,
}: {
  testID: string;
  label: string;
  disabled: boolean;
  busy: boolean;
  reason?: string;
  summary?: string;
  space?: ReturnType<ReturnType<typeof useDownloadSpace>['verdict']> | null;
  onPress: () => void;
}) {
  const { s } = useShell();
  return (
    <View style={{ gap: s(8) }}>
      {summary ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(12), flexWrap: 'wrap' }}>
          <Text testID={`${testID}-summary`} variant="callout">
            {summary}
          </Text>
          <SpaceLine testID={`${testID}-space`} space={space} />
        </View>
      ) : null}
      {reason ? (
        <Text testID={`${testID}-reason`} variant="caption" tone="warning">
          {reason}
        </Text>
      ) : null}
      <Button
        testID={testID}
        icon={Download}
        label={label}
        disabled={disabled}
        loading={busy}
        onPress={onPress}
      />
    </View>
  );
}
