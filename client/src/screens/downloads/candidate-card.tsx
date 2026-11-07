import { useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { useAudioLanguages } from '@/browse/queries';
import {
  reasonTexts,
  versionDetails,
  versionFormats,
  versionHeadline,
  versionLanguages,
} from '@/browse/version-format';
import { CardSurface, LanguagePill, Pill } from '@/browse/version-panel';
import { Focusable, FocusLift, useInitialFocus } from '@/components/focus';
import { CircleCheck, Circle, HardDrive } from '@/components/icons';
import { SPEC_TONES } from '@/components/spec';
import { Text } from '@/components/ui/text';
import type { DownloadCandidate, SpaceVerdict } from '@/downloads';
import { MIN_TEXT } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { colors, fonts } from '@/theme';

import { candidateNotes } from './download-model';
import { useSizeText } from './download-text';

/** The engine that plays the file as it is: the built-in player ("Direct") or VLC. */
export function EngineChip({
  engine,
  testID,
}: {
  engine: string | null | undefined;
  testID?: string;
}) {
  const { t } = useTranslation();
  const { s, font } = useShell();
  const vlc = engine === 'vlc';
  const tone = SPEC_TONES[vlc ? 'info' : 'ok'];
  return (
    <View
      testID={testID}
      style={{
        borderRadius: s(8),
        paddingHorizontal: s(10),
        paddingVertical: s(1),
        backgroundColor: tone.bg,
      }}>
      <Text
        style={{
          fontFamily: fonts.bodySemiBold,
          fontSize: font(16, MIN_TEXT.spec),
          lineHeight: font(22, 16),
          color: tone.fg,
        }}>
        {t(vlc ? 'downloads.sheet.engine.vlc' : 'downloads.sheet.engine.native')}
      </Text>
    </View>
  );
}

/** "Fits · 5.4 GB left" in green, "Doesn't fit · 2.1 GB short" in red (nothing before the free space is known). */
export function SpaceLine({
  space,
  testID,
}: {
  space: SpaceVerdict | null | undefined;
  testID?: string;
}) {
  const { t } = useTranslation();
  const size = useSizeText();
  const { font } = useShell();
  if (!space || space.availableBytes >= Number.MAX_SAFE_INTEGER) return null;
  const text = space.unknown
    ? t('downloads.sheet.spaceUnknown')
    : space.fits
      ? t('downloads.sheet.fits', { left: size(space.availableBytes - space.neededBytes) })
      : t('downloads.sheet.missing', { missing: size(space.missingBytes) });
  return (
    <Text
      testID={testID}
      numberOfLines={1}
      style={{
        flexShrink: 1,
        fontFamily: fonts.bodySemiBold,
        fontSize: font(16, MIN_TEXT.subline),
        lineHeight: font(22, MIN_TEXT.subline + 5),
        color: space.fits || space.unknown ? colors.foreground.muted : SPEC_TONES.bad.fg,
      }}>
      {text}
    </Text>
  );
}

/** One downloadable version (download sheet, pack list, an episode's "change" list): select it, then confirm. */
export function CandidateCard({
  candidate,
  selected,
  onPress,
  testID,
  preferred = false,
  space,
  extra,
  onDevice = false,
}: {
  candidate: DownloadCandidate;
  selected: boolean;
  onPress: () => void;
  testID: string;
  /** TV: takes the first focus when the step appears. */
  preferred?: boolean;
  /** Its verdict against the free space; a version that does not fit stays listed but cannot be picked. */
  space?: SpaceVerdict | null;
  /** A line under the facts (a pack's "10/10 episodes"). */
  extra?: ReactNode;
  /** The profile already has this version on the device. */
  onDevice?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { s, font } = useShell();
  const size = useSizeText();
  const ref = useRef<View>(null);
  useInitialFocus(ref, preferred);
  const version = candidate.version;
  const audioLanguage = useAudioLanguages().split(',')[0];
  const headline = versionHeadline(version) || version.name || '';
  const languages = versionLanguages(version, t, i18n.language);
  const ownLanguage = !!version.languages?.some((code) => code.toLowerCase() === audioLanguage);
  const group = version.releaseGroup;
  const formats = [
    ...versionFormats(version, t),
    ...versionDetails(version, t, i18n.language, { audio: false }).filter((part) => part !== group),
  ];
  const sizeText = size(candidate.sizeBytes, !candidate.sizeExact);
  const note =
    reasonTexts(candidateNotes(candidate), t)[0] ??
    (candidate.offline.engine === 'vlc' ? t('downloads.sheet.engine.vlcPlays') : undefined);
  const blocked = space ? !space.fits : false;
  const text = (value: number, line = value * 1.35) => ({
    fontSize: font(value, MIN_TEXT.subline),
    lineHeight: font(line, MIN_TEXT.subline * (line / value)),
  });
  const radius = s(22);
  const Mark = selected ? CircleCheck : Circle;
  return (
    <Focusable
      ref={ref}
      testID={testID}
      role="radio"
      aria-checked={selected}
      aria-disabled={blocked}
      // TV keeps a blocked card focusable so the D-pad can reach (and read) it.
      disabled={blocked && !Platform.isTV}
      hasTVPreferredFocus={preferred}
      accessibilityLabel={[
        headline,
        t('versions.audioLanguages', { languages: languages ?? t('versions.languageUnknown') }),
        formats.join(' · '),
        sizeText,
        candidate.recommended ? t('media.recommended') : null,
        onDevice ? t('downloads.detail.onDevice') : null,
        t(
          candidate.offline.engine === 'vlc'
            ? 'downloads.sheet.engine.vlc'
            : 'downloads.sheet.engine.native'
        ),
        note,
        blocked && space
          ? t('downloads.sheet.missing', { missing: size(space.missingBytes) })
          : null,
      ]
        .filter(Boolean)
        .join('. ')}
      onPress={() => !blocked && onPress()}>
      <FocusLift kind="none" radius={radius}>
        <View style={{ opacity: blocked ? 0.55 : 1 }}>
          <CardSurface radius={radius}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(10) }}>
              <Mark
                size={s(22)}
                color={selected ? colors.accent.DEFAULT : colors.foreground.subtle}
                strokeWidth={2}
              />
              <Text
                numberOfLines={1}
                style={{
                  flex: 1,
                  fontFamily: fonts.displayBold,
                  fontSize: font(23, MIN_TEXT.caption),
                  lineHeight: font(30, 20),
                  color: colors.foreground.DEFAULT,
                }}>
                {headline}
              </Text>
              {onDevice ? (
                <Pill
                  testID={`${testID}-on-device`}
                  label={t('downloads.detail.onDevice')}
                  tone="local"
                />
              ) : null}
              {candidate.recommended ? (
                <Pill label={t('media.recommended')} tone="recommended" />
              ) : null}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(12) }}>
              <LanguagePill
                label={languages ?? t('versions.languageUnknown')}
                tone={ownLanguage ? 'own' : languages ? 'other' : 'unknown'}
              />
              {formats.length ? (
                <Text tone="muted" numberOfLines={1} style={[text(18), { flex: 1 }]}>
                  {formats.join(' · ')}
                </Text>
              ) : null}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(12) }}>
              <EngineChip testID={`${testID}-engine`} engine={candidate.offline.engine} />
              <HardDrive size={s(16)} color={colors.foreground.muted} />
              <Text
                testID={`${testID}-size`}
                numberOfLines={1}
                style={[text(18, 24), { fontFamily: fonts.bodySemiBold }]}>
                {sizeText}
              </Text>
              <SpaceLine testID={`${testID}-space`} space={space} />
            </View>
            {note ? (
              <Text testID={`${testID}-note`} tone="muted" numberOfLines={1} style={text(16, 22)}>
                {note}
              </Text>
            ) : null}
            {extra}
            {version.name ? (
              <Text
                tone={Platform.isTV ? 'muted' : 'subtle'}
                numberOfLines={1}
                style={{
                  fontFamily: fonts.mono,
                  fontSize: font(13, MIN_TEXT.spec),
                  lineHeight: font(18, 15),
                }}>
                {version.name}
              </Text>
            ) : null}
          </CardSurface>
        </View>
      </FocusLift>
    </Focusable>
  );
}
