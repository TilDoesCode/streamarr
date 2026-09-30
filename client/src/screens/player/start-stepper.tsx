import { Check, Circle, X } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Glass } from '@/components/glass';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { formatDuration } from '@/i18n/format';
import type { Playback } from '@/player/playback-api';
import { usePlayerT } from '@/player/use-player-t';
import { useShell } from '@/shell/use-shell';
import { colors, fonts, useDesign } from '@/theme';

type Step = 'resolving' | 'fallback' | 'repairing' | 'planning' | 'starting';
const ORDER: Step[] = ['resolving', 'fallback', 'repairing', 'planning', 'starting'];
type Attempt = NonNullable<Playback['attempts']>[number];

function visibleSteps(states: readonly string[], playback: Playback | null): Step[] {
  const fallback = states.includes('fallback') || (playback?.attempts?.length ?? 0) > 1;
  const repairing = states.includes('repairing') || !!playback?.repair;
  return ORDER.filter(
    (step) => (step !== 'fallback' || fallback) && (step !== 'repairing' || repairing)
  );
}

export type StartStepperProps = {
  playback: Playback | null;
  states: readonly string[];
  failed?: boolean;
};

/** What the server is doing before the picture starts, and why. */
export function StartStepper({ playback, states, failed = false }: StartStepperProps) {
  const pt = usePlayerT();
  const { t } = useTranslation();
  const design = useDesign();
  const steps = visibleSteps(states, playback);
  const state = playback?.state ?? 'queued';
  const ready = state === 'ready';
  const reached = [...states].reverse().find((item) => steps.includes(item as Step));
  const at = steps.indexOf((state === 'failed' ? reached : state) as Step);
  const current = ready ? steps.length : Math.max(0, at);
  const repair = playback?.repair;
  const icon = design.px(design.isTV ? 22 : 18);

  return (
    <View testID="play-stepper" style={{ gap: design.space.md, minWidth: design.px(320) }}>
      {steps.map((step, index) => {
        const done = index < current;
        const active = index === current && !ready;
        const tone = done ? 'default' : active ? (failed ? 'danger' : 'default') : 'subtle';
        return (
          <View key={step} testID={`play-step-${step}`} style={{ gap: design.space.xs }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.sm }}>
              <View style={{ width: icon, alignItems: 'center' }}>
                {done ? (
                  <Check size={icon} color={colors.success.DEFAULT} />
                ) : active && failed ? (
                  <X size={icon} color={colors.danger.DEFAULT} />
                ) : active ? (
                  <Spinner size="sm" />
                ) : (
                  <Circle size={icon * 0.6} color={colors.foreground.subtle} />
                )}
              </View>
              <Text variant="callout" tone={tone}>
                {pt(`stepper.steps.${step}`)}
              </Text>
            </View>
            {active && !failed ? (
              <Text
                testID="play-step-explain"
                variant="caption"
                tone="muted"
                style={{ marginLeft: icon + design.space.sm }}>
                {pt(`stepper.explain.${step}`, {
                  name: playback?.fallbackFrom?.name ?? playback?.attempts?.[0]?.name ?? '',
                })}
              </Text>
            ) : null}
            {step === 'fallback' ? (
              <Attempts attempts={playback?.attempts ?? []} indent={icon} />
            ) : null}
            {step === 'repairing' && repair && active ? (
              <View style={{ marginLeft: icon + design.space.sm, gap: design.space.xs }}>
                <ProgressBar value={(repair.progressPercent ?? 0) / 100} size="md" />
                <Text variant="caption" tone="muted">
                  {repair.etaSeconds
                    ? pt('stepper.repair', {
                        percent: (repair.progressPercent ?? 0) / 100,
                        eta: formatDuration(repair.etaSeconds, t),
                      })
                    : pt('stepper.repairProgress', {
                        percent: (repair.progressPercent ?? 0) / 100,
                      })}
                </Text>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function Attempts({ attempts, indent }: { attempts: readonly Attempt[]; indent: number }) {
  const pt = usePlayerT();
  const design = useDesign();
  if (attempts.length < 2) return null;
  return (
    <View
      testID="play-attempts"
      style={{ marginLeft: indent + design.space.sm, gap: design.space.xxs }}>
      {attempts.map((attempt, index) => (
        <Text
          key={`${attempt.releaseId ?? index}`}
          variant="caption"
          tone={
            attempt.status === 'dead' ? 'danger' : attempt.status === 'ready' ? 'success' : 'muted'
          }
          numberOfLines={1}>
          {`${attempt.name ?? attempt.releaseId ?? ''} · ${pt(`stepper.attempt.${attemptStatus(attempt.status)}`)}`}
        </Text>
      ))}
    </View>
  );
}

function attemptStatus(status: string | null): 'resolving' | 'ready' | 'degraded' | 'dead' {
  return status === 'ready' || status === 'degraded' || status === 'dead' ? status : 'resolving';
}

/** Centred glass card of the player's non-video states (start, resume, errors, switching). */
export function PlayerCard({
  children,
  testID,
  width = 760,
}: {
  children: ReactNode;
  testID?: string;
  width?: number;
}) {
  const design = useDesign();
  const { large, s } = useShell();
  const radius = large ? s(44) : design.radius.xl;
  return (
    <Glass
      testID={testID}
      intensity="strong"
      radius={radius}
      style={{
        alignItems: 'center',
        width: large ? s(width) : undefined,
        maxWidth: '100%',
        paddingHorizontal: large ? s(64) : design.space.xl,
        paddingVertical: large ? s(52) : design.space.xl,
        gap: large ? s(28) : design.space.lg,
      }}>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: radius,
          backgroundColor: colors.glass.tinted,
          opacity: 0.7,
        }}
      />
      {children}
    </Glass>
  );
}

/** Display-face heading of a PlayerCard. */
export function PlayerCardTitle({ children }: { children: string }) {
  const { large, s } = useShell();
  return (
    <Text
      variant="title"
      numberOfLines={2}
      style={[
        { textAlign: 'center' },
        large && { fontFamily: fonts.displayBold, fontSize: s(52), lineHeight: s(62) },
      ]}>
      {children}
    </Text>
  );
}
