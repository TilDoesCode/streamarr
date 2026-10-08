import { View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';

import { Text } from '@/components/ui/text';
import { mixHex, withAlpha } from '@/lib/color';
import { MIN_TEXT, SHELL } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { colors, theme, useDesign } from '@/theme';

import { specChips, type CatalogSpec, type SpecTone } from './spec-model';

// Chip fills are near-opaque smoke mixed with the tone, so chip text keeps 4.5:1 over any art or glass.
const chipFill = (tone: string, weight: number) =>
  withAlpha(mixHex(tone, colors.background, weight), 0.9);

export const SPEC_TONES: Record<SpecTone, { fg: string; bg: string; border: string }> = {
  neutral: {
    fg: colors.foreground.DEFAULT,
    bg:
      theme === 'streamybox' ? colors.secondary.DEFAULT : chipFill(colors.foreground.DEFAULT, 0.1),
    border: colors.glass.border,
  },
  ok: {
    fg: colors.success.DEFAULT,
    bg: chipFill(colors.success.DEFAULT, 0.16),
    border: colors.success.muted,
  },
  info: {
    fg: colors.info.DEFAULT,
    bg: chipFill(colors.info.DEFAULT, 0.16),
    border: colors.info.muted,
  },
  warn: {
    fg: colors.warning.DEFAULT,
    bg: chipFill(colors.warning.DEFAULT, 0.16),
    border: colors.warning.muted,
  },
  bad: {
    fg: colors.danger.DEFAULT,
    bg: chipFill(colors.danger.DEFAULT, 0.16),
    border: colors.danger.muted,
  },
};

export type SpecLabelProps = {
  label: string;
  tone?: SpecTone;
  testID?: string;
};

/** Signal-style spec chip: JetBrains Mono caps (resolution, HDR, codec, audio, playback method). */
export function SpecLabel({ label, tone = 'neutral', testID }: SpecLabelProps) {
  const design = useDesign();
  const { large, s, font } = useShell();
  const palette = SPEC_TONES[tone];
  return (
    <View
      testID={testID}
      style={{
        paddingHorizontal: large ? s(9) : design.px(7),
        paddingVertical: large ? s(3) : design.px(3),
        borderRadius: design.radius.sm,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.bg,
      }}>
      <Text
        variant="spec"
        numberOfLines={1}
        style={[
          { color: palette.fg },
          large && {
            fontSize: font(SHELL.type.spec, MIN_TEXT.spec),
            lineHeight: font(20, MIN_TEXT.spec + 4),
            letterSpacing: s(0.6),
          },
        ]}>
        {label}
      </Text>
    </View>
  );
}

/** The chips of a spec summary; renders nothing (no placeholders) while spec is null. */
export function SpecLabels({
  spec,
  style,
  testID,
  max,
  onLayout,
}: {
  spec: CatalogSpec | null | undefined;
  /** At most this many chips, in reading order (narrow cards). */
  max?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  onLayout?: ViewProps['onLayout'];
}) {
  const design = useDesign();
  const chips = specChips(spec).slice(0, max);
  if (chips.length === 0) return null;
  return (
    <View
      testID={testID}
      onLayout={onLayout}
      style={[{ flexDirection: 'row', flexWrap: 'wrap', gap: design.space.xs }, style]}>
      {chips.map((chip) => (
        <SpecLabel key={chip} label={chip} />
      ))}
    </View>
  );
}
