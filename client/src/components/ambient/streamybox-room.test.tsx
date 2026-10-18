import { render } from '@testing-library/react-native';

import { StreamyboxRoom } from './streamybox-room';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 960, height: 540, scale: 4, fontScale: 1 }),
}));

type Host = { type: string; props: Record<string, unknown>; children: Host[] | null };

function hosts(node: Host | null, type: string): Host[] {
  if (!node || typeof node !== 'object') return [];
  const own = node.type === type ? [node] : [];
  return own.concat(...(node.children ?? []).map((child) => hosts(child, type)));
}

it('rasterises the whole room 16× smaller with a spare cell', async () => {
  const tree = await render(<StreamyboxRoom />);
  const [svg] = hosts(tree.toJSON() as Host, 'RNSVGSvgView');
  expect(svg?.props).toMatchObject({ width: 61, height: 35, minX: 0, minY: 0 });
  expect(svg?.props.vbWidth).toBeCloseTo((61 * 16 * 100) / 960);
  expect(hosts(tree.toJSON() as Host, 'RNSVGMask')).toHaveLength(0);
});

it('draws only the room behind a top-right hero, revealed through one mask', async () => {
  const fades = [
    { from: { x: 0, y: 1 }, to: { x: 0, y: 0.4 } },
    { from: { x: 0, y: 0 }, to: { x: 0.6, y: 0 } },
  ];
  const tree = await render(
    <StreamyboxRoom region={{ x: 240, y: 0, width: 720, height: 330 }} fades={fades} />
  );
  const root = tree.toJSON() as Host;
  expect(hosts(root, 'RNSVGSvgView')[0]?.props).toMatchObject({ minX: 25, minY: 0 });
  const masks = hosts(root, 'RNSVGMask');
  expect(masks).toHaveLength(1);
  expect(hosts(masks[0]!, 'RNSVGRect')).toHaveLength(2);
});
