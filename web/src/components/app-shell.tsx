import { useState } from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Menu, X, LogOut, Play } from "lucide-react";
import { NAV_ITEMS } from "./nav";
import { ThemeToggle } from "./theme-toggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-1 flex-col gap-1 p-3" aria-label="Primary">
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
        return NAV_ITEMS.find((i) => (i.to === "/" ? path === "/" : path.startsWith(i.to)))?.label;
      },
    }) ?? "Streamarr";

  return (
    <div className="min-h-screen bg-background">
      {/* Desktop / tablet sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r bg-card md:flex">
        <Brand />
        <SidebarContent />
        <SidebarFooter username={session?.username} role={session?.role} onLogout={logout} />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r bg-card shadow-xl">
            <div className="flex h-14 items-center justify-between border-b px-5">
              <span className="text-lg font-semibold">Streamarr</span>
              <Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)} aria-label="Close menu">
                <X />
              </Button>
            </div>
            <SidebarContent onNavigate={() => setMobileOpen(false)} />
            <SidebarFooter username={session?.username} role={session?.role} onLogout={logout} />
          </aside>
        </div>
      )}

      <div className="flex min-h-screen flex-col md:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu />
          </Button>
          <h1 className="text-base font-semibold">{title}</h1>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6">
          <div className="mx-auto w-full max-w-5xl">
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
