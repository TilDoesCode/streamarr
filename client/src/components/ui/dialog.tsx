import { useRef, type ReactNode } from 'react';
import { Modal, View } from 'react-native';
import Animated, { Easing, Keyframe } from 'react-native-reanimated';

import { FocusGuide, FocusLayer, useInitialWebFocus } from '@/components/focus';
import { Button, type ButtonVariant } from '@/components/ui/button';
import { OverlayScrim } from '@/components/ui/overlay-scrim';
import { Text } from '@/components/ui/text';
import { colors, easing, motion, useDesign } from '@/theme';

const PANEL_IN = new Keyframe({
  0: { opacity: 0, transform: [{ scale: 0.96 }] },
  100: { opacity: 1, transform: [{ scale: 1 }], easing: Easing.bezier(...easing.out) },
}).duration(motion.enter);

export type DialogAction = {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  /** Initial focus for remote and keyboard (default: the first action, the safe choice). */
  preferred?: boolean;
};

export type DialogProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  message?: string;
  actions: readonly DialogAction[];
  children?: ReactNode;
  testID?: string;
};

/** Confirmation for consequential actions. Back / Escape / scrim tap close it. */
export function Dialog({ open, onClose, title, message, actions, children, testID }: DialogProps) {
  const design = useDesign();
  const preferredIndex = Math.max(
    0,
    actions.findIndex((action) => action.preferred)
  );
  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
      supportedOrientations={['portrait', 'landscape']}>
      <FocusLayer open={open}>
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            padding: design.layout.gutter,
          }}>
          <OverlayScrim onPress={onClose} />
          <Animated.View
            testID={testID}
            entering={PANEL_IN}
            role="dialog"
            aria-modal
            aria-label={title}
            style={{
              width: '100%',
              maxWidth: design.px(460),
              padding: design.space['2xl'],
              gap: design.space.md,
              borderRadius: design.radius.xl,
              borderCurve: 'continuous',
              backgroundColor: colors.surface.raised,
              boxShadow: design.shadow.overlay,
            }}>
            <Text variant="heading">{title}</Text>
            {message ? (
              <Text variant="body" tone="muted">
                {message}
              </Text>
            ) : null}
            {children}
            <FocusGuide
              remember
              trap={['up', 'down', 'left', 'right']}
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                justifyContent: 'flex-end',
                gap: design.space.md,
                marginTop: design.space.md,
              }}>
              {actions.map((action, index) => (
                <DialogButton
                  key={action.label}
                  action={action}
                  variant={
                    action.variant ?? (index === actions.length - 1 ? 'primary' : 'secondary')
                  }
                  preferred={index === preferredIndex}
                />
              ))}
            </FocusGuide>
          </Animated.View>
        </View>
      </FocusLayer>
    </Modal>
  );
}

function DialogButton({
  action,
  variant,
  preferred,
}: {
  action: DialogAction;
  variant: ButtonVariant;
  preferred: boolean;
}) {
  const ref = useRef<View>(null);
  useInitialWebFocus(ref, preferred);
  return (
    <Button
      ref={ref}
      label={action.label}
      variant={variant}
      hasTVPreferredFocus={preferred}
      onPress={action.onPress}
    />
  );
}
