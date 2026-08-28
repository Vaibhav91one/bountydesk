"use client";

import { Gmail, GitHubLight, OneDrive } from "developer-icons";
import { Folder } from "@phosphor-icons/react/ssr";

import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { ConfigureButton } from "../integrations/configure-button";

export type RepositoryRow = {
  id: string;
  account: string;
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
  state,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  state: string;
}) {
  return (
    <div className="flex flex-col items-start gap-4 rounded-xl border border-border/50 bg-card p-8">
      <span className="flex size-12 items-center justify-center rounded-xl border border-border/50 bg-background">
        {icon}
      </span>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2.5">
          <h2 className="text-heading text-foreground">{title}</h2>
          <Badge variant="outline">{state}</Badge>
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
  return (
    <Tabs defaultValue="repositories" className="gap-6">
      <TabsList variant="line" className="w-full justify-start gap-6 border-b border-border/50">
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

      <TabsContent value="repositories" className="flex flex-col gap-2.5">
        {repositories.length === 0 ? (
          <div className="flex flex-col items-start gap-4 rounded-xl border border-border/50 bg-card p-8">
            <p className="max-w-2xl text-body text-muted-foreground">
              No repository is connected. Installing the GitHub App is what grants access to a
              repository; signing in only says who you are.
            </p>
            <a
              href={installUrl}
              className="text-body text-brand-soft underline underline-offset-4"
            >
              Install BountyDesk on GitHub
            </a>
          </div>
        ) : null}

        {repositories.map((repo) => (
          <div
            key={repo.id}
            className="flex flex-wrap items-center gap-4 rounded-xl border border-border/50 bg-card px-4 py-3.5"
          >
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-background">
              <GitHubLight className="size-5" />
            </span>

            <div className="flex min-w-40 flex-1 flex-col gap-1">
              <span className="flex items-center gap-2.5">
                <span className="text-body font-medium text-foreground">{repo.fullName}</span>
                <Badge variant={repo.connected ? "success" : "outline"}>{repo.label}</Badge>
              </span>
              <span className="text-meta text-muted-foreground">
                {repo.hint} Target: {repo.target ?? "none bound"}.
              </span>
            </div>

            <ConfigureButton
              repoId={repo.repoId}
              configured={repo.configured}
              label={repo.configured ? "Reconfigure" : "Configure"}
            />
          </div>
        ))}
      </TabsContent>

      <TabsContent value="email">
        <Unbuilt
          icon={<Gmail className="size-6" />}
          title="Email"
          state="designed, not built"
          body="Reports sent to a BountyDesk address become reports here, with no GitHub connection
            involved. The route does not exist yet, so nothing arrives this way today."
        />
      </TabsContent>

      <TabsContent value="upload">
        <Unbuilt
          icon={<Folder className="size-6" />}
          title="File upload"
          state="designed, not built"
          body="A report pasted or uploaded straight into the console, for anything that arrived
            outside a tracker. Designed alongside email intake, and built with it."
        />
      </TabsContent>

      <TabsContent value="drive">
        <Unbuilt
          icon={<OneDrive className="size-6" />}
          title="Drive"
          state="not planned"
          body="Pulling reports out of a shared drive is not in this version. It is listed so the
            answer is on the page rather than a thing you have to go and ask about."
        />
      </TabsContent>
    </Tabs>
  );
}
