import {
  CircleAlert,
  CircleCheck,
  Info,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react-native';
import type { ReactNode } from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { colors, useDesign } from '@/theme';

export type FormMessageTone = 'danger' | 'warning' | 'info' | 'success';

const TONES: Record<FormMessageTone, { icon: LucideIcon; color: string; background: string }> = {
  danger: { icon: CircleAlert, color: colors.danger.DEFAULT, background: colors.danger.muted },
  warning: { icon: TriangleAlert, color: colors.warning.DEFAULT, background: colors.warning.muted },
  info: { icon: Info, color: colors.info.DEFAULT, background: colors.info.muted },
  success: { icon: CircleCheck, color: colors.success.DEFAULT, background: colors.success.muted },
};

export type FormMessageProps = {
  tone?: FormMessageTone;
  title: string;
  message?: string;
  /** Buttons under the text (e.g. "Connect anyway"). */
  actions?: ReactNode;
  testID?: string;
};

/** Inline, non-modal message inside a form (errors, warnings); announced to screen readers. */
export function FormMessage({
  tone = 'danger',
  title,
  message,
  actions,
  testID,
}: FormMessageProps) {
  const design = useDesign();
  const { icon: IconComponent, color, background } = TONES[tone];
  return (
    <View
      testID={testID}
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      aria-live="polite"
      style={{
        alignSelf: 'stretch',
        flexDirection: 'row',
        gap: design.space.md,
        padding: design.space.md,
        borderRadius: design.radius.md,
        borderCurve: 'continuous',
        backgroundColor: background,
      }}>
      <IconComponent size={design.layout.iconSize.md} color={color} strokeWidth={2} />
      <View style={{ flex: 1, gap: design.space.xs }}>
        <Text variant="callout">{title}</Text>
        {message ? (
          <Text variant="caption" tone="muted" selectable>
            {message}
          </Text>
        ) : null}
        {actions ? (
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              gap: design.space.sm,
              marginTop: design.space.xs,
            }}>
            {actions}
          </View>
        ) : null}
      </View>
    </View>
  );
}
