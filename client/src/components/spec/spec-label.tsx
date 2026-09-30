import { View, type StyleProp, type ViewStyle } from 'react-native';

import { Text } from '@/components/ui/text';
import { SHELL } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { colors, useDesign } from '@/theme';

import { specChips, type CatalogSpec, type SpecTone } from './spec-model';

export const SPEC_TONES: Record<SpecTone, { fg: string; bg: string; border: string }> = {
  neutral: { fg: colors.foreground.DEFAULT, bg: colors.glass.subtle, border: colors.glass.border },
  ok: { fg: colors.success.DEFAULT, bg: colors.success.muted, border: colors.success.muted },
  info: { fg: colors.info.DEFAULT, bg: colors.info.muted, border: colors.info.muted },
  warn: { fg: colors.warning.DEFAULT, bg: colors.warning.muted, border: colors.warning.muted },
  bad: { fg: colors.danger.DEFAULT, bg: colors.danger.muted, border: colors.danger.muted },
};

export type SpecLabelProps = {
  label: string;
  tone?: SpecTone;
  testID?: string;
};

/** Signal-style spec chip: JetBrains Mono caps (resolution, HDR, codec, audio, playback method). */
export function SpecLabel({ label, tone = 'neutral', testID }: SpecLabelProps) {
  const design = useDesign();
  const { large, s } = useShell();
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
          large && { fontSize: s(SHELL.type.spec), lineHeight: s(20), letterSpacing: s(0.6) },
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
}: {
  spec: CatalogSpec | null | undefined;
  /** At most this many chips, in reading order (narrow cards). */
  max?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const design = useDesign();
  const chips = specChips(spec).slice(0, max);
  if (chips.length === 0) return null;
  return (
    <View
      testID={testID}
      style={[{ flexDirection: 'row', flexWrap: 'wrap', gap: design.space.xs }, style]}>
      {chips.map((chip) => (
        <SpecLabel key={chip} label={chip} />
      ))}
    </View>
  );
}
