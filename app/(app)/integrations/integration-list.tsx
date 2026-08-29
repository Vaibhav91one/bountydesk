"use client";

import { useRef, useState, useEffect } from "react";
import Link from "next/link";
import { Gmail, GitHubLight, OneDrive } from "developer-icons";
import { Folder, MagnifyingGlass } from "@phosphor-icons/react/ssr";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ICONS = {
  github: GitHubLight,
  gmail: Gmail,
  onedrive: OneDrive,
  folder: Folder,
} as const;

export type IntegrationRow = {
  id: string;
  name: string;
  detail: string;
  icon: keyof typeof ICONS;
  installed: boolean;
  action:
    | { kind: "link"; href: string; label: string }
    | { kind: "none"; label: string };
};

const FILTERS = [
  { value: "all", label: "All integrations" },
  { value: "installed", label: "Installed" },
  { value: "available", label: "Available" },
] as const;

export function IntegrationList({ rows }: { rows: IntegrationRow[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["value"]>("all");
  const search = useRef<HTMLInputElement>(null);

  // "/" jumps to the search box, the way it does in the repositories and issues lists people
  // arrive here from. Ignored while a field already has focus so it can still be typed.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      search.current?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const needle = query.trim().toLowerCase();
  const visible = rows.filter((row) => {
    if (filter === "installed" && !row.installed) return false;
    if (filter === "available" && row.installed) return false;
    if (!needle) return true;
    return `${row.name} ${row.detail}`.toLowerCase().includes(needle);
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={search}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search integrations"
            aria-label="Search integrations"
            className="h-11 border-border/50 pr-11 pl-9 text-body"
          />
          <kbd className="pointer-events-none absolute top-1/2 right-3 flex size-5 -translate-y-1/2 items-center justify-center rounded bg-muted text-meta text-muted-foreground">
            /
          </kbd>
        </div>

        {/* items is what teaches the trigger to print "All integrations" rather than the raw
            value it is storing. */}
        <Select
          items={FILTERS as unknown as { label: string; value: string }[]}
          value={filter}
          onValueChange={(value) => setFilter(value as typeof filter)}
        >
          <SelectTrigger aria-label="Filter integrations" className="h-11 min-w-52 border-border/50 text-body">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILTERS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-xl border border-border/50 bg-card px-5 py-8 text-center text-body text-muted-foreground">
          Nothing matches {query ? `“${query}”` : "this filter"}.
        </p>
      ) : null}

      <ul className="flex flex-col gap-2.5">
        {visible.map((row) => {
          const Icon = ICONS[row.icon];
          return (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-4 rounded-xl border border-border/50 bg-card px-4 py-3.5"
            >
              <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-background">
                <Icon className="size-5" />
              </span>

              <div className="flex min-w-40 flex-1 flex-col">
                <span className="text-body font-medium text-foreground">{row.name}</span>
                <span className="text-meta text-muted-foreground">{row.detail}</span>
              </div>

              {row.action.kind === "link" ? (
                <Button
                  size="sm"
                  variant="outline"
                  nativeButton={false}
                  // An in-app route goes through Link so it navigates client-side; GitHub's
                  // own settings pages are a real departure and get a plain anchor.
                  render={
                    row.action.href.startsWith("/") ? (
                      <Link href={row.action.href} />
                    ) : (
                      <a href={row.action.href} />
                    )
                  }
                >
                  {row.action.label}
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled title={row.detail}>
                  {row.action.label}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
