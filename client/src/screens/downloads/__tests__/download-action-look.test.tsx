import { screen } from 'expo-router/testing-library';
import type { LucideIconData } from 'lucide-react-native';
import { __iconData as download } from 'lucide-react-native/icons/download';
import { __iconData as pause } from 'lucide-react-native/icons/pause';
import { __iconData as play } from 'lucide-react-native/icons/play';
import { __iconData as rotateCcw } from 'lucide-react-native/icons/rotate-ccw';

import { clearWorld, GB, open, resetWorld, WAIT } from '@/../jest/downloads-ui-world';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

type Node = { props: { d?: string }; children: (Node | string)[] };
const iconData = (icon: LucideIconData) => icon.node.map(([, attrs]) => attrs.d);
/** The SVG paths a control draws (its icon, rendered once at rest and once focused). */
const paths = (node: Node): string[] => [
  ...new Set([
    ...(node.props.d ? [node.props.d] : []),
    ...node.children.flatMap((child) => (typeof child === 'string' ? [] : paths(child))),
  ]),
];

const sintel = { workId: 'tmdb-movie-123', meta: { title: 'Sintel' }, completedAt: null };
const SCREENS = [
  ['the Downloads list', '/downloads', (action: string) => `download-tmdb-movie-123-${action}`],
  ['the detail card', '/movie/123', (action: string) => `detail-download-${action}`],
] as const;

afterEach(() => clearWorld());

describe('a download action looks the same on every screen (▷ stays for playing)', () => {
  it.each(SCREENS)('%s: Resume is the download arrow', async (_, path, id) => {
    await resetWorld([{ ...sintel, state: 'paused', sizeBytes: 2 * GB, bytesWritten: GB / 2 }]);
    await open(path);
    const button = await screen.findByTestId(id('resume'), {}, WAIT);
    expect(button).toHaveProp('accessibilityLabel', 'Resume the download of Sintel');
    expect(paths(button as unknown as Node)).toEqual(iconData(download));
    expect(paths(button as unknown as Node)).not.toEqual(iconData(play));
  });

  it.each(SCREENS)('%s: Pause is the pause bars', async (_, path, id) => {
    await resetWorld([
      { ...sintel, state: 'downloading', sizeBytes: 2 * GB, bytesWritten: GB / 2 },
    ]);
    await open(path);
    const button = await screen.findByTestId(id('pause'), {}, WAIT);
    expect(button).toHaveProp('accessibilityLabel', 'Pause the download of Sintel');
    expect(paths(button as unknown as Node)).toEqual(iconData(pause));
  });

  it.each(SCREENS)('%s: Retry is the turning arrow', async (_, path, id) => {
    await resetWorld([
      { ...sintel, state: 'failed', error: { code: 'network', at: 0 }, sizeBytes: 2 * GB },
    ]);
    await open(path);
    const button = await screen.findByTestId(id('retry'), {}, WAIT);
    expect(button).toHaveProp('accessibilityLabel', 'Try the download of Sintel again');
    expect(paths(button as unknown as Node)).toEqual(iconData(rotateCcw));
  });
});
