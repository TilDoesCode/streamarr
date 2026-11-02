import qrcode from 'qrcode-generator';
import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

import { colors } from '@/theme';

export type QrCodeProps = { value: string; size: number; label: string; testID?: string };

/** QR code drawn black on a white quiet zone (4 modules) so every scanner reads it. */
export function QrCode({ value, size, label, testID }: QrCodeProps) {
  const { path, count } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const modules = qr.getModuleCount();
    let d = '';
    for (let row = 0; row < modules; row++)
      for (let col = 0; col < modules; col++)
        if (qr.isDark(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`;
    return { path: d, count: modules + 8 };
  }, [value]);
  return (
    <View testID={testID} role="img" aria-label={label}>
      <Svg width={size} height={size} viewBox={`0 0 ${count} ${count}`}>
        <Rect x={0} y={0} width={count} height={count} fill={colors.qr.light} />
        <Path d={path} fill={colors.qr.dark} />
      </Svg>
    </View>
  );
}
