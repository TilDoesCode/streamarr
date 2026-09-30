import { Image } from 'expo-image';
import { useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { END_OF_ROW, FocusGuide, type FocusGuideProps } from '@/components/focus';
import { Artwork } from '@/components/media/artwork';
import { Scrim } from '@/components/media/scrim';
import { Text } from '@/components/ui/text';
import { useDesign } from '@/theme';

export type HeroProps = {
  title: string;
  backdropUri?: string | null;
  /** Title treatment (transparent PNG); the title text is the fallback. */
  logoUri?: string | null;
  eyebrow?: string;
  /** Short facts joined with a middle dot: year, runtime, genres. */
  meta?: readonly string[];
  /** Inline badges after the meta line (age rating, 4K, HDR). */
  badges?: ReactNode;
  overview?: string;
  /** Extra content between the overview and the actions (resume progress). */
  children?: ReactNode;
  /** Buttons; grouped as one focus row that remembers the last focused action. */
  actions?: ReactNode;
  onActionsFocusEnter?: FocusGuideProps['onFocusEnter'];
  onActionsFocusLeave?: FocusGuideProps['onFocusLeave'];
};

/** Artwork-first header for home and detail screens. */
export function Hero({
  title,
  backdropUri,
  logoUri,
  eyebrow,
  meta,
  badges,
  overview,
  children,
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
      style={{ minHeight: heroHeight, justifyContent: 'flex-end' }}>
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
          marginHorizontal: gutter,
          marginBottom: design.space['2xl'],
          paddingTop: heroHeight * 0.35,
          maxWidth: contentWidth,
          gap: design.space.sm,
        }}>
        {eyebrow ? (
          <Text variant="overline" tone="accent">
            {eyebrow}
          </Text>
        ) : null}
        <HeroTitle title={title} logoUri={logoUri} />
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
        {children}
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

/** The logo when it loads, else the title as display text (always the accessible name). */
export function HeroTitle({
  title,
  logoUri,
  logoHeight,
}: {
  title: string;
  logoUri?: string | null;
  logoHeight?: number;
}) {
  const design = useDesign();
  const [failed, setFailed] = useState<string | null>(null);
  const height = logoHeight ?? design.px(design.formFactor === 'phone' ? 72 : 96);
  if (!logoUri || failed === logoUri)
    return (
      <Text variant="display" numberOfLines={2} role="heading">
        {title}
      </Text>
    );
  return (
    <View
      role="heading"
      accessible
      accessibilityLabel={title}
      style={{ height, maxWidth: design.px(380) }}>
      <Image
        testID="hero-logo"
        source={{ uri: logoUri }}
        style={{ width: '100%', height: '100%' }}
        contentFit="contain"
        contentPosition="left"
        transition={200}
        recyclingKey={logoUri}
        onError={() => setFailed(logoUri)}
      />
    </View>
  );
}
