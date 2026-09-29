import type { Ref } from 'react';
import {
  Platform,
  TVFocusGuideView,
  View,
  type BlurEvent,
  type FocusEvent,
  type FocusGuideMethods,
  type ViewProps,
} from 'react-native';

export type FocusDirection = 'up' | 'down' | 'left' | 'right';

/** Horizontal groups stop at their right end; left stays open for a navigation rail. */
export const END_OF_ROW: readonly FocusDirection[] = ['right'];

export type FocusGuideProps = ViewProps & {
  /** Re-entering focus lands on the last focused child (first child on the first visit). */
  remember?: boolean;
  /** Directions in which focus must not leave this group (e.g. dialogs, row ends). */
  trap?: readonly FocusDirection[];
  /** Explicit focus targets when focus enters (override `remember`). Pass [] to clear. */
  destinations?: readonly View[];
  onFocusEnter?: (event: FocusEvent) => void;
  onFocusLeave?: (event: BlurEvent) => void;
  ref?: Ref<View>;
};

/** A focus group (row, rail, section). TV: TVFocusGuideView; elsewhere a plain View. */
export function FocusGuide({
  remember = true,
  trap,
  onFocusEnter,
  onFocusLeave,
  destinations,
  children,
  ref,
  ...props
}: FocusGuideProps) {
  if (!Platform.isTV) {
    return (
      <View ref={ref} {...props}>
        {children}
      </View>
    );
  }
  return (
    <TVFocusGuideView
      ref={ref as Ref<View & FocusGuideMethods>}
      autoFocus={remember}
      destinations={destinations as View[] | undefined}
      trapFocusUp={trap?.includes('up')}
      trapFocusDown={trap?.includes('down')}
      trapFocusLeft={trap?.includes('left')}
      trapFocusRight={trap?.includes('right')}
      onFocusEnter={onFocusEnter}
      onFocusLeave={onFocusLeave}
      {...props}>
      {children}
    </TVFocusGuideView>
  );
}
