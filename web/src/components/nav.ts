import {
  LayoutDashboard,
  Database,
  Server,
  SlidersHorizontal,
  Search,
  PlayCircle,
  Radio,
  Archive,
  TimerReset,
  History,
  Settings,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

// The full §9.1 view set: Dashboard, Indexers, Providers, Quality Profiles, Search,
// Playback Preview, Sessions, and Settings — every view is now a live route.
export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/indexers", label: "Indexers", icon: Database },
  { to: "/providers", label: "Usenet Providers", icon: Server },
  { to: "/profiles", label: "Quality Profiles", icon: SlidersHorizontal },
  { to: "/search", label: "Search", icon: Search },
  { to: "/playback", label: "Playback Preview", icon: PlayCircle },
  { to: "/sessions", label: "Sessions", icon: Radio },
  { to: "/library", label: "Cached Library", icon: Archive },
  { to: "/ephemeral", label: "Ephemeral Files", icon: TimerReset },
  { to: "/history", label: "Streaming History", icon: History },
  { to: "/settings", label: "Settings", icon: Settings },
];
