import { render, type RenderOptions } from '@testing-library/react-native';
import type { ReactElement, ReactNode } from 'react';

import { ToastProvider } from '@/components/ui/toast';
import { DesignProvider } from '@/theme';

function Providers({ children }: { children: ReactNode }) {
  return (
    <DesignProvider>
      <ToastProvider>{children}</ToastProvider>
    </DesignProvider>
  );
}

/** render() inside the app's design + toast providers. */
export function renderWithProviders(ui: ReactElement, options?: RenderOptions) {
  return render(ui, { wrapper: Providers, ...options });
}
