import {
  LayoutDashboard,
  Database,
  Server,
  SlidersHorizontal,
  Search,
  PlayCircle,
  Radio,
  Settings,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

// The full §9.1 view set. Dashboard + Settings + Login ship in M4a; the remaining views are
// scaffolded as routed placeholders so the shell nav is complete and each lands incrementally.
export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/indexers", label: "Indexers", icon: Database },
  { to: "/providers", label: "Usenet Providers", icon: Server },
  { to: "/profiles", label: "Quality Profiles", icon: SlidersHorizontal },
  { to: "/search", label: "Search / Debug", icon: Search },
  { to: "/playback", label: "Playback Preview", icon: PlayCircle },
  { to: "/sessions", label: "Sessions", icon: Radio },
  { to: "/settings", label: "Settings", icon: Settings },
];
