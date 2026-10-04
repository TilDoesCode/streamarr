import { Eye, EyeOff } from '@/components/icons';
import { useState, type ReactNode, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View, type TextInput } from 'react-native';

import { describeError, errorTone } from '@/api/error-text';
import { toAppError } from '@/api/errors';
import { FormMessage } from '@/components/ui/form-message';
import { IconButton } from '@/components/ui/icon-button';
import { TextField, type TextFieldProps } from '@/components/ui/text-field';
import { useDesign } from '@/theme';

/** The failure of the last submit as an inline message (localized from its error code). */
export function FormError({
  error,
  actions,
  testID = 'form-error',
}: {
  error: unknown;
  actions?: ReactNode;
  testID?: string;
}) {
  const { t } = useTranslation();
  if (!error) return null;
  const appError = toAppError(error);
  const { title, message } = describeError(t, appError);
  return (
    <FormMessage
      tone={errorTone(appError)}
      title={title}
      message={message}
      actions={actions}
      testID={`${testID}-${appError.code}`}
    />
  );
}

export type PasswordFieldProps = Omit<TextFieldProps, 'secureTextEntry' | 'trailing'> & {
  ref?: Ref<TextInput>;
};

/** Password input with a show/hide toggle at its end (beside it and a separate focus stop on TV). */
export function PasswordField({ ref, testID, ...props }: PasswordFieldProps) {
  const { t } = useTranslation();
  const design = useDesign();
  const [visible, setVisible] = useState(false);
  const [visibleKeyboard, setVisibleKeyboard] = useState(false);
  const toggle = () => {
    setVisible(!visible);
    setVisibleKeyboard(false);
    // Android: a frame after secureTextEntry, which would otherwise clear the visible-password bits.
    if (!visible && Platform.OS === 'android')
      requestAnimationFrame(() => setVisibleKeyboard(true));
  };
  return (
    <TextField
      ref={ref}
      testID={testID}
      secureTextEntry={!visible}
      // A shown password must not reach the keyboard's suggestions or learned words.
      keyboardType={visible && visibleKeyboard ? 'visible-password' : 'default'}
      autoCapitalize="none"
      autoCorrect={false}
      trailing={
        <IconButton
          icon={visible ? EyeOff : Eye}
          variant="ghost"
          size={design.isTV ? 'lg' : 'md'}
          testID={testID ? `${testID}-toggle` : undefined}
          accessibilityLabel={
            visible ? t('onboarding.signIn.hidePassword') : t('onboarding.signIn.showPassword')
          }
          aria-pressed={visible}
          onPress={toggle}
        />
      }
      {...props}
    />
  );
}

/** Secondary actions under a form (links such as "Forgot password?"). */
export function FormLinks({ children }: { children: ReactNode }) {
  const design = useDesign();
  return (
    <View
      style={{
        flexDirection: design.isTV ? 'column' : 'row',
        flexWrap: 'wrap',
        alignItems: design.isTV ? 'flex-start' : 'center',
        gap: design.space.sm,
      }}>
      {children}
    </View>
  );
}
