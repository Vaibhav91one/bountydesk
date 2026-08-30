"use client";

import { ArrowSquareOut, GitBranch, Warning } from "@phosphor-icons/react/ssr";
import { GitHubLight } from "developer-icons";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export type AccessInstallation = {
  id: string;
  accountLogin: string;
  accountType: string | null;
  suspended: boolean;
  /** Where the grant is actually edited, on GitHub. */
  settingsUrl: string;
  repositories: { fullName: string; status: string; target: string | null }[];
};

const STATUS_LABEL: Record<string, string> = {
  admissible: "Accepting reports",
  "not-configured": "No target bound",
  archived: "Archived",
  disconnected: "Grant withdrawn",
  suspended: "Installation suspended",
};

/**
 * What this app can currently reach, and where that is changed.
 *
 * It does not change it. Repository access belongs to whoever administers the GitHub account,
 * and a picker here would be describing a permission the App does not have: it cannot widen
 * its own grant, which is the point of the App model. So the dialog shows the grant as it
 * stands, per installation, and sends you to the one page that can edit it.
 *
 * What BountyDesk does control per repository is which target profile it is bound to, and that
 * is the Configure button next to this one. A repository with no profile is listed here as
 * granted and not accepting reports, because both halves are true.
 */
export function ManageAccess({
  name,
  installations,
}: {
  name: string;
  installations: AccessInstallation[];
}) {
  return (
    <Dialog>
      <DialogTrigger render={<Button size="sm" variant="outline">Manage access</Button>} />

      <DialogContent className="no-scrollbar max-h-[85vh] gap-0 overflow-y-auto p-0 sm:max-w-xl">
        <DialogHeader className="items-center gap-3 border-b border-border/50 p-6 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-background">
            <GitHubLight className="size-6" />
          </span>
          <DialogTitle>Manage access for {name}</DialogTitle>
          <DialogDescription>
            {installations.length === 1
              ? `Installed on ${installations[0].accountLogin}`
              : `Installed on ${installations.length} accounts`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 p-6">
          {installations.map((installation) => (
            <div key={installation.id} className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-body font-medium text-foreground">
                  {installation.accountLogin}
                </span>
                <Badge variant="outline">{installation.accountType ?? "Account"}</Badge>
                {installation.suspended ? (
                  <Badge variant="outline" className="text-destructive">
                    <Warning weight="fill" /> Suspended
                  </Badge>
                ) : null}
              </div>

              {installation.repositories.length === 0 ? (
                <p className="text-body text-muted-foreground">
                  This installation grants no repository.
                </p>
              ) : (
                <ul className="flex flex-col rounded-md border border-border/50 bg-background px-4">
                  {installation.repositories.map((repo) => (
                    <li
                      key={repo.fullName}
                      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border/50 py-2.5 last:border-b-0"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <GitBranch
                          aria-hidden="true"
                          className="size-3.5 shrink-0 text-muted-foreground"
                        />
                        <span className="truncate text-body text-foreground">
                          {repo.fullName}
                        </span>
                      </span>
                      <span className="text-meta text-muted-foreground">
                        {STATUS_LABEL[repo.status] ?? repo.status}
                        {repo.target ? ` · ${repo.target}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}

          <p className="text-meta text-muted-foreground">
            Which repositories are granted is decided on GitHub, not here. The App cannot widen
            its own access, which is the reason to use an App rather than a token.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/50 p-4">
          <DialogClose render={<Button size="sm" variant="ghost">Close</Button>} />
          {installations.map((installation) => (
            <Button
              key={installation.id}
              size="sm"
              nativeButton={false}
              render={
                <a href={installation.settingsUrl} target="_blank" rel="noreferrer noopener" />
              }
            >
              {installations.length === 1
                ? "Change on GitHub"
                : `Change ${installation.accountLogin}`}
              <ArrowSquareOut className="size-3.5" />
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
