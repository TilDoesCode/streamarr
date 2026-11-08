import { View } from 'react-native';

import { FocusGuide } from '@/components/focus';
import { Glass, GlassButton } from '@/components/glass';
import { Text } from '@/components/ui/text';
import type { PlaybackOffer } from '@/player/controller-types';
import { usePlayerT } from '@/player/use-player-t';
import { useShell } from '@/shell/use-shell';
import { colors, useDesign, useFocusGap } from '@/theme';

type Props = {
  offer: PlaybackOffer;
  onAccept: () => void;
  onDecline: () => void;
};

/** A choice over the playing picture (it never pauses): the primary button takes the remote's focus. */
export function PlayerOfferCard({ offer, onAccept, onDecline }: Props) {
  const pt = usePlayerT();
  const design = useDesign();
  const { large, s } = useShell();
  const buttonGap = useFocusGap(large ? s(14) : design.space.sm);
  const radius = large ? s(36) : design.radius.lg;
  return (
    <Glass
      key={offer.id}
      testID={`player-offer-${offer.kind}`}
      intensity="strong"
      radius={radius}
      style={{
        position: 'absolute',
        right: large ? s(64) : design.layout.gutter,
        bottom: large ? s(280) : design.layout.edgeVertical + design.px(110),
        width: large ? s(620) : design.px(360),
        padding: large ? s(32) : design.space.lg,
        gap: large ? s(16) : design.space.md,
      }}>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: radius,
          backgroundColor: colors.glass.tinted,
          opacity: 0.7,
        }}
      />
      <Text variant="callout">{pt(`offer.${offer.kind}.text`)}</Text>
      <FocusGuide trap={['left', 'right', 'down']} style={{ flexDirection: 'row', gap: buttonGap }}>
        <GlassButton
          testID="player-offer-accept"
          tone="solid"
          label={pt(`offer.${offer.kind}.accept`)}
          hasTVPreferredFocus
          onPress={onAccept}
        />
        <GlassButton
          testID="player-offer-decline"
          label={pt(`offer.${offer.kind}.decline`)}
          onPress={onDecline}
        />
      </FocusGuide>
    </Glass>
  );
}
