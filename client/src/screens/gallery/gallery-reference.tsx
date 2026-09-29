import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Tag } from '@/components/ui/tag';
import { Text } from '@/components/ui/text';
import {
  LANGUAGE_PREFERENCES,
  setLanguagePreference,
  useLanguagePreference,
  type LanguagePreference,
} from '@/i18n';
import { useFormat } from '@/i18n/format';
import { colors, useDesign, type TypeVariant } from '@/theme';

import { FocusStop, GalleryRow, GallerySection } from './gallery-section';

const DAY_MS = 24 * 60 * 60 * 1000;
const TYPE_VARIANTS: TypeVariant[] = [
  'display',
  'title',
  'heading',
  'subheading',
  'body',
  'callout',
  'caption',
  'overline',
  'label',
];

function flattenColors(value: unknown, prefix = ''): { name: string; color: string }[] {
  if (typeof value === 'string') return [{ name: prefix, color: value }];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flattenColors(child, key === 'DEFAULT' ? prefix : prefix ? `${prefix}-${key}` : key)
  );
}
const SWATCHES = flattenColors(colors);

export function GalleryLanguage() {
  const { t, i18n } = useTranslation();
  const preference = useLanguagePreference();
  const label = (value: LanguagePreference) => t(`language.${value}`);
  return (
    <GallerySection title={t('gallery.sections.language')} testID="section-language">
      <GalleryRow>
        {LANGUAGE_PREFERENCES.map((value) => (
          <Tag
            key={value}
            testID={`language-${value}`}
            label={label(value)}
            selected={preference === value}
            onPress={() => void setLanguagePreference(value)}
          />
        ))}
      </GalleryRow>
      <Text testID="language-current" variant="callout" tone="muted">
        {t('language.current', { language: label(i18n.language === 'de' ? 'de' : 'en') })}
      </Text>
    </GallerySection>
  );
}

export function GalleryFormatting() {
  const { t } = useTranslation();
  const format = useFormat();
  const design = useDesign();
  const now = new Date();
  const lines = [
    t('gallery.formatting.date', {
      value: `${format.date('2010-07-25', 'short')} · ${format.date('2010-07-25', 'medium')} · ${format.date('2010-07-25', 'long')}`,
    }),
    t('gallery.formatting.duration', {
      value: `${format.duration(35)} · ${format.duration(42 * 60)} · ${format.duration(90 * 60)} · ${format.duration(102 * 60)}`,
    }),
    t('gallery.formatting.remaining', { value: format.remaining(37 * 60) }),
    t('gallery.formatting.relative', {
      value: [0, 1, 3, 12]
        .map((days) => format.relativeDay(new Date(now.getTime() - days * DAY_MS), now))
        .join(' · '),
    }),
    t('gallery.formatting.size', {
      value: `${format.fileSize(4_237_000_000)} · ${format.fileSize(734_000_000)}`,
    }),
    t('gallery.formatting.plural', {
      value: [
        t('media.episodes', { count: 1 }),
        t('media.episodes', { count: 12 }),
        t('media.seasons', { count: 2 }),
        t('media.versions', { count: 0 }),
      ].join(' · '),
    }),
  ];
  return (
    <GallerySection title={t('gallery.sections.formatting')} testID="section-formatting">
      <FocusStop>
        <View style={{ gap: design.space.xs, padding: design.space.sm }}>
          {lines.map((line) => (
            <Text key={line} variant="callout" tone="muted" selectable>
              {line}
            </Text>
          ))}
        </View>
      </FocusStop>
    </GallerySection>
  );
}

export function GalleryColors() {
  const { t } = useTranslation();
  const design = useDesign();
  const size = design.px(44);
  return (
    <GallerySection title={t('gallery.sections.colors')} testID="section-colors">
      <GalleryRow align="flex-start">
        {SWATCHES.map((swatch) => (
          <FocusStop key={swatch.name} testID={`swatch-${swatch.name}`}>
            <View style={{ width: design.px(124), gap: design.space.xs, padding: design.space.xs }}>
              <View
                style={{
                  width: size,
                  height: size,
                  borderRadius: design.radius.md,
                  backgroundColor: swatch.color,
                  borderWidth: 1,
                  borderColor: colors.border,
                }}
              />
              <Text variant="caption" numberOfLines={1}>
                {swatch.name}
              </Text>
            </View>
          </FocusStop>
        ))}
      </GalleryRow>
    </GallerySection>
  );
}

export function GalleryTypography() {
  const { t } = useTranslation();
  const design = useDesign();
  return (
    <GallerySection title={t('gallery.sections.typography')}>
      <GalleryRow align="flex-start">
        {TYPE_VARIANTS.map((variant) => (
          <FocusStop key={variant}>
            <View style={{ padding: design.space.xs, gap: design.px(2) }}>
              <Text variant="caption" tone="subtle">
                {`${variant} · ${design.type[variant].fontSize}/${design.type[variant].lineHeight}`}
              </Text>
              <Text variant={variant} numberOfLines={1}>
                {t('gallery.type.sample')}
              </Text>
            </View>
          </FocusStop>
        ))}
      </GalleryRow>
    </GallerySection>
  );
}
