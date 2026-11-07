import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { versionHeadline } from '@/browse/version-format';
import { Focusable, FocusLift, useInitialFocus } from '@/components/focus';
import { ChevronRight, CircleCheck, CircleX } from '@/components/icons';
import { SPEC_TONES } from '@/components/spec';
import { Text } from '@/components/ui/text';
import type { CandidateWithSpace } from '@/downloads';
import { META_SEPARATOR } from '@/lib/media-labels';
import { MIN_TEXT } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { colors, fonts } from '@/theme';

import { defaultCandidate } from './download-model';
import { useSizeText } from './download-text';

/** One episode in "Similar to which episode?": its best fitting version, or why it cannot be the reference. */
export function AnchorEpisodeRow({
  episode,
  seasonNumber,
  held,
  current,
  preferred,
  onPress,
}: {
  episode: {
    workId: string | null;
    episodeNumber: number;
    title?: string | null;
    candidates: readonly CandidateWithSpace[];
  };
  seasonNumber: number;
  /** Already on the device or downloading. */
  held: boolean;
  current: boolean;
  preferred: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const { s, font } = useShell();
  const size = useSizeText();
  const ref = useRef<View>(null);
  useInitialFocus(ref, preferred && !held);
  const best = defaultCandidate(episode.candidates);
  const code = t('media.episodeCode', { season: seasonNumber, episode: episode.episodeNumber });
  const title = episode.title ?? t('media.episodeNumber', { episode: episode.episodeNumber });
  const detail = held
    ? t('downloads.sheet.row.inProgress')
    : best
      ? [size(best.sizeBytes, !best.sizeExact), versionHeadline(best.version) || best.version.name]
          .filter(Boolean)
          .join(META_SEPARATOR)
      : t('downloads.sheet.noneFits');
  const text = (value: number, line: number) => ({
    fontSize: font(value, MIN_TEXT.subline),
    lineHeight: font(line, MIN_TEXT.subline * (line / value)),
  });
  const Icon = current ? CircleCheck : best ? ChevronRight : CircleX;
  return (
    <Focusable
      ref={ref}
      testID={`download-anchor-episode-${episode.episodeNumber}`}
      role="button"
      aria-selected={current}
      aria-disabled={held}
      // TV: an episode that becomes held keeps the focus instead of passing it on.
      disabled={held && !Platform.isTV}
      accessibilityLabel={`${code}${META_SEPARATOR}${title}. ${detail}`}
      onPress={held ? undefined : onPress}>
      <FocusLift kind="button" radius={s(16)} style={{ opacity: held ? 0.5 : 1 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: s(14),
            paddingVertical: s(10),
            paddingHorizontal: s(12),
          }}>
          <View style={{ flex: 1, gap: s(2) }}>
            <Text
              numberOfLines={1}
              style={[
                text(19, 26),
                { fontFamily: fonts.bodySemiBold },
              ]}>{`${code}${META_SEPARATOR}${title}`}</Text>
            <Text
              testID={`download-anchor-episode-${episode.episodeNumber}-detail`}
              numberOfLines={1}
              style={[
                text(16, 22),
                { color: best || held ? colors.foreground.muted : SPEC_TONES.bad.fg },
              ]}>
              {detail}
            </Text>
          </View>
          <Icon
            size={s(22)}
            color={current ? colors.accent.DEFAULT : colors.foreground.muted}
            strokeWidth={2}
          />
        </View>
      </FocusLift>
    </Focusable>
  );
}
