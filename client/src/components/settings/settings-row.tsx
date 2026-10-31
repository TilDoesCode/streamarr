import { ChevronRight, type LucideIcon } from '@/components/icons';
import type { ReactNode } from 'react';
import { View } from 'react-native';

import { Focusable, FocusLift } from '@/components/focus';
import { SkeletonText } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { colors, useDesign } from '@/theme';

export type SettingsRowProps = {
  icon?: LucideIcon;
  label: string;
  /** Secondary line under the label. */
  description?: string;
  descriptionTestID?: string;
  /** Right-aligned current value. */
  value?: string;
  valueTestID?: string;
  /** Inline next to the label (status tags). */
  badge?: ReactNode;
  /** The whole row is one press target with a chevron (navigation, pickers). */
  onPress?: () => void;
  /** Press in flight: a spinner replaces the chevron. */
  busy?: boolean;
  /** Control at the row's right edge (button, toggle). */
  trailing?: ReactNode;
  /** Full-width content under the row (chips, forms); inside the press target of a pressable row, so keep it passive there. */
  children?: ReactNode;
  accessibilityLabel?: string;
  hasTVPreferredFocus?: boolean;
  testID?: string;
};

/** Settings line: icon, label with secondary text, value or control; pressable with a chevron when it navigates. */
export function SettingsRow({
  icon: Icon,
  label,
  description,
  descriptionTestID,
  value,
  valueTestID,
  badge,
  onPress,
  busy,
  trailing,
  children,
  accessibilityLabel,
  hasTVPreferredFocus,
  testID,
}: SettingsRowProps) {
  const design = useDesign();
  const head = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.md }}>
      {Icon ? <Icon size={design.px(22)} color={colors.foreground.muted} /> : null}
      <View style={{ flex: 1, gap: design.space.xxs }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            flexWrap: 'wrap',
            columnGap: design.space.sm,
          }}>
          <Text variant="body" numberOfLines={2} style={{ flexShrink: 1 }}>
            {label}
          </Text>
          {badge}
        </View>
        {description ? (
          <Text testID={descriptionTestID} variant="caption" tone="muted" numberOfLines={3}>
            {description}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text
          testID={valueTestID}
          variant="callout"
          tone="muted"
          numberOfLines={2}
          style={{ flexShrink: 1, maxWidth: '50%', textAlign: 'right' }}>
          {value}
        </Text>
      ) : null}
      {trailing ? <View style={{ flexShrink: 0 }}>{trailing}</View> : null}
      {onPress ? (
        busy ? (
          <Spinner size="sm" />
        ) : (
          <ChevronRight size={design.layout.iconSize.sm} color={colors.foreground.muted} />
        )
      ) : null}
    </View>
  );
  const padding = { padding: design.space.md, gap: design.space.md };
  if (onPress)
    return (
      <Focusable
        testID={testID}
        role="button"
        accessibilityLabel={
          accessibilityLabel ?? [label, value, description].filter(Boolean).join(', ')
        }
        hasTVPreferredFocus={hasTVPreferredFocus}
        onPress={busy ? undefined : onPress}>
        <FocusLift kind="none" radius={design.radius.md}>
          <View style={padding}>
            {head}
            {children}
          </View>
        </FocusLift>
      </Focusable>
    );
  return (
    <View testID={testID} style={padding}>
      {head}
      {children}
    </View>
  );
}

/** Label and value as a definition line (About, capability facts); stacked on phones. */
export function SettingsInfoRow({
  label,
  value,
  loading,
  valueTestID,
  labelWidth = 160,
}: {
  label: string;
  value?: string;
  /** Value still loading: a skeleton stands in. */
  loading?: boolean;
  valueTestID?: string;
  labelWidth?: number;
}) {
  const design = useDesign();
  const stacked = design.formFactor === 'phone';
  return (
    <View
      style={{
        flexDirection: stacked ? 'column' : 'row',
        gap: stacked ? design.space.xxs : design.space.lg,
        alignItems: stacked ? 'flex-start' : 'baseline',
      }}>
      <Text
        variant="callout"
        tone="muted"
        style={stacked ? undefined : { width: design.px(labelWidth) }}>
        {label}
      </Text>
      {loading ? (
        <View style={{ flex: stacked ? undefined : 1, width: stacked ? '40%' : undefined }}>
          <SkeletonText width="60%" />
        </View>
      ) : (
        <Text
          testID={valueTestID}
          variant="body"
          selectable
          style={stacked ? undefined : { flex: 1 }}>
          {value}
        </Text>
      )}
    </View>
  );
}
