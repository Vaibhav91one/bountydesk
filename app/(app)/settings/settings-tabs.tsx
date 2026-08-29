"use client";

import Link from "next/link";
import { ClockCounterClockwise, Gear, Target } from "@phosphor-icons/react/ssr";

import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatStamp } from "@/lib/format";
import type { AuditAttempt, AuditDecision, ScopeProfile } from "@/lib/settings/read";

/** Dates cross the server boundary as strings, so they are parsed back here to format. */
type Serialised<T, K extends keyof T> = Omit<T, K> & Record<K, string>;

function Panel({
  title,
  detail,
  aside,
  children,
}: {
  title: string;
  detail: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border/50 bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-heading text-foreground">{title}</h2>
          <p className="max-w-2xl text-meta text-muted-foreground">{detail}</p>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-body text-muted-foreground">{children}</p>;
}

/** A label and a value on one line, which is most of what these tabs are. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border/50 py-2.5 last:border-b-0">
      <span className="text-meta text-muted-foreground">{label}</span>
      <span className="min-w-0 text-body text-foreground">{children}</span>
    </div>
  );
}

export function SettingsTabs({
  profiles,
  decisions,
  attempts,
  login,
  userId,
}: {
  profiles: ScopeProfile[];
  decisions: Serialised<AuditDecision, "decidedAt">[];
  attempts: Serialised<AuditAttempt, "finishedAt">[];
  login: string;
  userId: number;
}) {
  return (
    <Tabs defaultValue="scope" className="gap-6">
      {/* Same strip as Connections: it scrolls, the page does not, and the rule sits on the
          wrapper so the underline is not clipped by the scroll box. */}
      <div className="overflow-x-auto border-b border-border/50 pb-1.5">
        <TabsList variant="line" className="w-max justify-start gap-6">
          <TabsTrigger value="scope" className="flex-none">
            <Target /> Scope
          </TabsTrigger>
          <TabsTrigger value="audit" className="flex-none">
            <ClockCounterClockwise /> Audit
          </TabsTrigger>
          <TabsTrigger value="general" className="flex-none">
            <Gear /> General
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="scope" className="flex flex-col gap-4">
        <Panel
          title="Authorised targets"
          detail="A report can only be reproduced against one of these. Clone, deploy and egress all take the target from the profile the server holds, never from a name the agent produced, which is why this screen reads and does not edit."
          aside={<Badge variant="outline">Read only</Badge>}
        >
          {profiles.length === 0 ? (
            <Empty>
              No target profile exists. Every report stops at analysis only until one does:
              nothing is cloned, built, deployed or probed without a profile behind it.
            </Empty>
          ) : (
            <ul className="flex flex-col gap-4">
              {profiles.map((profile) => (
                <li
                  key={profile.id}
                  className="flex flex-col rounded-md border border-border/50 bg-background p-4"
                >
                  <div className="flex flex-wrap items-center gap-2.5 pb-2">
                    <span className="text-body font-medium text-foreground">{profile.name}</span>
                    <Badge variant="outline">
                      {profile.ruleCount} scope {profile.ruleCount === 1 ? "rule" : "rules"}
                    </Badge>
                  </div>

                  <Row label="Image">{profile.imageName ?? "Not recorded"}</Row>
                  {/* break-all: 64 unbroken hex characters otherwise set the row's minimum
                      width and push the page sideways on a phone. */}
                  <Row label="Digest">
                    <span className="font-mono text-meta break-all">{profile.imageDigest}</span>
                  </Row>
                  <Row label="Snapshot">
                    {profile.snapshotId ? (
                      <span className="font-mono text-meta break-all">{profile.snapshotId}</span>
                    ) : (
                      "None built"
                    )}
                  </Row>
                  <Row label="Bound repositories">
                    {profile.repositories.length > 0
                      ? profile.repositories.join(", ")
                      : "None yet"}
                  </Row>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Rule editing"
          detail="Adding a target, changing an image digest or editing a scope rule has no screen. A profile decides what a sandbox is allowed to reach, and it does not get a form until there is an answer for who may change one and what happens to a run already bound to it."
          aside={<Badge variant="outline">Not built</Badge>}
        >
          <Empty>Profiles are seeded server-side for now.</Empty>
        </Panel>
      </TabsContent>

      <TabsContent value="audit" className="flex flex-col gap-4">
        <Panel
          title="Approval decisions"
          detail="Who signed what, and against which content hash. The table refuses UPDATE and DELETE at the database level, so this is the record rather than a view of it."
          aside={
            <Badge variant="outline">
              {decisions.length === 0 ? "None yet" : `${decisions.length} recent`}
            </Badge>
          }
        >
          {decisions.length === 0 ? (
            <Empty>Nothing has been approved or denied yet.</Empty>
          ) : (
            <ul className="flex flex-col">
              {decisions.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-col gap-1 border-b border-border/50 py-3 last:border-b-0"
                >
                  <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                    <Badge
                      variant="outline"
                      className={
                        row.decision === "APPROVED"
                          ? "text-phase-delivered"
                          : "text-destructive"
                      }
                    >
                      {row.decision === "APPROVED" ? "Approved" : "Denied"}
                    </Badge>
                    <Link
                      href={`/reports/${row.reportId}`}
                      className="min-w-0 flex-1 truncate text-body text-foreground hover:underline"
                    >
                      {row.reportTitle}
                    </Link>
                    <span className="text-meta text-muted-foreground">
                      {formatStamp(new Date(row.decidedAt))}
                    </span>
                  </div>
                  <span className="text-meta text-muted-foreground">
                    {row.reviewer} · revision {row.revision} ·{" "}
                    <span className="font-mono break-all">{row.payloadHash.slice(0, 16)}</span>
                    {row.note ? ` · ${row.note}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Delivery attempts"
          detail="Every outbound attempt, successful or not, with the status the destination returned. Also append-only."
          aside={
            <Badge variant="outline">
              {attempts.length === 0 ? "None yet" : `${attempts.length} recent`}
            </Badge>
          }
        >
          {attempts.length === 0 ? (
            <Empty>Nothing has been sent yet.</Empty>
          ) : (
            <ul className="flex flex-col">
              {attempts.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-col gap-1 border-b border-border/50 py-3 last:border-b-0"
                >
                  <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                    <Badge
                      variant="outline"
                      className={
                        row.responseStatus && row.responseStatus < 300
                          ? "text-phase-delivered"
                          : "text-destructive"
                      }
                    >
                      {row.responseStatus ?? "No response"}
                    </Badge>
                    <Link
                      href={`/reports/${row.reportId}`}
                      className="min-w-0 flex-1 truncate text-body text-foreground hover:underline"
                    >
                      {row.reportTitle}
                    </Link>
                    <span className="text-meta text-muted-foreground">
                      {formatStamp(new Date(row.finishedAt))}
                    </span>
                  </div>
                  <span className="text-meta break-all text-muted-foreground">
                    attempt {row.attempt} · {row.target}
                    {row.error ? ` · ${row.error}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </TabsContent>

      <TabsContent value="general" className="flex flex-col gap-4">
        <Panel
          title="Session"
          detail="The cookie is the credential for every surface behind the sidebar. It carries no GitHub token: repository access comes from the App installation, so there is nothing here to refresh or leak."
        >
          <div className="flex flex-col">
            <Row label="Signed in as">{login}</Row>
            <Row label="GitHub user id">
              {/* Authorization keys on the id, not the login, because a login can be renamed. */}
              <span className="font-mono text-meta">{userId}</span>
            </Row>
            <Row label="Role">Reviewer</Row>
          </div>
        </Panel>

        <Panel
          title="Appearance"
          detail="The product ships one theme. The light palette is written and unreachable; a switcher lands when there is a reason to have two."
          aside={<Badge variant="outline">Not built</Badge>}
        >
          <Empty>Dark, everywhere.</Empty>
        </Panel>

        <Panel
          title="Notifications"
          detail="Nothing tells you a report is waiting. The queue is the only signal, and it does not update on its own yet either."
          aside={<Badge variant="outline">Not built</Badge>}
        >
          <Empty>No email, no webhook, no browser notification.</Empty>
        </Panel>
      </TabsContent>
    </Tabs>
  );
}
