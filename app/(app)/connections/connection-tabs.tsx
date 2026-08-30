"use client";

import { Gmail, GitHubLight, OneDrive } from "developer-icons";
import { useState } from "react";
import { Folder, MagnifyingGlass } from "@phosphor-icons/react/ssr";

import { FilterTable, type TableRow } from "@/components/filter-table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import type { RepoStatus } from "@/lib/github/connections";

import { ConfigureButton } from "../integrations/configure-button";
import { RepositorySheet } from "./repository-sheet";

const COLUMNS = [
  { key: "repository", label: "Repository", width: "1.6fr" },
  { key: "target", label: "Bound target", width: "1fr" },
  { key: "status", label: "Status", width: "1fr" },
  // A fixed track, not a fraction. Reconfigure and Remove repository measure 111 and 156
  // with an 8 gap, and a proportional column dropped below that at this table's width and
  // stacked them. The table scrolls sideways rather than the buttons wrapping.
  { key: "action", label: "", width: "20rem", align: "end" as const, controls: true },
];

/**
 * Three groups rather than one chip per status.
 *
 * The distinction that matters is whether a report opened here would be accepted, and the
 * three ways it would not are different problems: one is ours to fix by binding a target, and
 * the others happened on GitHub and cannot be fixed from this screen.
 */
const FILTERS = [
  { key: "all", label: "All", dot: undefined },
  { key: "accepting", label: "Accepting", dot: "bg-phase-delivered" },
  { key: "unconfigured", label: "No target", dot: "bg-phase-approval" },
  { key: "blocked", label: "Blocked", dot: "bg-phase-closed" },
] as const;

function inGroup(status: RepoStatus, key: string): boolean {
  if (key === "accepting") return status === "admissible";
  if (key === "unconfigured") return status === "not-configured";
  if (key === "blocked")
    return ["archived", "disconnected", "suspended"].includes(status);
  return true;
}

export type RepositoryRow = {
  id: string;
  account: string;
  /** The raw status, which is what the chips filter on. `label` is what a person reads. */
  status: RepoStatus;
  fullName: string;
  label: string;
  hint: string;
  target: string | null;
  repoId: number;
  configured: boolean;
  connected: boolean;
};

/**
 * A tab for a channel that has a design and no route.
 *
 * It says what the channel will do and that it does not do it yet, in that order. A blank
 * panel would read as a loading failure, and a panel that described the feature without the
 * caveat would read as a promise.
 */
function Unbuilt({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col items-start gap-4 rounded-xl border border-border/50 bg-card p-8">
      <span className="flex size-12 items-center justify-center rounded-xl border border-border/50 bg-background">
        {icon}
      </span>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2.5">
          <h2 className="text-heading text-foreground">{title}</h2>
          <Badge variant="outline">Coming soon</Badge>
        </div>
        <p className="max-w-2xl text-body text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

export function ConnectionTabs({
  repositories,
  installUrl,
}: {
  repositories: RepositoryRow[];
  installUrl: string;
}) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<string>("all");
  const [open, setOpen] = useState<string | null>(null);

  const needle = query.trim().toLowerCase();
  const rows: TableRow[] = repositories.map((repo) => ({
    id: repo.id,
    // The row opens the panel. FilterTable stretches this over the row from the first cell
    // and leaves the later cells above it, so Configure configures and does not also open a
    // sheet behind itself.
    onSelect: () => setOpen(repo.id),
    hidden:
      !inGroup(repo.status, group) ||
      (needle.length > 0 &&
        !`${repo.fullName} ${repo.label} ${repo.target ?? ""}`
          .toLowerCase()
          .includes(needle)),
    cells: [
      <span key="repository" className="flex min-w-0 items-center gap-2.5">
        <GitHubLight className="size-4 shrink-0" />
        <span
          className="truncate font-medium text-foreground"
          title={repo.hint}
        >
          {repo.fullName}
        </span>
      </span>,
      <span key="target" className="min-w-0 truncate text-muted-foreground">
        {repo.target ?? "None bound"}
      </span>,
      <Badge key="status" variant={repo.connected ? "success" : "outline"}>
        {repo.label}
      </Badge>,
      <ConfigureButton
        key="action"
        repoId={repo.repoId}
        configured={repo.configured}
        label={repo.configured ? "Reconfigure" : "Configure"}
      />,
    ],
  }));

  return (
    <Tabs defaultValue="repositories" className="gap-6">
      {/* The strip scrolls, the page does not: four tabs do not fit 390px. The rule and the
          overflow live on the wrapper so the border still spans the full width and the active
          tab's underline is not clipped by the scroll box. */}
      <div className="overflow-x-auto border-b border-border/50 pb-1.5">
        <TabsList variant="line" className="w-max justify-start gap-6">
          <TabsTrigger value="repositories" className="flex-none">
            <GitHubLight /> Repositories
          </TabsTrigger>
          <TabsTrigger value="email" className="flex-none">
            <Gmail /> Email
          </TabsTrigger>
          <TabsTrigger value="upload" className="flex-none">
            <Folder /> File upload
          </TabsTrigger>
          <TabsTrigger value="drive" className="flex-none">
            <OneDrive /> Drive
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="repositories">
        {repositories.length === 0 ? (
          <div className="flex flex-col items-start gap-4 rounded-xl border border-border/50 bg-card p-8">
            <p className="max-w-2xl text-body text-muted-foreground">
              No repository is connected. Installing the GitHub App is what
              grants access to a repository; signing in only says who you are.
            </p>
            <a
              href={installUrl}
              className="text-body text-brand-soft underline underline-offset-4"
            >
              Install BountyDesk on GitHub
            </a>
          </div>
        ) : (
          // The scroller is this container, which is what lets the search bar stick: sticky
          // positions against the nearest scrolling ancestor, so a bar outside it would just
          // scroll away with the page.
          <div className="flex max-h-[70vh] flex-col overflow-y-auto">
            <div className="sticky top-0 z-20 bg-background pb-3">
              <div className="relative">
                <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search repositories"
                  aria-label="Search repositories"
                  className="h-11 border-border/50 pl-9 text-body"
                />
              </div>
            </div>

            <FilterTable
              columns={COLUMNS}
              filters={FILTERS.map((option) => ({
                key: option.key,
                label: option.label,
                dot: option.dot,
                count: repositories.filter((repo) =>
                  inGroup(repo.status, option.key),
                ).length,
              }))}
              active={group}
              onFilter={setGroup}
              rows={rows}
              label="Connected repositories"
              minWidth={880}
              empty={<>No repository matches.</>}
            />

            <RepositorySheet
              repo={repositories.find((r) => r.id === open) ?? null}
              onOpenChange={(next) => !next && setOpen(null)}
            />
          </div>
        )}
      </TabsContent>

      <TabsContent value="email">
        <Unbuilt
          icon={<Gmail className="size-6" />}
          title="Email"
          body="Reports sent to a BountyDesk address become reports here, with no GitHub connection
            involved. The route does not exist yet, so nothing arrives this way today."
        />
      </TabsContent>

      <TabsContent value="upload">
        <Unbuilt
          icon={<Folder className="size-6" />}
          title="File upload"
          body="A report pasted or uploaded straight into the console, for anything that arrived
            outside a tracker. Designed alongside email intake, and built with it."
        />
      </TabsContent>

      <TabsContent value="drive">
        <Unbuilt
          icon={<OneDrive className="size-6" />}
          title="Drive"
          body="Pulling reports out of a shared drive is not in this version. It is listed so the
            answer is on the page rather than a thing you have to go and ask about."
        />
      </TabsContent>
    </Tabs>
  );
}
