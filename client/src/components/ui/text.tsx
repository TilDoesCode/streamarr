import { Platform, Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { cn } from '@/lib/utils';
import { useDesign, type TypeVariant } from '@/theme';

export type TextTone =
  | 'default'
  | 'muted'
  | 'subtle'
  | 'disabled'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'inverse';

const TONE_CLASS: Record<TextTone, string> = {
  default: 'text-foreground',
  muted: 'text-foreground-muted',
  subtle: 'text-foreground-subtle',
  disabled: 'text-foreground-disabled',
  accent: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  inverse: 'text-primary-foreground',
};

// Android TV: text sits on lighter smoked glass over bright art, so the secondary tones are brighter.
const TV_TONE_CLASS: Partial<Record<TextTone, string>> = {
  muted: 'text-foreground-mutedTv',
  subtle: 'text-foreground-subtleTv',
};

const HEADINGS: ReadonlySet<TypeVariant> = new Set(['display', 'title', 'heading']);

export type TextProps = RNTextProps & {
  variant?: TypeVariant;
  tone?: TextTone;
  className?: string;
};

export function Text({
  variant = 'body',
  tone,
  className,
  style,
  selectable,
  ...props
}: TextProps) {
  const design = useDesign();
  return (
    <RNText
      // Android TV: a selectable TextView takes remote focus when attached, then drops it (nothing focused).
      selectable={selectable && !Platform.isTV}
      role={HEADINGS.has(variant) ? 'heading' : undefined}
      className={cn(
        'text-foreground',
        tone && ((design.isTV && TV_TONE_CLASS[tone]) || TONE_CLASS[tone]),
        className
      )}
      style={[
        design.type[variant],
        (variant === 'overline' || variant === 'spec') && { textTransform: 'uppercase' },
        style,
      ]}
      {...props}
    />
  );
}
