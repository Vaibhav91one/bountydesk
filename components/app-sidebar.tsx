"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import type { Icon } from "@phosphor-icons/react";
import type { ActiveReport } from "@/lib/reports/queue";
import {
  AMBIENT_REFETCH_MS,
  activeReportsQueryKey,
  fetchLive,
} from "@/lib/reports/status-query";
import {
  BookOpen,
  CaretUpDown,
  Files,
  Gear,
  House,
  PlugsConnected,
  ShareNetwork,
  SignOut,
  Tray,
} from "@phosphor-icons/react/ssr";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PhaseDot } from "@/components/phase-dot";
import { RollingIcon } from "@/components/rolling-icon";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";

/**
 * The console's navigation, following the route map in the design file.
 *
 * Every route here is built. An unbuilt one would be listed rather than hidden, disabled, and
 * labelled the way every other unavailable control in this product is: Coming soon.
 */
export const NAV: { href: string; label: string; icon: Icon }[] = [
  { href: "/home", label: "Home", icon: House },
  { href: "/board", label: "Review queue", icon: Tray },
  { href: "/reports", label: "Reports", icon: Files },
  { href: "/integrations", label: "Integrations", icon: PlugsConnected },
  { href: "/connections", label: "Connections", icon: ShareNetwork },
  { href: "/settings", label: "Settings", icon: Gear },
];

export function AppSidebar({
  reviewer,
  activeReports = [],
}: {
  reviewer: string;
  /** Reports in flight, most urgent first. Empty until there are any. */
  activeReports?: ActiveReport[];
}) {
  const pathname = usePathname();

  // Only while the list is on screen. It renders under /board and nowhere else (see the
  // SidebarMenuSub below), so polling it from the settings page would be a query per reviewer
  // per tick for something nobody can see. The layout's server-rendered copy is the seed, so
  // the list is right on arrival and this only keeps it that way.
  const { data: reports = activeReports } = useQuery({
    queryKey: activeReportsQueryKey(),
    queryFn: () => fetchLive<ActiveReport[]>("/api/active-reports"),
    initialData: activeReports,
    enabled: pathname === "/board",
    refetchInterval: AMBIENT_REFETCH_MS,
  });

  const { isMobile, setOpenMobile } = useSidebar();
  // The sidebar provider persists across navigation, so a mobile tap that doesn't clear
  // openMobile leaves the sheet and backdrop covering the destination page.
  const closeMobileSheet = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="p-3 pb-6">
        {/* The lockup carries the wordmark, so the collapsed rail swaps to the mark alone.
            logo-small is drawn for that size rather than being the lockup scaled down. */}
        <Link
          href="/home"
          className="flex h-8 items-center overflow-hidden px-3 group-data-[collapsible=icon]:w-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          <Image
            src="/logo-lockup.svg"
            alt="BountyDesk"
            width={134}
            height={20}
            priority
            className="group-data-[collapsible=icon]:hidden"
          />
          <Image
            src="/logo-small.svg"
            alt="BountyDesk"
            width={30}
            height={22}
            priority
            className="hidden group-data-[collapsible=icon]:block"
          />
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map((item) => {
                const active = pathname === item.href;

                return (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    isActive={active}
                    tooltip={item.label}
                    render={<Link href={item.href} onClick={closeMobileSheet} />}
                  >
                    <RollingIcon
                      icon={item.icon}
                      weight={active ? "fill" : "regular"}
                      className="size-4"
                    />
                    <span>{item.label}</span>
                  </SidebarMenuButton>

                  {/* What is in the queue, not just that a queue exists. Only under the open
                      route: five report titles under every nav item would be a second menu
                      competing with the first. SidebarMenuSub hides itself on the rail. */}
                  {item.href === "/board" && pathname === "/board" && reports.length > 0 ? (
                    <SidebarMenuSub>
                      {reports.map((report) => (
                        <SidebarMenuSubItem key={report.id}>
                          <SidebarMenuSubButton
                            size="sm"
                            render={
                              <Link
                                href={`/reports/${report.id}`}
                                onClick={closeMobileSheet}
                              />
                            }
                          >
                            <PhaseDot phase={report.phase} />
                            <span className="truncate">{report.title}</span>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  ) : null}
                </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        {/* Sign out is a POST, so the menu item submits a form that sits outside the menu. A
            menu that unmounts on click cannot contain the form it is trying to submit. */}
        <form id="sign-out" action="/api/auth/logout" method="post" className="hidden" />
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton size="lg" className="data-[popup-open]:bg-sidebar-accent">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/20 text-meta text-brand-soft">
                      {reviewer.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="grid flex-1 text-left leading-tight">
                      <span className="truncate text-body text-foreground">{reviewer}</span>
                      <span className="truncate text-meta text-muted-foreground">Reviewer</span>
                    </span>
                    <CaretUpDown className="ml-auto size-4 text-muted-foreground" />
                  </SidebarMenuButton>
                }
              />
              <DropdownMenuContent side="top" align="end" sideOffset={8} className="w-56">
                <DropdownMenuItem disabled>
                  <Gear />
                  Account settings
                </DropdownMenuItem>
                <DropdownMenuItem render={<a href="https://github.com/Vaibhav91one/bountydesk" />}>
                  <BookOpen />
                  Documentation
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {/* nativeButton, because the render target really is a <button>: Base UI assumes a
                    non-button and would otherwise add role and aria-disabled on top of one. */}
                <DropdownMenuItem nativeButton render={<button type="submit" form="sign-out" />}>
                  <SignOut />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
