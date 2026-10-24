import { useTranslation } from 'react-i18next';
import { View, type ViewStyle } from 'react-native';

import { Text } from '@/components/ui/text';
import { colors, fonts } from '@/theme';

import { useMyListBadge } from './queries';

/** "9+" above nine: the pill stays a dot-sized mark. */
export function badgeText(count: number): string {
  return count > 9 ? '9+' : String(count);
}

/** Accent count pill over a tab icon (rail, web top bar); nothing while there is nothing new. */
export function CountBadge({
  count,
  size,
  style,
  testID,
}: {
  count: number;
  size: number;
  style?: ViewStyle;
  testID?: string;
}) {
  const { t } = useTranslation();
  if (count <= 0) return null;
  return (
    <View
      testID={testID}
      accessibilityLabel={t('mylist.badgeLabel', { count })}
      style={[
        {
          pointerEvents: 'none',
          position: 'absolute',
          minWidth: size,
          height: size,
          paddingHorizontal: size * 0.28,
          borderRadius: size / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.accent.DEFAULT,
          borderWidth: Math.max(1, size * 0.08),
          borderColor: colors.background,
        },
        style,
      ]}>
      <Text
        style={{
          fontFamily: fonts.bodySemiBold,
          fontSize: size * 0.6,
          lineHeight: size * 0.8,
          color: colors.accent.foreground,
        }}>
        {badgeText(count)}
      </Text>
    </View>
  );
}

/** The My List tab's badge: entries with a new available episode. */
export function MyListTabBadge({ size, style }: { size: number; style?: ViewStyle }) {
  const count = useMyListBadge();
  return <CountBadge testID="mylist-badge" count={count} size={size} style={style} />;
}
