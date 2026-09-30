import { Image } from 'expo-image';
import { StyleSheet, type ImageStyle } from 'react-native';

// Aurora ambient: blur 70 px, saturate 1.5, brightness .55 (the dim is applied by the scrim above).
const FILTER = { filter: 'blur(70px) saturate(1.5)', transform: [{ scale: 1.15 }] } as ImageStyle;

export function AmbientImage({ uri }: { uri: string }) {
  return (
    <Image
      source={{ uri }}
      style={[StyleSheet.absoluteFill, FILTER]}
      contentFit="cover"
      transition={0}
      accessible={false}
    />
  );
}
