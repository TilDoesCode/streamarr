import { useNavigation } from 'expo-router';
import { useEffect, useEffectEvent, useRef } from 'react';
import { Platform } from 'react-native';

/** One-shot target handed back when the screen regains focus (e.g. after the player). */
export class ReturnTarget<T> {
  private value: T | undefined;

  arm(value: T): void {
    this.value = value;
  }

  take(): T | undefined {
    const value = this.value;
    this.value = undefined;
    return value;
  }
}

/** TV: returns `arm`; the armed value is passed to `onReturn` once the screen is focused again. */
export function useReturnTarget<T>(onReturn: (value: T) => void): (value: T) => void {
  const navigation = useNavigation();
  const target = useRef(new ReturnTarget<T>());
  const handle = useEffectEvent(onReturn);
  useEffect(
    () =>
      navigation.addListener('focus', () => {
        const value = target.current.take();
        if (value !== undefined) handle(value);
      }),
    [navigation]
  );
  return (value: T) => {
    if (Platform.isTV) target.current.arm(value);
  };
}
