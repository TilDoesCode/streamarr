import { Platform, Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { cn } from '@/lib/utils';
import { colors, theme, useDesign, type TypeVariant } from '@/theme';

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

// Tailwind classes are compiled from the default palette; a host theme sets the tone colour inline.
const TONE_COLOR: Record<TextTone, string> = {
  default: colors.foreground.DEFAULT,
  muted: colors.foreground.muted,
  subtle: colors.foreground.subtle,
  disabled: colors.foreground.disabled,
  accent: colors.accent.DEFAULT,
  success: colors.success.DEFAULT,
  warning: colors.warning.DEFAULT,
  danger: colors.danger.DEFAULT,
  inverse: colors.primary.foreground,
};
const TV_TONE_COLOR: Partial<Record<TextTone, string>> = {
  muted: colors.foreground.mutedTv,
  subtle: colors.foreground.subtleTv,
};

const HEADINGS: ReadonlySet<TypeVariant> = new Set(['display', 'title', 'heading']);

const RESOLUTION = /\b(\d{3,4})([pi])\b/gi;

/** Spec caps that keep resolution suffixes lower case ("1080p", not "1080P"). */
export function specCase(label: string): string {
  return label.toUpperCase().replace(RESOLUTION, (_, n: string, x: string) => n + x.toLowerCase());
}

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
  children,
  ...props
}: TextProps) {
  const design = useDesign();
  // Spec strings with a resolution are cased in JS; CSS uppercase would turn "1080p" into "1080P".
  const specString =
    variant === 'spec' && typeof children === 'string' && new RegExp(RESOLUTION).test(children);
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
        theme !== 'default' && {
          color: (design.isTV && TV_TONE_COLOR[tone ?? 'default']) || TONE_COLOR[tone ?? 'default'],
        },
        (variant === 'overline' || (variant === 'spec' && !specString)) && {
          textTransform: 'uppercase',
        },
        style,
      ]}
      {...props}>
      {specString ? specCase(children) : children}
    </RNText>
  );
}
