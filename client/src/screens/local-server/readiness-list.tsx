import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Circle, CircleAlert, CircleCheck } from '@/components/icons';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import type { Check } from '@/local-server/model';
import { colors, useDesign } from '@/theme';

import { Card } from './card';

/** The four readiness lines with icon and a short help text; the connect action sits underneath. */
export function ReadinessList({ checks, children }: { checks: Check[]; children?: ReactNode }) {
  const { t } = useTranslation();
  const design = useDesign();
  return (
    <Card testID="local-server-readiness">
      <Text variant="heading">{t('localServer.readiness.title')}</Text>
      <View style={{ gap: design.space.md }}>
        {checks.map((check) => (
          <CheckLine key={check.id} check={check} />
        ))}
      </View>
      {children}
    </Card>
  );
}

function CheckLine({ check }: { check: Check }) {
  const { t } = useTranslation();
  const design = useDesign();
  const size = design.layout.iconSize.md;
  const icon =
    check.state === 'done' ? (
      <CircleCheck size={size} color={colors.success.DEFAULT} strokeWidth={2.25} />
    ) : check.state === 'failed' ? (
      <CircleAlert size={size} color={colors.danger.DEFAULT} strokeWidth={2.25} />
    ) : check.state === 'checking' ? (
      <Spinner size="sm" />
    ) : (
      <Circle size={size} color={colors.foreground.subtle} strokeWidth={2} />
    );
  const help = check.problem
    ? t(`localServer.readiness.problem.${check.problem}`)
    : t(`localServer.readiness.help.${check.id}`);
  const label = t(`localServer.readiness.check.${check.id}`);
  const stateText = t(`localServer.readiness.state.${check.state}`);
  return (
    <View
      testID={`local-server-check-${check.id}`}
      accessible
      aria-label={`${label}: ${stateText}. ${help}`}
      style={{ flexDirection: 'row', gap: design.space.md }}>
      <View
        testID={`local-server-check-${check.id}-${check.state}`}
        style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        {icon}
      </View>
      <View style={{ flex: 1, gap: design.space.xxs }}>
        <Text variant="body" tone={check.state === 'todo' ? 'muted' : 'default'}>
          {label}
        </Text>
        <Text variant="caption" tone={check.state === 'failed' ? 'danger' : 'muted'}>
          {help}
        </Text>
      </View>
    </View>
  );
}
