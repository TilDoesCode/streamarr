import { ReturnTarget } from '@/navigation/return-focus';

describe('ReturnTarget', () => {
  it('hands the armed opener back exactly once', () => {
    const target = new ReturnTarget<string>();
    expect(target.take()).toBeUndefined();
    target.arm('release-1');
    expect(target.take()).toBe('release-1');
    expect(target.take()).toBeUndefined();
  });

  it('keeps only the latest opener', () => {
    const target = new ReturnTarget<boolean>();
    target.arm(false);
    target.arm(true);
    expect(target.take()).toBe(true);
  });
});
