import type { EmbeddedServerStatus } from '@modules/embedded-server';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { FocusGuide, Focusable, FocusLift } from '@/components/focus';
import { GlassChip } from '@/components/glass';
import { KeyRound, RefreshCw, ScrollText } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TextField } from '@/components/ui/text-field';
import { parsePort, PORT_MAX, PORT_MIN, runningPort } from '@/local-server/model';
import {
  LOG_LINES,
  useServerLogs,
  type useEmbeddedServer,
} from '@/local-server/use-embedded-server';
import { FormError } from '@/screens/onboarding/form-parts';
import { colors, fonts, useDesign, useFocusGap } from '@/theme';

import { ActionRow, Card } from './card';

type Server = ReturnType<typeof useEmbeddedServer>;

/** Autostart, port, admin password reset and the log toggle. */
export function ServerSettings({
  server,
  status,
  logsShown,
  onToggleLogs,
  onPasswordReset,
}: {
  server: Server;
  status: EmbeddedServerStatus;
  logsShown: boolean;
  onToggleLogs: () => void;
  onPasswordReset: () => void;
}) {
  const { t } = useTranslation();
  const design = useDesign();
  return (
    <Card testID="local-server-settings">
      <Text variant="heading">{t('localServer.settings.title')}</Text>
      <AutostartRow server={server} status={status} />
      <PortRow server={server} status={status} />
      <View style={{ gap: design.space.sm }}>
        <Text variant="body">{t('localServer.settings.maintenance')}</Text>
        <ActionRow>
          <ResetPasswordButton server={server} onDone={onPasswordReset} />
          <Button
            testID="local-server-logs-toggle"
            variant="secondary"
            icon={ScrollText}
            aria-expanded={logsShown}
            label={logsShown ? t('localServer.logs.hide') : t('localServer.logs.show')}
            onPress={onToggleLogs}
          />
        </ActionRow>
        <FormError testID="local-server-reset-error" error={server.resetPassword.error} />
        {server.resetPassword.isSuccess ? (
          <FormMessage
            testID="local-server-reset-done"
            tone="success"
            title={t('localServer.settings.resetDone')}
            message={t('localServer.settings.resetDoneHint')}
          />
        ) : null}
      </View>
    </Card>
  );
}

function AutostartRow({ server, status }: { server: Server; status: EmbeddedServerStatus }) {
  const { t } = useTranslation();
  const design = useDesign();
  const chipGap = useFocusGap(design.space.sm);
  const pending = server.setAutostart.isPending ? server.setAutostart.variables : undefined;
  const value = pending ?? status.autostart;
  return (
    <View style={{ gap: design.space.sm }}>
      <View style={{ gap: design.space.xxs }}>
        <Text variant="body">{t('localServer.settings.autostart')}</Text>
        <Text variant="caption" tone="muted">
          {t('localServer.settings.autostartHint')}
        </Text>
      </View>
      <FocusGuide
        remember
        testID="local-server-autostart"
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: chipGap }}>
        {[true, false].map((enabled) => (
          <GlassChip
            key={String(enabled)}
            testID={`local-server-autostart-${enabled ? 'on' : 'off'}`}
            role="radio"
            aria-checked={value === enabled}
            selected={value === enabled}
            label={enabled ? t('localServer.settings.on') : t('localServer.settings.off')}
            onPress={() => {
              if (value !== enabled) server.setAutostart.mutate(enabled);
            }}
          />
        ))}
      </FocusGuide>
      <FormError testID="local-server-autostart-error" error={server.setAutostart.error} />
    </View>
  );
}

function PortRow({ server, status }: { server: Server; status: EmbeddedServerStatus }) {
  const { t } = useTranslation();
  const design = useDesign();
  const [text, setText] = useState(String(status.port));
  const [problem, setProblem] = useState<string>();
  const running = status.state === 'running';
  const pendingPort = running && runningPort(status) !== status.port ? status.port : undefined;
  const apply = () => {
    const parsed = parsePort(text);
    if ('problem' in parsed) {
      setProblem(
        t(`localServer.settings.portProblem.${parsed.problem}`, { min: PORT_MIN, max: PORT_MAX })
      );
      return;
    }
    setProblem(undefined);
    if (parsed.port !== status.port) server.setPort.mutate(parsed.port);
  };
  return (
    <View style={{ gap: design.space.sm }}>
      <TextField
        testID="local-server-port-input"
        label={t('localServer.settings.port')}
        hint={t('localServer.settings.portHint', { min: PORT_MIN, max: PORT_MAX })}
        value={text}
        error={problem}
        keyboardType="number-pad"
        inputMode="numeric"
        maxLength={5}
        returnKeyType="done"
        submitBehavior="blurAndSubmit"
        onChangeText={(value) => {
          setText(value);
          setProblem(undefined);
          server.setPort.reset();
        }}
        onSubmitEditing={apply}
      />
      <ActionRow>
        <Button
          testID="local-server-port-apply"
          variant="secondary"
          size="sm"
          label={t('localServer.settings.portApply')}
          loading={server.setPort.isPending}
          onPress={apply}
        />
      </ActionRow>
      <FormError testID="local-server-port-error" error={server.setPort.error} />
      {pendingPort ? (
        <FormMessage
          testID="local-server-port-pending"
          tone="info"
          title={t('localServer.settings.portPending', { port: pendingPort })}
          message={t('localServer.settings.portPendingHint')}
        />
      ) : null}
    </View>
  );
}

/** Seconds the armed reset waits for the confirming press. */
const ARM_MS = 6000;

/** Two presses: the first arms (destructive look, "press again"), the second resets. */
function ResetPasswordButton({ server, onDone }: { server: Server; onDone: () => void }) {
  const { t } = useTranslation();
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Button
      testID="local-server-reset-password"
      variant={armed ? 'destructive' : 'secondary'}
      icon={KeyRound}
      loading={server.resetPassword.isPending}
      label={armed ? t('localServer.settings.resetConfirm') : t('localServer.settings.reset')}
      onBlur={() => setArmed(false)}
      onPress={() => {
        clearTimeout(timer.current);
        if (!armed) {
          server.resetPassword.reset();
          setArmed(true);
          timer.current = setTimeout(() => setArmed(false), ARM_MS);
          return;
        }
        setArmed(false);
        server.resetPassword.mutate(undefined, { onSuccess: onDone });
      }}
    />
  );
}

const CHUNK = 8;

/** Last lines of the server log in monospace; on TV each block of lines is a focus stop so the remote can scroll. */
export function LogPanel({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const design = useDesign();
  const logs = useServerLogs(active);
  const lines = logs.data ?? [];
  const chunks: string[][] = [];
  for (let index = 0; index < lines.length; index += CHUNK)
    chunks.push(lines.slice(index, index + CHUNK));
  const mono = { fontFamily: fonts.mono, fontSize: design.px(12), lineHeight: design.px(18) };
  const body = (chunk: string[], index: number) => (
    <Text
      key={index}
      variant="caption"
      style={[mono, { color: colors.foreground.muted }]}
      selectable>
      {chunk.join('\n')}
    </Text>
  );
  return (
    <Card testID="local-server-logs">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.md }}>
        <Text variant="heading" style={{ flex: 1 }}>
          {t('localServer.logs.title', { count: LOG_LINES })}
        </Text>
        <ActionRow>
          <Button
            testID="local-server-logs-refresh"
            variant="secondary"
            size="sm"
            icon={RefreshCw}
            loading={logs.isFetching}
            label={t('localServer.logs.refresh')}
            onPress={() => void logs.refetch()}
          />
        </ActionRow>
      </View>
      <FormError testID="local-server-logs-error" error={logs.error} />
      {logs.isPending ? (
        <View style={{ gap: design.space.sm }}>
          <SkeletonText width="80%" />
          <SkeletonText width="60%" />
        </View>
      ) : lines.length === 0 ? (
        <Text testID="local-server-logs-empty" variant="callout" tone="muted">
          {t('localServer.logs.empty')}
        </Text>
      ) : (
        <ScrollView
          testID="local-server-logs-scroll"
          nestedScrollEnabled
          style={{
            maxHeight: design.isTV ? undefined : design.px(360),
            borderRadius: design.radius.md,
            backgroundColor: colors.background,
          }}
          contentContainerStyle={{ padding: design.space.md }}>
          {design.isTV
            ? chunks.map((chunk, index) => (
                <Focusable
                  key={index}
                  testID={`local-server-logs-chunk-${index}`}
                  accessibilityLabel={chunk.join('\n')}>
                  <FocusLift kind="none" radius={design.radius.sm}>
                    <View style={{ padding: design.space.xs }}>{body(chunk, index)}</View>
                  </FocusLift>
                </Focusable>
              ))
            : body(lines, 0)}
        </ScrollView>
      )}
    </Card>
  );
}
