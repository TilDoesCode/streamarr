import { View, type StyleProp, type ViewStyle } from 'react-native';

import { Text } from '@/components/ui/text';
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
  const palette = SPEC_TONES[tone];
  return (
    <View
      testID={testID}
      style={{
        paddingHorizontal: design.px(7),
        paddingVertical: design.px(3),
        borderRadius: design.radius.sm,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.bg,
      }}>
      <Text variant="spec" numberOfLines={1} style={{ color: palette.fg }}>
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
}: {
  spec: CatalogSpec | null | undefined;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const design = useDesign();
  const chips = specChips(spec);
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
