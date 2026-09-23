import { Globe, House, ListTree, PenLine, UserRound, type LucideIcon } from "lucide-react";

import type { AppSidebarNavItem } from "./app-sidebar.constants";

export type PrimaryNavId = "home" | "writing" | "outline" | "characters" | "world";

const PRIMARY_NAV_IDS: readonly PrimaryNavId[] = [
  "home",
  "writing",
  "outline",
  "characters",
  "world",
];

const NAV_ICONS: Record<PrimaryNavId, LucideIcon> = {
  home: House,
  writing: PenLine,
  outline: ListTree,
  characters: UserRound,
  world: Globe,
};

export function resolveWritingHref(recentProjectId: string | undefined): string {
  return recentProjectId ? `/projects/${recentProjectId}` : "/";
}

export function isPrimaryNavActive(id: PrimaryNavId, pathname: string): boolean {
  switch (id) {
    case "home":
      return pathname === "/";
    case "writing":
      return pathname.startsWith("/projects/");
    case "outline":
      return pathname === "/outline" || pathname.startsWith("/outline/");
    case "characters":
      return pathname.startsWith("/characters");
    case "world":
      return pathname.startsWith("/world-info");
  }
}

export interface BuildPrimaryNavItemsInput {
  pathname: string;
  recentProjectId: string | undefined;
  labels: Record<PrimaryNavId, string>;
}

export function buildPrimaryNavItems({
  pathname,
  recentProjectId,
  labels,
}: BuildPrimaryNavItemsInput): AppSidebarNavItem[] {
  const hrefs: Record<PrimaryNavId, string> = {
    home: "/",
    writing: resolveWritingHref(recentProjectId),
    outline: "/outline",
    characters: "/characters",
    world: "/world-info",
  };

  return PRIMARY_NAV_IDS.map((id) => ({
    id,
    label: labels[id],
    href: hrefs[id],
    icon: NAV_ICONS[id],
    active: isPrimaryNavActive(id, pathname),
  }));
}
