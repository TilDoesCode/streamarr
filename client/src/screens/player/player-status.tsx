import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

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
  /** Lifts the hint above the visible controls. */
  controlsVisible?: boolean;
};

/**
 * Spinner and hint over the picture. It never takes focus: on TV it draws no buttons (the remote's Play and the
 * overlay's panels carry the same actions); on touch and web the actions are buttons without preferred focus.
 */
export function PlayerStatusView({ status, onAction, controlsVisible = false }: PlayerStatusProps) {
  const pt = usePlayerT();
  const design = useDesign();
  const { hint, spinner } = status;
  if (!hint && !spinner) return null;
  const actions = design.isTV ? [] : status.actions;
  return (
    <View
      testID="player-status"
      pointerEvents={actions.length ? 'box-none' : 'none'}
      style={[StyleSheet.absoluteFill, styles.centre, { gap: design.space.lg }]}>
      {spinner ? (
        <View pointerEvents="none" testID="player-status-spinner">
          <Spinner
            size="lg"
            accessibilityLabel={hint ? hintText(pt, hint.key, hint.params) : undefined}
          />
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
            marginTop: controlsVisible && !spinner ? design.px(-160) : 0,
          }}>
          <Text variant="callout" style={{ textAlign: 'center' }} accessibilityLiveRegion="polite">
            {hintText(pt, hint.key, hint.params)}
          </Text>
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
