import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { PlayCircle, Radio, Search } from "lucide-react";
import { getToken } from "@/api/token";
import { AppShell } from "@/components/app-shell";
import { LoginPage } from "@/pages/login";
import { DashboardPage } from "@/pages/dashboard";
import { SettingsPage } from "@/pages/settings";
import { IndexersPage } from "@/pages/indexers";
import { ProvidersPage } from "@/pages/providers";
import { ProfilesPage } from "@/pages/profiles";
import { Placeholder } from "@/pages/placeholder";

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
  component: () => (
    <Placeholder
      title="Search / Debug"
      icon={Search}
      description="The ranker-tuning playground: every release from /debug/search with parsed fields, per-rule score breakdown, and rejection reasons."
    />
  ),
});

const playbackRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/playback",
  component: () => (
    <Placeholder
      title="Playback Preview"
      icon={PlayCircle}
      description="Play a resolved stream in a plain HTML5 <video> — the architectural canary that proves the API works with Jellyfin absent."
    />
  ),
});

const sessionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/sessions",
  component: () => (
    <Placeholder
      title="Sessions"
      icon={Radio}
      description="Live sessions: bytes served, NNTP connections held, originating front-end, and force-close."
    />
  ),
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
