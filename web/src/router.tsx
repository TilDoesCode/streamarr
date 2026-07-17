import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { getSession } from "@/api/token";
import { AppShell } from "@/components/app-shell";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

export function safeRedirectTarget(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return undefined;
  // Return targets are created by our own route guard and are path-absolute. Reject protocol-
  // relative and absolute URLs even if a future router version starts accepting them in `to`.
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return undefined;
  try {
    const base = new URL("https://streamarr.invalid/");
    const parsed = new URL(value, base);
    if (parsed.origin !== base.origin || parsed.username || parsed.password) return undefined;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return undefined;
  }
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: safeRedirectTarget(search.redirect),
  }),
  beforeLoad: () => {
    // Already signed in? Skip the login screen.
    if (getSession()) throw redirect({ to: "/" });
  },
  component: lazyRouteComponent(() => import("@/pages/login"), "LoginPage"),
});

// Authenticated layout: the guard (BRIEF §9) redirects unauthenticated users to /login,
// preserving where they were headed so they land there after signing in.
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: ({ location }) => {
    if (!getSession()) {
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
  },
  component: AppShell,
});

const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: lazyRouteComponent(() => import("@/pages/dashboard"), "DashboardPage"),
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  component: lazyRouteComponent(() => import("@/pages/settings"), "SettingsPage"),
});

const indexersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/indexers",
  component: lazyRouteComponent(() => import("@/pages/indexers"), "IndexersPage"),
});

const providersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/providers",
  component: lazyRouteComponent(() => import("@/pages/providers"), "ProvidersPage"),
});

const profilesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/profiles",
  component: lazyRouteComponent(() => import("@/pages/profiles"), "ProfilesPage"),
});

const searchRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/search",
  component: lazyRouteComponent(() => import("@/pages/search"), "SearchPage"),
});

// Search hands a release and, when known, its owning work to the playback preview.
const playbackRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/playback",
  validateSearch: (search: Record<string, unknown>): { releaseId?: string; workId?: string } => ({
    releaseId: typeof search.releaseId === "string" ? search.releaseId : undefined,
    workId: typeof search.workId === "string" ? search.workId : undefined,
  }),
  component: lazyRouteComponent(() => import("@/pages/playback"), "PlaybackPage"),
});

const sessionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/sessions",
  component: lazyRouteComponent(() => import("@/pages/sessions"), "SessionsPage"),
});

const libraryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/library",
  component: lazyRouteComponent(() => import("@/pages/library"), "LibraryPage"),
});

const ephemeralRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/ephemeral",
  component: lazyRouteComponent(() => import("@/pages/ephemeral-files"), "EphemeralFilesPage"),
});

const historyRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/history",
  component: lazyRouteComponent(() => import("@/pages/streaming-history"), "StreamingHistoryPage"),
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
    libraryRoute,
    ephemeralRoute,
    historyRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
