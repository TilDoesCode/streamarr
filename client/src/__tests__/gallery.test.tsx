import { Stack } from 'expo-router';
import { userEvent } from '@testing-library/react-native';
import { act, renderRouter, screen } from 'expo-router/testing-library';

import { ToastProvider } from '@/components/ui/toast';
import i18n, { setLanguagePreference } from '@/i18n';
import { GalleryScreen } from '@/screens/gallery/gallery-screen';
import { DesignProvider } from '@/theme';

// expo-router/testing-library installs its own Reanimated mock, which lacks useReducedMotion and makeMutable.
const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

function TestLayout() {
  return (
    <DesignProvider>
      <ToastProvider>
        <Stack screenOptions={{ headerShown: false }} />
      </ToastProvider>
    </DesignProvider>
  );
}

const routes = { _layout: TestLayout, 'dev/gallery': GalleryScreen };

beforeEach(async () => {
  await act(async () => {
    await setLanguagePreference('en');
  });
});

it('renders every gallery section', async () => {
  // RNTL 14 render() is async; expo-router attaches getPathname to the returned promise.
  const router = renderRouter(routes, { initialUrl: '/dev/gallery' });
  await router;
  expect(router.getPathname()).toBe('/dev/gallery');
  for (const id of [
    'hero-play',
    'shelf-continue',
    'shelf-trending',
    'shelf-popular',
    'section-buttons',
    'episode-0',
    'section-overlays',
    'section-states',
    'section-episodes',
    'section-progress',
    'section-language',
    'section-formatting',
    'section-colors',
    'swatch-background',
  ]) {
    expect(screen.getByTestId(id)).toBeOnTheScreen();
  }
});

it('records the last action and switches language from the gallery', async () => {
  const user = userEvent.setup();
  await renderRouter(routes, { initialUrl: '/dev/gallery' });
  await user.press(screen.getByTestId('hero-play'));
  expect(screen.getByTestId('gallery-last-action')).toHaveTextContent('Last action: Play');

  await user.press(screen.getByTestId('language-de'));
  expect(i18n.language).toBe('de');
  expect(screen.getByTestId('language-current')).toHaveTextContent('Angezeigt wird Deutsch');
  expect(screen.getByTestId('hero-play')).toHaveAccessibleName('Abspielen');
});
