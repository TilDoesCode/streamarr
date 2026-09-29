import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import {
  Keyboard,
  Platform,
  TextInput,
  View,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { Focusable } from '@/components/focus';
import { Text } from '@/components/ui/text';
import { colors, useDesign } from '@/theme';

// Web: our border replaces the browser focus outline (RN's types lack 'none').
const NO_OUTLINE = { outlineStyle: 'none' } as unknown as TextStyle;

export type TextFieldProps = Omit<TextInputProps, 'style' | 'placeholderTextColor'> & {
  label: string;
  /** Shown under the field in the danger tone; marks the field invalid. */
  error?: string;
  hint?: string;
  /** Control beside the input (e.g. show-password). */
  trailing?: ReactNode;
  /** Initial focus: TV remote focus, desktop web keyboard focus (phones would pop the keyboard). */
  initialFocus?: boolean;
  ref?: Ref<TextInput>;
};

/** Labelled input with a strong focus border. TV: OK opens the keyboard; Up/Down always move between fields. */
export function TextField({
  label,
  error,
  hint,
  trailing,
  onFocus,
  onBlur,
  onSubmitEditing,
  editable = true,
  initialFocus = false,
  ref,
  testID,
  ...props
}: TextFieldProps) {
  const design = useDesign();
  const tv = design.isTV;
  const [focused, setFocused] = useState(false);
  const [editing, setEditing] = useState(false);
  const labelId = useId();
  const inputRef = useRef<TextInput>(null);
  const fieldRef = useRef<View>(null);
  // TV: focus() (e.g. "next" from the previous field) moves remote focus here and starts editing.
  useImperativeHandle(
    ref,
    () =>
      ({
        focus: () => {
          if (!tv) return inputRef.current?.focus();
          fieldRef.current?.requestTVFocus?.();
          setEditing(true);
        },
        blur: () => inputRef.current?.blur(),
        clear: () => inputRef.current?.clear(),
        isFocused: () => inputRef.current?.isFocused() ?? false,
      }) as unknown as TextInput,
    [tv]
  );

  // TV: the input becomes editable, then takes focus, which opens the keyboard.
  useEffect(() => {
    if (!editing) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    const hidden = Keyboard.addListener('keyboardDidHide', () => {
      fieldRef.current?.requestTVFocus?.();
      setEditing(false);
    });
    return () => {
      cancelAnimationFrame(frame);
      hidden.remove();
    };
  }, [editing]);

  const height = tv ? design.px(44) : design.layout.controlHeight.lg;
  const typeStep = tv ? design.type.subheading : design.type.body;
  // iOS/iPad Safari zoom into inputs below 16 px.
  const fontSize = Platform.OS === 'web' ? Math.max(16, typeStep.fontSize) : typeStep.fontSize;
  const active = focused || editing;
  const box: ViewStyle = {
    flex: 1,
    height,
    justifyContent: 'center',
    borderRadius: design.radius.md,
    borderCurve: 'continuous',
    borderWidth: design.focus.ringWidth,
    borderColor: active ? colors.focus.DEFAULT : error ? colors.danger.DEFAULT : colors.border,
    backgroundColor: active ? colors.surface.overlay : colors.input,
    boxShadow: active && tv ? design.shadow.glow : undefined,
    opacity: editable ? 1 : 0.5,
  };

  const input = (
    <TextInput
      ref={inputRef}
      testID={testID}
      accessibilityLabel={label}
      aria-labelledby={labelId}
      accessibilityHint={error}
      editable={editable && (!tv || editing)}
      focusable={!tv || editing}
      autoFocus={design.formFactor === 'desktop-web' && initialFocus}
      placeholderTextColor={colors.foreground.subtle}
      selectionColor={colors.accent.DEFAULT}
      cursorColor={colors.foreground.DEFAULT}
      disableFullscreenUI
      onFocus={(event) => {
        if (!tv) setFocused(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        if (tv) setEditing(false);
        else setFocused(false);
        onBlur?.(event);
      }}
      onSubmitEditing={(event) => {
        // TV: keep remote focus on this field instead of letting Android jump to the first focusable.
        if (tv) fieldRef.current?.requestTVFocus?.();
        onSubmitEditing?.(event);
      }}
      style={[
        {
          flex: 1,
          paddingHorizontal: design.space.md,
          paddingVertical: 0,
          color: colors.foreground.DEFAULT,
          fontSize,
          fontWeight: '500',
        },
        Platform.OS === 'web' && NO_OUTLINE,
      ]}
      {...props}
    />
  );

  return (
    <View style={{ gap: design.space.xs, alignSelf: 'stretch' }}>
      <Text variant="label" tone="muted" nativeID={labelId}>
        {label}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.sm }}>
        {tv ? (
          <Focusable
            ref={fieldRef}
            testID={testID ? `${testID}-field` : undefined}
            accessibilityLabel={label}
            accessibilityHint={error}
            disabled={!editable}
            hasTVPreferredFocus={initialFocus}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onPress={() => setEditing(true)}
            style={{ flex: 1 }}>
            <View style={box}>{input}</View>
          </Focusable>
        ) : (
          <View style={box}>{input}</View>
        )}
        {trailing}
      </View>
      {error ? (
        // Separate keys: NativeWind on web keeps the old tone class when one Text replaces the other.
        <Text key="error" variant="caption" tone="danger" role="alert" selectable>
          {error}
        </Text>
      ) : hint ? (
        <Text key="hint" variant="caption" tone="subtle">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}
