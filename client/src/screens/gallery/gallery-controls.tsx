import { Check, Download, Heart, Info, Play, Settings, Trash2, X } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button, type ButtonSize, type ButtonVariant } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { ProgressBar } from '@/components/ui/progress-bar';
import {
  LandscapeCardSkeleton,
  PosterCardSkeleton,
  Skeleton,
  SkeletonText,
} from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tag } from '@/components/ui/tag';
import { Text } from '@/components/ui/text';
import { MEDIA_LABELS } from '@/lib/media-labels';
import { useDesign } from '@/theme';

import { FocusStop, GalleryRow, GallerySection, Labeled } from './gallery-section';

const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'destructive'];
const SIZES: ButtonSize[] = ['sm', 'md', 'lg'];
const VARIANT_ICONS = { primary: Play, secondary: Info, ghost: Settings, destructive: Trash2 };

export function GalleryButtons({ onAction }: { onAction: (name: string) => void }) {
  const { t } = useTranslation();
  return (
    <GallerySection title={t('gallery.sections.buttons')} testID="section-buttons">
      <GalleryRow>
        {VARIANTS.map((variant) => (
          <Button
            key={variant}
            testID={`button-${variant}`}
            label={t(`gallery.variants.${variant}`)}
            icon={VARIANT_ICONS[variant]}
            variant={variant}
            onPress={() => onAction(t(`gallery.variants.${variant}`))}
          />
        ))}
      </GalleryRow>
      <GalleryRow>
        {SIZES.map((size) => (
          <Button
            key={size}
            label={t(`gallery.sizes.${size}`)}
            size={size}
            variant="secondary"
            onPress={() => onAction(t(`gallery.sizes.${size}`))}
          />
        ))}
      </GalleryRow>
      <GalleryRow align="flex-start">
        <Labeled label={t('gallery.states.default')}>
          <Button label={t('common.play')} icon={Play} onPress={() => onAction(t('common.play'))} />
        </Labeled>
        <Labeled label={t('gallery.states.focused')}>
          <Button label={t('common.resume')} variant="secondary" previewState="focused" />
        </Labeled>
        <Labeled label={t('gallery.states.pressed')}>
          <Button label={t('common.resume')} variant="secondary" previewState="pressed" />
        </Labeled>
        <Labeled label={t('gallery.states.disabled')}>
          <Button label={t('common.play')} icon={Play} disabled />
        </Labeled>
        <Labeled label={t('gallery.states.loading')}>
          <Button label={t('common.play')} variant="secondary" loading onPress={() => {}} />
        </Labeled>
      </GalleryRow>
    </GallerySection>
  );
}

export function GalleryIconButtons({ onAction }: { onAction: (name: string) => void }) {
  const { t } = useTranslation();
  return (
    <GallerySection title={t('gallery.sections.iconButtons')}>
      <GalleryRow align="flex-start">
        <Labeled label={t('gallery.variants.secondary')}>
          <IconButton
            icon={Heart}
            accessibilityLabel={t('gallery.variants.secondary')}
            onPress={() => onAction(t('gallery.variants.secondary'))}
          />
        </Labeled>
        <Labeled label={t('gallery.variants.primary')}>
          <IconButton
            icon={Play}
            variant="primary"
            accessibilityLabel={t('common.play')}
            onPress={() => onAction(t('common.play'))}
          />
        </Labeled>
        <Labeled label={t('gallery.variants.ghost')}>
          <IconButton
            icon={X}
            variant="ghost"
            accessibilityLabel={t('common.close')}
            onPress={() => onAction(t('common.close'))}
          />
        </Labeled>
        <Labeled label={t('gallery.states.focused')}>
          <IconButton
            icon={Download}
            accessibilityLabel={t('gallery.states.focused')}
            previewState="focused"
          />
        </Labeled>
        <Labeled label={t('gallery.states.pressed')}>
          <IconButton
            icon={Download}
            accessibilityLabel={t('gallery.states.pressed')}
            previewState="pressed"
          />
        </Labeled>
        <Labeled label={t('gallery.states.disabled')}>
          <IconButton icon={Check} accessibilityLabel={t('gallery.states.disabled')} disabled />
        </Labeled>
        {SIZES.map((size) => (
          <Labeled key={size} label={t(`gallery.sizes.${size}`)}>
            <IconButton
              icon={Settings}
              size={size}
              accessibilityLabel={t('common.settings')}
              onPress={() => onAction(t('common.settings'))}
            />
          </Labeled>
        ))}
      </GalleryRow>
    </GallerySection>
  );
}

const BADGES: {
  variant: BadgeVariant;
  label: (t: ReturnType<typeof useTranslation>['t']) => string;
}[] = [
  { variant: 'solid', label: () => MEDIA_LABELS.uhd },
  { variant: 'neutral', label: () => MEDIA_LABELS.dolbyVision },
  { variant: 'outline', label: () => '16' },
  { variant: 'accent', label: (t) => t('media.recommended') },
  { variant: 'success', label: (t) => t('media.ready') },
  { variant: 'warning', label: (t) => t('media.new') },
  { variant: 'danger', label: (t) => t('media.unavailable') },
  { variant: 'info', label: () => MEDIA_LABELS.atmos },
];

export function GalleryBadges() {
  const { t } = useTranslation();
  const design = useDesign();
  const [filter, setFilter] = useState<'all' | 'movies' | 'series'>('all');
  return (
    <GallerySection title={t('gallery.sections.badges')}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: design.space.sm }}>
        {BADGES.map((badge) => (
          <Badge key={badge.variant} label={badge.label(t)} variant={badge.variant} />
        ))}
      </View>
      <GalleryRow>
        {(['all', 'movies', 'series'] as const).map((value) => (
          <Tag
            key={value}
            testID={`tag-${value}`}
            label={t(`gallery.tags.${value}`)}
            selected={filter === value}
            onPress={() => setFilter(value)}
          />
        ))}
        <Tag label={t('gallery.states.disabled')} disabled />
        <Tag label={t('gallery.states.focused')} previewState="focused" />
      </GalleryRow>
    </GallerySection>
  );
}

export function GalleryProgress() {
  const { t } = useTranslation();
  const design = useDesign();
  return (
    <GallerySection title={t('gallery.sections.progress')} testID="section-progress">
      <FocusStop>
        <View style={{ gap: design.space.xl, padding: design.space.sm }}>
          <View style={{ gap: design.space.lg, width: design.px(420) }}>
            <ProgressBar value={0.12} />
            <ProgressBar value={0.5} />
            <ProgressBar value={0.9} size="md" />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: design.space['2xl'] }}>
            <Spinner size="sm" />
            <Spinner size="md" />
            <Spinner size="lg" />
          </View>
        </View>
      </FocusStop>
    </GallerySection>
  );
}

export function GalleryLoading({
  animated,
  onToggleAnimated,
}: {
  animated: boolean;
  onToggleAnimated: () => void;
}) {
  const { t } = useTranslation();
  const design = useDesign();
  return (
    <GallerySection title={t('gallery.sections.loading')} testID="section-loading">
      <GalleryRow>
        <Tag
          testID="toggle-loader-motion"
          label={t('gallery.animateLoaders')}
          selected={animated}
          onPress={onToggleAnimated}
        />
      </GalleryRow>
      <View style={{ flexDirection: 'row', gap: design.layout.cardGap, overflow: 'hidden' }}>
        {Array.from({ length: 6 }, (_, index) => (
          <PosterCardSkeleton key={index} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: design.layout.cardGap, overflow: 'hidden' }}>
        <LandscapeCardSkeleton />
        <LandscapeCardSkeleton />
        <View style={{ flex: 1, gap: design.space.sm, minWidth: design.px(160) }}>
          <SkeletonText variant="heading" width="50%" />
          <SkeletonText width="90%" />
          <SkeletonText width="75%" />
          <Skeleton width={design.px(120)} height={design.layout.controlHeight.md} />
        </View>
      </View>
      <Text variant="caption" tone="subtle">
        {t('common.loading')}
      </Text>
    </GallerySection>
  );
}
