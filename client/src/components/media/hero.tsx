import type { ReactNode } from 'react';
import { View } from 'react-native';

import { END_OF_ROW, FocusGuide, type FocusGuideProps } from '@/components/focus';
import { Artwork } from '@/components/media/artwork';
import { Scrim } from '@/components/media/scrim';
import { Text } from '@/components/ui/text';
import { useDesign } from '@/theme';

export type HeroProps = {
  title: string;
  backdropUri?: string | null;
  eyebrow?: string;
  /** Short facts joined with a middle dot: year, runtime, genres. */
  meta?: readonly string[];
  /** Inline badges after the meta line (age rating, 4K, HDR). */
  badges?: ReactNode;
  overview?: string;
  /** Buttons; grouped as one focus row that remembers the last focused action. */
  actions?: ReactNode;
  onActionsFocusEnter?: FocusGuideProps['onFocusEnter'];
  onActionsFocusLeave?: FocusGuideProps['onFocusLeave'];
};

/** Artwork-first header for home and detail screens. */
export function Hero({
  title,
  backdropUri,
  eyebrow,
  meta,
  badges,
  overview,
  actions,
  onActionsFocusEnter,
  onActionsFocusLeave,
}: HeroProps) {
  const design = useDesign();
  const { gutter, heroHeight } = design.layout;
  const wide = design.formFactor !== 'phone';
  const contentWidth = wide ? Math.min(design.window.width * 0.52, design.px(560)) : undefined;
  return (
    <View
      collapsable={false}
      scrollSnapAlign={design.isTV ? 'start' : undefined}
      style={{ height: heroHeight }}>
      <Artwork uri={backdropUri} title={title} />
      <Scrim
        direction="down"
        style={{ position: 'absolute', left: 0, right: 0, top: 0, height: '22%' }}
      />
      <Scrim
        direction="up"
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '75%' }}
      />
      {wide ? (
        <Scrim
          direction="right"
          style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '70%' }}
        />
      ) : null}
      <View
        style={{
          position: 'absolute',
          left: gutter,
          right: gutter,
          bottom: design.space['2xl'],
          maxWidth: contentWidth,
          gap: design.space.sm,
        }}>
        {eyebrow ? (
          <Text variant="overline" tone="accent">
            {eyebrow}
          </Text>
        ) : null}
        <Text variant="display" numberOfLines={2}>
          {title}
        </Text>
        {meta?.length || badges ? (
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: design.space.sm,
            }}>
            {meta?.length ? (
              <Text variant="callout" tone="muted">
                {meta.join(' · ')}
              </Text>
            ) : null}
            {badges}
          </View>
        ) : null}
        {overview ? (
          <Text variant="body" tone="muted" numberOfLines={3}>
            {overview}
          </Text>
        ) : null}
        {actions ? (
          <FocusGuide
            remember
            trap={END_OF_ROW}
            onFocusEnter={onActionsFocusEnter}
            onFocusLeave={onActionsFocusLeave}
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              gap: design.space.md,
              marginTop: design.space.sm,
            }}>
            {actions}
          </FocusGuide>
        ) : null}
      </View>
    </View>
  );
}
