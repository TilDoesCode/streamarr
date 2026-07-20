import { useState } from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Menu, LogOut, Play } from "lucide-react";
import { NAV_ITEMS } from "./nav";
import { ThemeToggle } from "./theme-toggle";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3" aria-label="Primary">
      {NAV_ITEMS.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          onClick={onNavigate}
          activeOptions={{ exact: item.to === "/" }}
          className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          activeProps={{
            className: "bg-accent text-accent-foreground",
            "aria-current": "page",
          }}
        >
          <item.icon className="size-4 shrink-0" />
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

function Brand() {
  return (
    <div className="flex h-14 items-center gap-2 border-b px-5">
      <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <Play className="size-4 fill-current" />
      </span>
      <span className="text-lg font-semibold tracking-tight">Streamarr</span>
    </div>
  );
}

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { session, logout } = useAuth();
  const title =
    useRouterState({
      select: (s) => {
        const path = s.location.pathname;
        if (path.startsWith("/sessions/")) return "Stream telemetry";
        return NAV_ITEMS.find((i) => (i.to === "/" ? path === "/" : path.startsWith(i.to)))?.label;
      },
    }) ?? "Streamarr";
  // Some screens (e.g. the Search / Debug playground) render a wide, multi-column table that
  // needs the full viewport width. Let those breathe instead of the comfortable-reading cap.
  const wideLayout = useRouterState({
    select: (s) =>
      ["/search", "/library", "/ephemeral", "/history"].some((path) =>
        s.location.pathname.startsWith(path),
      ) || s.location.pathname.startsWith("/sessions/"),
  });

  return (
    <div className="min-h-[100dvh] bg-background">
      {/* Desktop / tablet sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r bg-card md:flex">
        <Brand />
        <SidebarContent />
        <SidebarFooter username={session?.username} role={session?.role} onLogout={logout} />
      </aside>

      <div className="flex min-h-[100dvh] flex-col md:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu">
                <Menu />
              </Button>
            </DialogTrigger>
            <DialogContent
              className="left-0 top-0 h-[100dvh] max-h-none w-[min(18rem,calc(100%-3rem))] max-w-none translate-x-0 translate-y-0 grid-rows-[auto_1fr_auto] gap-0 overflow-hidden rounded-none border-y-0 border-l-0 p-0 md:hidden"
            >
              <div className="flex h-14 items-center border-b px-5">
                <DialogTitle className="text-lg">Streamarr</DialogTitle>
                <DialogDescription className="sr-only">
                  Primary navigation and account controls
                </DialogDescription>
              </div>
              <SidebarContent onNavigate={() => setMobileOpen(false)} />
              <SidebarFooter
                username={session?.username}
                role={session?.role}
                onLogout={() => {
                  setMobileOpen(false);
                  logout();
                }}
              />
            </DialogContent>
          </Dialog>
          <h1 className="text-base font-semibold">{title}</h1>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
          </div>
        </header>

        <main className="min-w-0 flex-1 p-4 sm:p-6">
          <div className={cn("mx-auto w-full", wideLayout ? "max-w-none" : "max-w-5xl")}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

function SidebarFooter({
  username,
  role,
  onLogout,
}: {
  username?: string;
  role?: string;
  onLogout: () => void;
}) {
  return (
    <div className="border-t p-3">
      <div className="mb-2 px-2">
        <p className="truncate text-sm font-medium">{username ?? "—"}</p>
        <p className={cn("text-xs capitalize text-muted-foreground")}>{role ?? ""}</p>
      </div>
      <Button variant="ghost" size="sm" className="w-full justify-start" onClick={onLogout}>
        <LogOut className="size-4" />
        Sign out
      </Button>
    </div>
  );
}
