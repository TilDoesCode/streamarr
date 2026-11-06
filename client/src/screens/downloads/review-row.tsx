import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { versionHeadline } from '@/browse/version-format';
import { END_OF_ROW, Focusable, FocusGuide, FocusLift, useInitialFocus } from '@/components/focus';
import {
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleArrowDown,
  CircleX,
} from '@/components/icons';
import { SPEC_TONES } from '@/components/spec';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { downloadErrorText } from '@/downloads';
import { META_SEPARATOR } from '@/lib/media-labels';
import { MIN_TEXT } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { colors, fonts, useFocusGap } from '@/theme';

import type { ReviewRow } from './download-model';
import { matchLabel, useSizeText } from './download-text';

/** The row's control that can take focus: "Change" where offered, else the toggle of a selectable row, else none. */
export function rowFocusTarget(row: ReviewRow, changeable: boolean): 'change' | 'toggle' | null {
  if (changeable && canChange(row)) return 'change';
  return row.status === 'ready' ? 'toggle' : null;
}

const canChange = (row: ReviewRow) =>
  row.choices.length > 0 && row.status !== 'on_device' && row.status !== 'in_progress';

/** One episode of the season review: select toggle, the chosen release with its match marker, "Change". */
export function ReviewRowItem({
  row,
  seasonNumber,
  onToggle,
  onChange,
  preferred = false,
}: {
  row: ReviewRow;
  seasonNumber: number;
  onToggle: () => void;
  /** Opens the episode's versions; omitted where the release is fixed (a pack). */
  onChange?: () => void;
  /** TV: takes focus when the review appears again (back from this row's version list). */
  preferred?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { s, font } = useShell();
  const size = useSizeText();
  const gap = useFocusGap(s(12));
  const toggleRef = useRef<View>(null);
  const changeRef = useRef<View>(null);
  const target = rowFocusTarget(row, !!onChange);
  useInitialFocus(target === 'change' ? changeRef : toggleRef, preferred && !!target);
  const code = t('media.episodeCode', { season: seasonNumber, episode: row.episodeNumber });
  const title = row.title ?? t('media.episodeNumber', { episode: row.episodeNumber });
  const label = `${code}${META_SEPARATOR}${title}`;
  const ready = row.status === 'ready';
  const marker = row.match && ready ? matchLabel(t, row.match) : null;
  const candidate = row.candidate;
  const detail = candidate
    ? [
        row.failedBefore
          ? row.failedError
            ? t('downloads.sheet.row.failedWith', {
                reason: downloadErrorText(t, row.failedError, i18n.language).title,
              })
            : t('downloads.sheet.row.failedBefore')
          : null,
        size(candidate.sizeBytes, !candidate.sizeExact),
        versionHeadline(candidate.version) || candidate.version.name,
        candidate.version.releaseGroup,
      ]
        .filter(Boolean)
        .join(META_SEPARATOR)
    : row.status === 'on_device'
      ? t('downloads.detail.onDevice')
      : row.status === 'in_progress'
        ? t('downloads.sheet.row.inProgress')
        : row.status === 'unavailable'
          ? row.aired
            ? t('downloads.sheet.row.unavailable')
            : t('detail.notAired')
          : '';
  const StatusIcon =
    row.status === 'on_device'
      ? CircleCheck
      : row.status === 'in_progress'
        ? CircleArrowDown
        : row.status === 'unavailable'
          ? CircleX
          : row.selected
            ? CircleCheck
            : row.failedBefore
              ? CircleAlert
              : Circle;
  const iconColor =
    row.status === 'on_device'
      ? SPEC_TONES.ok.fg
      : row.status === 'ready' && row.selected
        ? colors.accent.DEFAULT
        : colors.foreground.subtle;
  const text = (value: number, line = value * 1.35) => ({
    fontSize: font(value, MIN_TEXT.subline),
    lineHeight: font(line, MIN_TEXT.subline * (line / value)),
  });
  const body = (
    <View style={{ flex: 1, gap: s(2) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(10) }}>
        <Text
          numberOfLines={1}
          style={[
            text(19, 26),
            {
              flex: 1,
              fontFamily: fonts.bodySemiBold,
              color: ready ? colors.foreground.DEFAULT : colors.foreground.muted,
            },
          ]}>
          {label}
        </Text>
        {marker ? (
          <View
            testID={`review-${row.episodeNumber}-match`}
            style={{
              borderRadius: s(8),
              paddingHorizontal: s(8),
              paddingVertical: s(1),
              backgroundColor: SPEC_TONES[marker.tone].bg,
            }}>
            <Text
              numberOfLines={1}
              style={[
                text(14, 20),
                { fontFamily: fonts.bodySemiBold, color: SPEC_TONES[marker.tone].fg },
              ]}>
              {marker.label}
            </Text>
          </View>
        ) : null}
      </View>
      {row.status === 'loading' ? (
        <Skeleton width={s(240)} height={s(18)} radius={s(6)} />
      ) : (
        <Text
          testID={`review-${row.episodeNumber}-detail`}
          tone="muted"
          numberOfLines={1}
          style={text(16, 22)}>
          {detail}
        </Text>
      )}
    </View>
  );
  return (
    <FocusGuide
      remember
      trap={END_OF_ROW}
      testID={`review-${row.episodeNumber}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap }}>
      <Focusable
        ref={toggleRef}
        testID={`review-${row.episodeNumber}-toggle`}
        role="checkbox"
        aria-checked={ready && row.selected}
        aria-disabled={!ready}
        disabled={!ready}
        accessibilityLabel={`${label}. ${detail}`}
        onPress={onToggle}
        style={{ flex: 1 }}>
        <FocusLift kind="button" radius={s(16)}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: s(14),
              paddingVertical: s(10),
              paddingHorizontal: s(12),
            }}>
            <StatusIcon size={s(24)} color={iconColor} strokeWidth={2} />
            {body}
          </View>
        </FocusLift>
      </Focusable>
      {onChange && canChange(row) ? (
        <Focusable
          ref={changeRef}
          testID={`review-${row.episodeNumber}-change`}
          role="button"
          accessibilityLabel={t('downloads.sheet.changeLabel', { title: label })}
          onPress={onChange}>
          <FocusLift kind="button" radius={s(16)}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: s(4),
                paddingVertical: s(10),
                paddingHorizontal: s(12),
              }}>
              <Text tone="muted" style={text(16, 22)}>
                {t('downloads.sheet.change')}
              </Text>
              <ChevronRight size={s(18)} color={colors.foreground.muted} />
            </View>
          </FocusLift>
        </Focusable>
      ) : null}
    </FocusGuide>
  );
}
