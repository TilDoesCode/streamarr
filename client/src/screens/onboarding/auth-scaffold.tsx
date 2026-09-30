import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { ArrowLeft, Server } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AmbientBackdrop } from '@/components/ambient';

import { displayServerUrl } from '@/api/server-url';
import { FocusGuide } from '@/components/focus';
import { IconButton } from '@/components/ui/icon-button';
import { Text } from '@/components/ui/text';
import { useScreenTitle } from '@/navigation/screen-title';
import { ShellDesign } from '@/shell/shell-design';
import { useShell } from '@/shell/use-shell';
import { colors, useDesign } from '@/theme';

export type AuthScaffoldProps = {
  title: string;
  subtitle?: string;
  /** Server the step belongs to (shown as a chip under the title). */
  server?: { name: string; url: string };
  children: ReactNode;
  testID?: string;
};

/** Onboarding step layout. Handheld/web: one centred column. TV: title left, form top-right (clear of the IME). */
export function AuthScaffold(props: AuthScaffoldProps) {
  return (
    <ShellDesign>
      <AuthLayout {...props} />
    </ShellDesign>
  );
}

function AuthLayout({ title, subtitle, server, children, testID }: AuthScaffoldProps) {
  const design = useDesign();
  const { t } = useTranslation();
  useScreenTitle(title);
  const router = useRouter();
  const { large, s } = useShell();
  const split = design.isTV || large;
  const logo = design.px(split ? 56 : 48);
  const back =
    !design.isTV && router.canGoBack() ? (
      <IconButton
        icon={ArrowLeft}
        variant="ghost"
        accessibilityLabel={t('common.back')}
        onPress={() => router.back()}
        style={{ alignSelf: 'flex-start', marginLeft: -design.space.sm }}
      />
    ) : null;
  const heading = (
    <View style={{ gap: design.space.md }}>
      {split ? back : null}
      <Image
        source={require('@/assets/images/splash-icon.png')}
        style={{ width: logo, height: logo }}
        contentFit="contain"
        accessibilityIgnoresInvertColors
      />
      <Text variant={split ? 'display' : 'title'}>{title}</Text>
      {subtitle ? (
        <Text variant="body" tone="muted">
          {subtitle}
        </Text>
      ) : null}
      {server ? <ServerChip name={server.name} url={server.url} /> : null}
    </View>
  );

  if (split) {
    // TV: heading and form high on the screen (clear of the IME); web: both centred on one vertical axis.
    const centred = !design.isTV;
    const top = centred ? design.px(40) : design.layout.edgeVertical + design.px(40);
    return (
      <View
        testID={testID}
        style={{
          flex: 1,
          flexDirection: 'row',
          gap: design.px(56),
          paddingHorizontal: s(96),
          backgroundColor: colors.background,
          overflow: 'hidden',
        }}>
        <AmbientBackdrop />
        <View
          style={{
            width: '42%',
            paddingTop: top,
            paddingBottom: centred ? top : 0,
            justifyContent: centred ? 'center' : 'flex-start',
          }}>
          {heading}
        </View>
        <ScrollView
          style={{ flex: 1 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            flexGrow: centred ? 1 : undefined,
            justifyContent: centred ? 'center' : 'flex-start',
            paddingTop: top,
            paddingBottom: centred ? top : design.px(200),
            // Room for the focus lift (scale) and ring of full-width buttons; ScrollView clips its sides.
            paddingHorizontal: design.px(28),
            gap: design.space.lg,
          }}>
          <FocusGuide remember={false}>
            <View style={{ gap: design.space.lg }}>{children}</View>
          </FocusGuide>
        </ScrollView>
      </View>
    );
  }

  return (
    <SafeAreaView testID={testID} style={{ flex: 1, backgroundColor: colors.background }}>
      <AmbientBackdrop />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          padding: design.layout.gutter,
        }}>
        <View
          style={{
            width: '100%',
            maxWidth: design.px(440),
            alignSelf: 'center',
            gap: design.space['2xl'],
          }}>
          {back}
          {heading}
          <View style={{ gap: design.space.lg }}>{children}</View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

export function ServerChip({ name, url }: { name: string; url: string }) {
  const design = useDesign();
  const { t } = useTranslation();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: design.space.sm,
        paddingVertical: design.space.xs,
        paddingHorizontal: design.space.md,
        borderRadius: design.radius.full,
        backgroundColor: colors.surface.raised,
        maxWidth: '100%',
      }}>
      <Server size={design.layout.iconSize.sm} color={colors.foreground.muted} />
      <Text variant="caption" tone="muted" numberOfLines={1} selectable={Platform.OS === 'web'}>
        {t('onboarding.serverChip', { name, url: displayServerUrl(url) })}
      </Text>
    </View>
  );
}
