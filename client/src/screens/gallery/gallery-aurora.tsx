import { Image } from 'expo-image';
import { Info, Play } from '@/components/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { useSetAmbient } from '@/components/ambient';
import { Focusable, FocusLift } from '@/components/focus';
import { Glass, GlassButton, GlassChip, selectGlassMode } from '@/components/glass';
import {
  methodTone,
  SignalBars,
  SpecLabel,
  SpecLabels,
  versionSignal,
  type SignalLevel,
  type SpecTone,
} from '@/components/spec';
import { Text } from '@/components/ui/text';
import { aspect, useDesign } from '@/theme';

import { AURORA_SAMPLES, GALLERY_TITLES, type GalleryTitle } from './gallery-data';
import { FocusStop, GalleryRow, GallerySection, Labeled } from './gallery-section';

const TITLES = GALLERY_TITLES.filter((title) => title.key in AURORA_SAMPLES);
const METHODS = ['direct', 'remux', 'transcode', 'unknown'] as const;
const SIGNALS: {
  health?: string;
  local?: string;
  key: 'local-ready' | 'local-downloading' | 'ready' | 'degraded';
}[] = [
  { key: 'local-ready', local: 'ready' },
  { key: 'local-downloading', local: 'downloading' },
  { key: 'ready', health: 'ready' },
  { key: 'degraded', health: 'degraded' },
];

/** Aurora primitives: ambient backdrop, focus/hover/press, glass, spec labels, signal bars. */
export function GalleryAurora({ onAction }: { onAction: (action: string) => void }) {
  const { t } = useTranslation();
  const design = useDesign();
  const setAmbient = useSetAmbient();
  const [tinted, setTinted] = useState(true);
  const [chip, setChip] = useState<'all' | 'movies' | 'series'>('all');
  const posterWidth = design.layout.posterWidth;
  const mode = selectGlassMode({
    os: Platform.OS,
    isTV: Platform.isTV === true,
    liquidGlass: false,
    reduceTransparency: false,
  });

  const paint = (title: GalleryTitle) => {
    const sample = AURORA_SAMPLES[title.key];
    setAmbient({
      image: title.backdrop,
      tint: tinted ? sample?.tint : null,
      tint2: tinted ? sample?.tint2 : null,
    });
  };

  return (
    <>
      <GallerySection title={t('gallery.sections.ambient')} testID="gallery-aurora-ambient">
        <Text variant="caption" tone="muted">
          {t('gallery.aurora.ambientHint')}
        </Text>
        <GalleryRow align="flex-start">
          {TITLES.map((title, index) => {
            const sample = AURORA_SAMPLES[title.key];
            return (
              <View key={title.key} style={{ width: posterWidth, gap: design.space.sm }}>
                <Focusable
                  testID={`aurora-card-${title.key}`}
                  accessibilityLabel={title.title}
                  hasTVPreferredFocus={false}
                  previewState={undefined}
                  onFocus={() => paint(title)}
                  onHoverIn={() => paint(title)}
                  onPress={() => {
                    paint(title);
                    onAction(title.title);
                  }}>
                  <FocusLift
                    kind="card"
                    radius={design.radius.lg}
                    tint={tinted ? sample?.tint : null}
                    style={{ zIndex: index }}>
                    <Image
                      source={{ uri: title.poster ?? undefined }}
                      style={{
                        width: posterWidth,
                        aspectRatio: aspect.poster,
                        borderRadius: design.radius.lg,
                      }}
                      contentFit="cover"
                      accessible={false}
                    />
                  </FocusLift>
                </Focusable>
                <SpecLabels spec={sample?.spec} testID={`aurora-spec-${title.key}`} />
              </View>
            );
          })}
        </GalleryRow>
        <GalleryRow>
          <GlassChip
            testID="aurora-toggle-tints"
            label={tinted ? t('gallery.aurora.tintsOn') : t('gallery.aurora.tintsOff')}
            selected={tinted}
            onPress={() => setTinted((value) => !value)}
          />
          <GlassChip
            testID="aurora-clear-ambient"
            label={t('gallery.aurora.clear')}
            onPress={() => setAmbient(null)}
          />
        </GalleryRow>
      </GallerySection>

      <GallerySection title={t('gallery.sections.glass')} testID="gallery-aurora-glass">
        <Text variant="caption" tone="muted" testID="aurora-glass-mode">
          {t('gallery.aurora.glassMode', { mode })}
        </Text>
        <FocusStop testID="aurora-glass-panels">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: design.space.lg }}>
            {(['subtle', 'regular', 'strong'] as const).map((intensity) => (
              <Glass
                key={intensity}
                intensity={intensity}
                style={{
                  width: posterWidth * 1.6,
                  padding: design.space.lg,
                  gap: design.space.xs,
                }}>
                <Text variant="label">{t(`gallery.aurora.intensity.${intensity}`)}</Text>
                <Text variant="caption" tone="muted">
                  {t('gallery.aurora.glassBody')}
                </Text>
              </Glass>
            ))}
            <Glass
              tint={AURORA_SAMPLES['sprite-fright']?.tint}
              style={{ width: posterWidth * 1.6, padding: design.space.lg, gap: design.space.xs }}>
              <Text variant="label">{t('gallery.aurora.intensity.tinted')}</Text>
              <Text variant="caption" tone="muted">
                {t('gallery.aurora.glassBody')}
              </Text>
            </Glass>
          </View>
        </FocusStop>
        <GalleryRow>
          <GlassButton
            testID="aurora-play"
            tone="solid"
            icon={Play}
            label={t('gallery.aurora.play')}
            onPress={() => onAction(t('gallery.aurora.play'))}
          />
          <GlassButton
            testID="aurora-more"
            icon={Info}
            label={t('gallery.aurora.moreInfo')}
            onPress={() => onAction(t('gallery.aurora.moreInfo'))}
          />
          {(['all', 'movies', 'series'] as const).map((key) => (
            <GlassChip
              key={key}
              testID={`aurora-chip-${key}`}
              label={t(`gallery.tags.${key}`)}
              selected={chip === key}
              onPress={() => setChip(key)}
            />
          ))}
        </GalleryRow>
        <GalleryRow>
          <Labeled label={t('gallery.states.focused')}>
            <Focusable previewState="focused" accessibilityLabel={t('gallery.states.focused')}>
              <FocusLift
                kind="button"
                radius={design.radius.full}
                tint={AURORA_SAMPLES['cosmos-laundromat']?.tint}>
                <Glass
                  interactive
                  radius={design.layout.controlHeight.md / 2}
                  style={{
                    height: design.layout.controlHeight.md,
                    paddingHorizontal: design.space.lg,
                    justifyContent: 'center',
                  }}>
                  <Text variant="label">{t('gallery.aurora.moreInfo')}</Text>
                </Glass>
              </FocusLift>
            </Focusable>
          </Labeled>
          <Labeled label={t('gallery.states.pressed')}>
            <Focusable previewState="pressed" accessibilityLabel={t('gallery.states.pressed')}>
              <FocusLift kind="button" radius={design.radius.full}>
                <Glass
                  interactive
                  radius={design.layout.controlHeight.md / 2}
                  style={{
                    height: design.layout.controlHeight.md,
                    paddingHorizontal: design.space.lg,
                    justifyContent: 'center',
                  }}>
                  <Text variant="label">{t('gallery.aurora.moreInfo')}</Text>
                </Glass>
              </FocusLift>
            </Focusable>
          </Labeled>
        </GalleryRow>
      </GallerySection>

      <GallerySection title={t('gallery.sections.spec')} testID="gallery-aurora-spec">
        <FocusStop testID="aurora-spec-rows">
          <View style={{ gap: design.space.lg }}>
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: design.space.lg,
              }}>
              <SpecLabels spec={AURORA_SAMPLES['cosmos-laundromat']?.spec} />
              {METHODS.map((method) => (
                <SpecLabel
                  key={method}
                  testID={`aurora-method-${method}`}
                  label={t(`versions.method.${method}`)}
                  tone={methodTone(method)}
                />
              ))}
              <SpecLabel label={t('versions.health.degraded')} tone="bad" />
            </View>
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: design.space.lg,
              }}>
              {SIGNALS.map((input) => {
                const signal = versionSignal(input);
                return (
                  <Labeled key={input.key} label={t(`gallery.aurora.signal.${input.key}`)}>
                    <SignalBars
                      testID={`aurora-signal-${input.key}`}
                      level={signal?.level ?? 0}
                      tone={signal?.tone}
                      size={18}
                    />
                  </Labeled>
                );
              })}
              {([0, 1, 3] as SignalLevel[]).map((level) => (
                <Labeled key={level} label={String(level)}>
                  <SignalBars
                    level={level}
                    tone={(level === 1 ? 'bad' : 'neutral') as SpecTone}
                    size={18}
                  />
                </Labeled>
              ))}
            </View>
          </View>
        </FocusStop>
      </GallerySection>
    </>
  );
}
