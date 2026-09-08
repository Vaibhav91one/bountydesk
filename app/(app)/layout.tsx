import { cookies } from "next/headers";

import { AppSidebar } from "@/components/app-sidebar";
import { CurrentPage } from "@/components/current-page";
import { QueryProvider } from "@/components/query-provider";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { requireReviewer } from "@/lib/auth/dal";
import { listActiveReports } from "@/lib/reports/queue";

/**
 * The gate for every signed-in surface, and the shell they all sit in.
 *
 * The check lives here rather than in each page so a new route under this group is protected
 * by existing. Server actions do not run layouts, so each action still re-checks for itself.
 */
export default async function ConsoleLayout({ children }: LayoutProps<"/">) {
  const session = await requireReviewer();
  // The trigger already writes this cookie; without reading it back the rail sprang open
  // again on every navigation.
  const collapsed = (await cookies()).get("sidebar_state")?.value === "false";
  // One indexed query per console page load. The sidebar is rendered by this layout, so there
  // is nowhere lower to put it without making every page fetch it for itself.
  const activeReports = await listActiveReports(5);

  return (
    <QueryProvider>
      <SidebarProvider defaultOpen={!collapsed}>
        <AppSidebar reviewer={session.login} activeReports={activeReports} />
        <SidebarInset>
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-1 h-4" />
            <CurrentPage />
          </header>
          {children}
        </SidebarInset>
      </SidebarProvider>
    </QueryProvider>
  );
}
