import { Image } from 'expo-image';
import { StyleSheet } from 'react-native';

/** Native: expo-image blur on a small rendition (decoded once, no runtime blur per frame). */
export function AmbientImage({ uri }: { uri: string }) {
  return (
    <Image
      source={{ uri }}
      style={StyleSheet.absoluteFill}
      contentFit="cover"
      blurRadius={24}
      cachePolicy="memory-disk"
      transition={0}
      accessible={false}
    />
  );
}
