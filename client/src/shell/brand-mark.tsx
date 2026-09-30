import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import { Text } from '@/components/ui/text';
import { colors, fonts } from '@/theme';

import { useShell } from './use-shell';

const TRIANGLE =
  'M24 24.1 C24 18.8 29.8 15.5 34.4 18.2 L78.2 44 C82.7 46.7 82.7 53.3 78.2 56 L34.4 81.8 C29.8 84.5 24 81.2 24 75.9 Z';

/** The Streamarr play mark (brand.html), gradient-filled. */
export function BrandMark({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <Defs>
        <LinearGradient id="brand-mark" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={colors.brand.from} />
          <Stop offset="0.55" stopColor={colors.brand.mid} />
          <Stop offset="1" stopColor={colors.brand.to} />
        </LinearGradient>
      </Defs>
      <Path d={TRIANGLE} fill="url(#brand-mark)" />
    </Svg>
  );
}

/** Large shell corner brand (mark + wordmark) for screens without the rail: profile picker. */
export function ShellBrand() {
  const { t } = useTranslation();
  const { large, s } = useShell();
  if (!large) return null;
  return (
    <View
      testID="shell-brand"
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        top: s(40),
        left: s(64),
        flexDirection: 'row',
        alignItems: 'center',
        gap: s(14),
      }}>
      <BrandMark size={s(56)} />
      <Text
        style={{
          fontFamily: fonts.displayBold,
          fontSize: s(30),
          lineHeight: s(36),
          letterSpacing: -s(0.5),
          color: colors.foreground.DEFAULT,
        }}>
        {t('app.name')}
      </Text>
    </View>
  );
}
