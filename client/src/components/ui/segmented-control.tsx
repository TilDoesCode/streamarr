import { useEffect, useRef, useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { END_OF_ROW, Focusable, FocusGuide, FocusLift } from '@/components/focus';
import { Glass } from '@/components/glass';
import { Text } from '@/components/ui/text';
import { colors, useDesign, useFocusGap } from '@/theme';

export type Segment<T extends string> = { value: T; label: string; testID?: string };

/** A glass pill with one segment per option (radio group); the selected one is filled, like the library sort. */
export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  label,
  testID,
  stretch = false,
  hasTVPreferredFocus = false,
  style,
}: {
  segments: readonly Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the group. */
  label: string;
  testID?: string;
  /** Segments share the full width (phone sheets) instead of hugging their labels. */
  stretch?: boolean;
  hasTVPreferredFocus?: boolean;
  style?: ViewStyle;
}) {
  const design = useDesign();
  // The node is kept with its value: right after a change the old segment is unmounted and must not be a destination.
  const [mounted, setMounted] = useState<{ value: T; node: View } | null>(null);
  const selectedNode = mounted?.value === value ? mounted.node : null;
  // The pressed segment remounts (keyed by state): hand TV focus to the new selection.
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current || !selectedNode) return;
    refocus.current = false;
    selectedNode.requestTVFocus?.();
  }, [selectedNode]);
  const height = design.layout.controlHeight.sm;
  const inset = design.space.xs;
  const gap = useFocusGap(inset);
  return (
    <Glass
      intensity="subtle"
      radius={(height + 2 * inset) / 2}
      style={[{ padding: inset, alignSelf: stretch ? 'stretch' : 'flex-start' }, style]}>
      <FocusGuide
        remember
        trap={END_OF_ROW}
        destinations={selectedNode ? [selectedNode] : undefined}
        role="radiogroup"
        aria-label={label}
        testID={testID}
        style={{ flexDirection: 'row', gap }}>
        {segments.map((segment) => {
          const selected = segment.value === value;
          return (
            // Keyed by state: Android keeps a stale square clip when only the fill of a rounded view changes.
            <Focusable
              key={`${segment.value}-${selected ? 'on' : 'off'}`}
              testID={segment.testID ?? (testID ? `${testID}-${segment.value}` : undefined)}
              ref={
                selected
                  ? (node: View | null) => {
                      if (node)
                        setMounted((now) =>
                          now?.node === node && now.value === segment.value
                            ? now
                            : { value: segment.value, node }
                        );
                    }
                  : undefined
              }
              role="radio"
              aria-checked={selected}
              accessibilityLabel={segment.label}
              hasTVPreferredFocus={hasTVPreferredFocus && selected}
              style={stretch ? { flex: 1 } : undefined}
              onPress={() => {
                if (selected) return;
                refocus.current = design.isTV;
                onChange(segment.value);
              }}>
              <FocusLift kind="button" radius={height / 2}>
                <View
                  style={{
                    height,
                    borderRadius: height / 2,
                    paddingHorizontal: design.space.md,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: selected ? colors.primary.DEFAULT : undefined,
                  }}>
                  <Text
                    variant="callout"
                    numberOfLines={1}
                    style={selected ? { color: colors.primary.foreground } : undefined}>
                    {segment.label}
                  </Text>
                </View>
              </FocusLift>
            </Focusable>
          );
        })}
      </FocusGuide>
    </Glass>
  );
}
