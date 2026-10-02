import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { DesignProvider } from '@/theme';

import { neighbourOf, SecuritySection } from '../account-security';

const mockActive = { account: { id: 'a1' }, client: { GET: () => new Promise(() => undefined) } };
jest.mock('@/accounts/accounts-provider', () => ({ useActiveAccount: () => mockActive }));

it('shows only the phone-or-web hint on TV, no password, e-mail or two-factor forms', async () => {
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
  await render(
    <DesignProvider>
      <QueryClientProvider client={new QueryClient()}>
        <SecuritySection />
      </QueryClientProvider>
    </DesignProvider>
  );
  expect(screen.getByTestId('settings-security-tv-hint')).toHaveTextContent(/phone or on the web/);
  expect(screen.queryByTestId('settings-password')).toBeNull();
  expect(screen.queryByTestId('settings-security-loading')).toBeNull();
});

it('moves focus to the neighbouring device row after a sign-out', () => {
  expect(neighbourOf(['a', 'b', 'c'], 'b')).toBe('c');
  expect(neighbourOf(['a', 'b', 'c'], 'c')).toBe('b');
  expect(neighbourOf(['a'], 'a')).toBeNull();
  expect(neighbourOf(['a'], 'x')).toBeNull();
});
