import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@/lib/theme";
import { AuthProvider } from "@/lib/auth";

/** Render a component tree with the query/theme/auth providers but no router. */
export function renderWithProviders(
  ui: ReactNode,
  options: { queryClient?: QueryClient } = {},
) {
  const queryClient =
    options.queryClient ??
    new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  const result = render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{ui}</AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { ...result, queryClient };
}
