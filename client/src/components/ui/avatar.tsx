import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { colors, fonts, useDesign } from '@/theme';

const PALETTE = Object.values(colors.avatar);

/** Up to two initials: first letters of the first two words, else the first two letters. */
export function initials(name: string): string {
  const words = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters =
    words.length > 1 ? [words[0]![0], words[1]![0]] : Array.from(words[0] ?? '?').slice(0, 2);
  return letters.join('').toLocaleUpperCase();
}

export function avatarColor(slot: number): string {
  return PALETTE[Math.abs(Math.trunc(slot)) % PALETTE.length] ?? colors.surface.overlay;
}

export type AvatarProps = {
  name: string;
  /** Colour slot (Account.color). */
  color: number;
  size: number;
  dimmed?: boolean;
};

export function Avatar({ name, color, size, dimmed = false }: AvatarProps) {
  const design = useDesign();
  return (
    <View
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: design.radius.lg * (size / design.px(64)),
        borderCurve: 'continuous',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: avatarColor(color),
        opacity: dimmed ? 0.45 : 1,
      }}>
      <Text
        style={{
          fontSize: size * 0.4,
          lineHeight: size * 0.48,
          fontFamily: fonts.displayBold,
          color: colors.foreground.DEFAULT,
        }}>
        {initials(name)}
      </Text>
    </View>
  );
}
