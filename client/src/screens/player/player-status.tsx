import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';

import { describeError } from '@/api/error-text';
import { Glass, GlassButton } from '@/components/glass';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import type { PlayerStatus } from '@/player/controller';
import { clock } from '@/player/format';
import { hintActionKey, hintText, type HintAction } from '@/player/recovery/hints';
import type { Attempt } from '@/player/recovery/ladder';
import { usePlayerT } from '@/player/use-player-t';
import { useDesign } from '@/theme';

export type PlayerStatusProps = {
  status: PlayerStatus;
  onAction: (action: HintAction) => void;
  controlsVisible?: boolean;
  /** Where the top bar ends (the notice slot starts here). */
  top?: number;
  noticeShown?: boolean;
};

export type StatusLayout = { anchor: 'centre' | 'top'; spinner: boolean; offset: number };

/** Visible touch/web controls own the centre (Play, ±10 s): the hint moves under the top bar, below a notice. */
export function statusLayout(options: {
  controlsVisible: boolean;
  tv: boolean;
  spinner: boolean;
  top: number;
  noticeShown: boolean;
  noticeHeight: number;
}): StatusLayout {
  const { controlsVisible, tv, spinner, top, noticeShown, noticeHeight } = options;
  if (!controlsVisible || tv) return { anchor: 'centre', spinner, offset: 0 };
  return { anchor: 'top', spinner: false, offset: top + (noticeShown ? noticeHeight : 0) };
}

/** Spinner and hint over the picture; never focusable on TV (no buttons there), announced once per change. */
export function PlayerStatusView({
  status,
  onAction,
  controlsVisible = false,
  top = 0,
  noticeShown = false,
}: PlayerStatusProps) {
  const pt = usePlayerT();
  const design = useDesign();
  const { hint } = status;
  const text = hint ? hintText(pt, hint.key, hint.params) : null;
  // The label is taken when the hint changes, so a countdown is not re-read every second.
  const [spoken, setSpoken] = useState<{ key: string | null; label: string | null }>({
    key: null,
    label: null,
  });
  if ((hint?.key ?? null) !== spoken.key) setSpoken({ key: hint?.key ?? null, label: text });
  useEffect(() => {
    if (spoken.label) AccessibilityInfo.announceForAccessibility(spoken.label);
  }, [spoken]);
  const layout = statusLayout({
    controlsVisible,
    tv: design.isTV,
    spinner: status.spinner,
    top,
    noticeShown,
    noticeHeight: design.px(64),
  });
  if (!hint && !layout.spinner) return null;
  const actions = design.isTV ? [] : status.actions;
  return (
    <View
      testID="player-status"
      pointerEvents={actions.length ? 'box-none' : 'none'}
      style={[
        StyleSheet.absoluteFill,
        layout.anchor === 'centre'
          ? styles.centre
          : { alignItems: 'center', justifyContent: 'flex-start', paddingTop: layout.offset },
        { gap: design.space.lg },
      ]}>
      {layout.spinner ? (
        <View
          pointerEvents="none"
          testID="player-status-spinner"
          // The hint below says the same; read once.
          accessibilityElementsHidden={!!hint}
          importantForAccessibility={hint ? 'no-hide-descendants' : 'auto'}>
          <Spinner size="lg" />
        </View>
      ) : null}
      {hint ? (
        <Glass
          testID={`player-status-${hint.key}`}
          pointerEvents="box-none"
          intensity="strong"
          radius={design.radius.md}
          style={{
            maxWidth: design.px(720),
            marginHorizontal: design.layout.gutter,
            paddingHorizontal: design.space.lg,
            paddingVertical: design.space.md,
            gap: design.space.md,
            alignItems: 'center',
          }}>
          <View accessible accessibilityLabel={spoken.label ?? text ?? undefined}>
            <Text variant="callout" style={{ textAlign: 'center' }}>
              {text}
            </Text>
          </View>
          {actions.length ? (
            <View style={{ flexDirection: 'row', gap: design.space.sm }}>
              {actions.map((action, index) => (
                <GlassButton
                  key={action}
                  testID={`player-status-action-${action}`}
                  tone={index === 0 ? 'solid' : 'glass'}
                  label={pt(hintActionKey(action))}
                  hasTVPreferredFocus={false}
                  onPress={() => onAction(action)}
                />
              ))}
            </View>
          ) : null}
        </Glass>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  centre: { alignItems: 'center', justifyContent: 'center' },
});

/** "What was tried" on the failure card: one line per ladder step, with the failure that led to it. */
export function RecoveryLog({ tried }: { tried: readonly Attempt[] }) {
  const pt = usePlayerT();
  const { t } = useTranslation();
  const design = useDesign();
  if (!tried.length) return null;
  return (
    <View testID="play-error-tried" style={{ gap: design.space.xs, alignSelf: 'stretch' }}>
      <Text variant="overline" tone="muted">
        {pt('tried.title')}
      </Text>
      {tried.map((attempt, index) => (
        <Text
          key={index}
          variant="caption"
          tone="muted"
          testID={`play-error-tried-${attempt.step}`}>
          {`${pt(`tried.${attempt.step}`, { time: clock(attempt.position) })} · ${
            describeError(t, { code: attempt.code }).title
          }`}
        </Text>
      ))}
    </View>
  );
}
