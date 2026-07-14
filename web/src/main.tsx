import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { router } from "./router";
import { AuthProvider } from "./lib/auth";
import { ThemeProvider } from "./lib/theme";
import { abortAuthenticatedRequests, setUnauthorizedHandler } from "./api/client";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // Never retry auth failures — they mean "log in again", not "try harder".
        if (error instanceof Error && "status" in error && (error as { status: number }).status === 401) {
          return false;
        }
        return failureCount < 2;
      },
      staleTime: 10_000,
    },
  },
});

function resetAuthenticatedUi() {
  // Cancel requests before dropping their cached admin data. Navigating unmounts playback,
  // which also stops any active media request immediately.
  abortAuthenticatedRequests();
  void queryClient.cancelQueries();
  queryClient.clear();
  void router.navigate({ to: "/login", replace: true });
}

// A 401 anywhere clears the session (in the fetch layer) and bounces to login (BRIEF §9).
setUnauthorizedHandler(resetAuthenticatedUi);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider onSignedOut={resetAuthenticatedUi}>
          <RouterProvider router={router} />
          <Toaster richColors closeButton position="top-right" />
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
