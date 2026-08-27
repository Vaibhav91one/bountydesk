import { CheckCircle2, CircleSlash, ExternalLink, PauseCircle, Plug, Settings2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";

import { ConfigureButton } from "./configure-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireReviewer } from "@/lib/auth/dal";
import { installUrl } from "@/lib/auth/oauth";
import {
  listConnections,
  manageRepositoriesUrl,
  type RepoStatus,
} from "@/lib/github/connections";

/** What each status means to the person reading it, not what it means to the database. */
const STATUS: Record<RepoStatus, { label: string; hint: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  admissible: {
    label: "Connected",
    hint: "Reports opened here are accepted.",
    variant: "default",
  },
  "not-configured": {
    label: "Not configured",
    hint: "Granted by the installation, but no reproduction target is bound, so reports are refused.",
    variant: "outline",
  },
  archived: {
    label: "Archived",
    hint: "The repository is archived on GitHub. Intake stays closed until it is unarchived.",
    variant: "secondary",
  },
  disconnected: {
    label: "Disconnected",
    hint: "The installation no longer grants this repository. Re-add it on GitHub to restore it.",
    variant: "secondary",
  },
  suspended: {
    label: "Suspended",
    hint: "The whole installation is suspended, so nothing under it is accepted.",
    variant: "destructive",
  },
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:gap-4">
      <dt className="w-44 shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export default async function ChannelsPage() {
  const session = await requireReviewer();
  const connections = await listConnections();

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Channels</h1>
        <p className="text-sm text-muted-foreground">
          Inbound report sources. GitHub only in the MVP. Signed in as {session.login}.
        </p>
      </header>

      {connections.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-4 pt-6">
            <p className="text-sm text-muted-foreground">
              No GitHub account is connected yet. Installing the App is what grants access to
              repositories; signing in only identifies you.
            </p>
            <Button size="sm" nativeButton={false} render={<a href={installUrl()} />}>
              <Plug /> Install BountyDesk
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {connections.map((connection) => (
        <section key={connection.installationRowId} className="flex flex-col gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2">
                <Plug className="size-4" /> {connection.accountLogin}
              </CardTitle>
              <Badge variant={connection.suspendedAt ? "destructive" : "default"}>
                {connection.suspendedAt ? "Suspended" : "App installed"}
              </Badge>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <dl className="flex flex-col gap-2">
                <Row label="Installed on">{connection.accountLogin}</Row>
                <Row label="Repositories">
                  {connection.repositories.length} granted
                </Row>
                <Row label="Permissions">Issues read and write · Metadata read</Row>
                {/* Not "last event": lifecycle_delivery has no installation key, so the time
                    of the last webhook for this account is not in the schema. */}
                <Row label="Last synced">
                  <time dateTime={connection.lastSyncedAt.toISOString()}>
                    {connection.lastSyncedAt.toISOString().replace("T", " ").slice(0, 16)} UTC
                  </time>
                </Row>
              </dl>

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  nativeButton={false}
                  render={<a href={manageRepositoriesUrl(connection.installationId)} />}
                >
                  <Settings2 /> Manage repositories <ExternalLink className="size-3" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                GitHub owns which repositories the App can see, so that button leaves for
                GitHub. Changes come back on the installation_repositories webhook.
              </p>
            </CardContent>
          </Card>

          {connection.repositories.map((repo) => {
            const status = STATUS[repo.status];
            return (
              <Card key={repo.connectedRepositoryId} className="ml-0 sm:ml-6">
                <CardHeader className="flex flex-row items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    {repo.status === "admissible" ? (
                      <CheckCircle2 className="size-4" />
                    ) : repo.status === "suspended" ? (
                      <PauseCircle className="size-4" />
                    ) : (
                      <CircleSlash className="size-4" />
                    )}
                    {repo.fullName}
                  </CardTitle>
                  <Badge variant={status.variant}>{status.label}</Badge>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <dl className="flex flex-col gap-2">
                    <Row label="Intake repository">{repo.fullName}</Row>
                    <Row label="Reproduction target">
                      {repo.targetProfileName ?? (
                        <span className="text-muted-foreground">none bound</span>
                      )}
                    </Row>
                    <Row label="Verdict destination">
                      Reply to the originating issue, after a human approves it
                    </Row>
                  </dl>

                  <p className="text-xs text-muted-foreground">{status.hint}</p>

                  <ConfigureRepository
                    repoId={repo.repoId}
                    configured={repo.targetProfileName !== null}
                  />
                </CardContent>
              </Card>
            );
          })}
        </section>
      ))}

      <form action="/api/auth/logout" method="post">
        <Button type="submit" variant="ghost" size="sm">
          Sign out
        </Button>
      </form>
    </main>
  );
}


function ConfigureRepository({ repoId, configured }: { repoId: number; configured: boolean }) {
  return <ConfigureButton repoId={repoId} label={configured ? "Reconfigure" : "Configure"} />;
}
