import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';

import { isKnownErrorCode } from '@/api/error-codes';
import { describeError } from '@/api/error-text';
import { Glass } from '@/components/glass';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import type { PlayerStatus } from '@/player/controller';
import { clock } from '@/player/format';
import { hintActionKey, hintText, type HintAction } from '@/player/recovery/hints';
import type { Attempt } from '@/player/recovery/ladder';
import { usePlayerT } from '@/player/use-player-t';
import { useDesign } from '@/theme';

import { StatusAction } from './status-action';

export type PlayerStatusProps = {
  status: PlayerStatus;
  onAction: (action: HintAction) => void;
  controlsVisible?: boolean;
  /** Where the top bar ends (the notice slot starts here). */
  top?: number;
  noticeShown?: boolean;
};

export type StatusLayout = { anchor: 'centre' | 'top'; offset: number };

/** Visible touch/web controls own the centre (Play, ±10 s): the hint moves under the top bar, below a notice. */
export function statusLayout(options: {
  controlsVisible: boolean;
  tv: boolean;
  top: number;
  noticeShown: boolean;
  noticeHeight: number;
}): StatusLayout {
  const { controlsVisible, tv, top, noticeShown, noticeHeight } = options;
  if (!controlsVisible || tv) return { anchor: 'centre', offset: 0 };
  return { anchor: 'top', offset: top + (noticeShown ? noticeHeight : 0) };
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
  // Announced once per hint (a countdown is not re-read every second); the label follows the live text.
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
    top,
    noticeShown,
    noticeHeight: design.px(64),
  });
  if (!hint && !status.spinner) return null;
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
      {status.spinner ? (
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
          <View accessible accessibilityLabel={text ?? undefined}>
            <Text variant="callout" style={{ textAlign: 'center' }}>
              {text}
            </Text>
          </View>
          {actions.length ? (
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                justifyContent: 'center',
                gap: design.space.sm,
              }}>
              {actions.map((action, index) => (
                <StatusAction
                  key={action}
                  testID={`player-status-action-${action}`}
                  primary={index === 0}
                  label={pt(hintActionKey(action))}
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
export function RecoveryLog({ tried, limit }: { tried: readonly Attempt[]; limit?: number }) {
  const pt = usePlayerT();
  const { t } = useTranslation();
  const design = useDesign();
  const [all, setAll] = useState(false);
  if (!tried.length) return null;
  // A short window (a phone in landscape) shows the last steps; the rest on request (V2).
  const hidden = !all && limit !== undefined ? Math.max(0, tried.length - limit) : 0;
  return (
    <View testID="play-error-tried" style={{ gap: design.space.xs, alignSelf: 'stretch' }}>
      <Text variant="overline" tone="muted">
        {pt('tried.title')}
      </Text>
      {tried.slice(hidden).map((attempt, index) => (
        <Text
          key={index}
          variant="caption"
          tone="muted"
          testID={`play-error-tried-${attempt.step}`}>
          {`${pt(`tried.${attempt.step}`, { time: clock(attempt.position) })} · ${
            // A code the app does not know (a server's internal_error) reads by the attempt's category, like the card (S9c E10).
            isKnownErrorCode(attempt.code)
              ? describeError(t, { code: attempt.code }).title
              : t(`errors.categories.${attempt.category}.title`)
          }`}
        </Text>
      ))}
      {hidden ? (
        <StatusAction
          testID="play-error-tried-more"
          primary={false}
          label={pt('tried.more', { count: hidden })}
          onPress={() => setAll(true)}
        />
      ) : null}
    </View>
  );
}
