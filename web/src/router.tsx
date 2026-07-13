import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { getToken } from "@/api/token";
import { AppShell } from "@/components/app-shell";
import { LoginPage } from "@/pages/login";
import { DashboardPage } from "@/pages/dashboard";
import { SettingsPage } from "@/pages/settings";
import { IndexersPage } from "@/pages/indexers";
import { ProvidersPage } from "@/pages/providers";
import { ProfilesPage } from "@/pages/profiles";
import { SearchPage } from "@/pages/search";
import { PlaybackPage } from "@/pages/playback";
import { SessionsPage } from "@/pages/sessions";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  beforeLoad: () => {
    // Already signed in? Skip the login screen.
    if (getToken()) throw redirect({ to: "/" });
  },
  component: LoginPage,
});

// Authenticated layout: the guard (BRIEF §9) redirects unauthenticated users to /login,
// preserving where they were headed so they land there after signing in.
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: ({ location }) => {
    if (!getToken()) {
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
  },
  component: AppShell,
});

const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: DashboardPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  component: SettingsPage,
});

const indexersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/indexers",
  component: IndexersPage,
});

const providersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/providers",
  component: ProvidersPage,
});

const profilesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/profiles",
  component: ProfilesPage,
});

const searchRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/search",
  component: SearchPage,
});

// The debug playground hands a resolved release to the preview via ?releaseId=…
const playbackRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/playback",
  validateSearch: (search: Record<string, unknown>): { releaseId?: string } => ({
    releaseId: typeof search.releaseId === "string" ? search.releaseId : undefined,
  }),
  component: PlaybackPage,
});

const sessionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/sessions",
  component: SessionsPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    dashboardRoute,
    settingsRoute,
    indexersRoute,
    providersRoute,
    profilesRoute,
    searchRoute,
    playbackRoute,
    sessionsRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
