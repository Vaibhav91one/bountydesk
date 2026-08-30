"use client";

import { useActionState } from "react";
import { ArrowsClockwise, Brain, Cube, Lightning, PlugsConnected, Robot } from "@phosphor-icons/react/ssr";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Drift } from "@/lib/trueforge/desired";
import type { HarnessSnapshot, Section } from "@/lib/trueforge/harness";

import { Empty, Panel, Row } from "../panel";
import { applyManagedResources, type ActionResult } from "./actions";
import { ModelProviderForm } from "./model-provider-form";
import { SandboxForm } from "./sandbox-form";

/**
 * One route, five tabs. Not five routes: each section already carries its own error, so
 * splitting them would buy nothing the read model does not give, at five times the files.
 */
export function HarnessTabs({ snapshot }: { snapshot: HarnessSnapshot }) {
  return (
    <Tabs defaultValue="models" className="gap-6">
      <div className="overflow-x-auto border-b border-border/50 pb-1.5">
        <TabsList variant="line" className="w-max justify-start gap-6">
          <TabsTrigger value="models" className="flex-none">
            <Brain /> Models
          </TabsTrigger>
          <TabsTrigger value="connectors" className="flex-none">
            <PlugsConnected /> Connectors
          </TabsTrigger>
          <TabsTrigger value="skills" className="flex-none">
            <Lightning /> Skills
          </TabsTrigger>
          <TabsTrigger value="sandbox" className="flex-none">
            <Cube /> Sandbox
          </TabsTrigger>
          <TabsTrigger value="agent" className="flex-none">
            <Robot /> Agent
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="models" className="flex flex-col gap-4">
        <Panel
          title="Configured providers"
          detail="Where the agent's model comes from. The saved agent pins openai/gpt-5-mini, so a harness with no provider registered refuses the manifest outright rather than falling back to anything."
        >
          <SectionBody section={snapshot.modelProviders}>
            {(providers) =>
              providers.length === 0 ? (
                <Empty>No provider is configured. Add one below before applying the agent.</Empty>
              ) : (
                <ul className="flex flex-col gap-4">
                  {providers.map((provider) => (
                    <li key={provider.name} className="rounded-md border border-border/50 bg-background p-4">
                      <div className="flex flex-wrap items-center gap-2.5 pb-3">
                        <span className="text-body font-medium text-foreground">{provider.name}</span>
                        <Badge variant="outline">{provider.type}</Badge>
                        <Badge variant="outline">
                          {provider.models.length} {provider.models.length === 1 ? "model" : "models"}
                        </Badge>
                      </div>
                      <SectionBody section={snapshot.catalog}>
                        {(catalog) => <ModelProviderForm provider={provider} catalog={catalog} />}
                      </SectionBody>
                    </li>
                  ))}
                </ul>
              )
            }
          </SectionBody>
        </Panel>

        <Panel
          title="Add a provider"
          detail="Picking a well-known provider prefills its model list from the harness catalog. Anything the catalog does not carry, gpt-5-mini among them, is added by id here."
        >
          <SectionBody section={snapshot.catalog}>
            {(catalog) => <ModelProviderForm catalog={catalog} />}
          </SectionBody>
        </Panel>
      </TabsContent>

      <TabsContent value="connectors" className="flex flex-col gap-4">
        <Panel
          title="MCP connectors"
          detail="publish_verdict and scope-guard, both pointed back at this app and both authenticated with a bearer secret held server-side. Applying re-registers them from the current APP_BASE_URL and SCOPE_GUARD_URL."
          aside={<ApplyButton scope="connectors" label="Apply connectors" />}
        >
          <SectionBody section={snapshot.connectors}>
            {(rows) =>
              rows.length === 0 ? (
                <Empty>The harness has no connectors registered.</Empty>
              ) : (
                <ul className="flex flex-col gap-3">
                  {rows.map((row) => (
                    <li key={row.name} className="rounded-md border border-border/50 bg-background p-4">
                      <Heading name={row.name} drift={row.drift} />
                      {row.live ? (
                        <div className="flex flex-col">
                          <Row label="URL">
                            <span className="font-mono text-meta break-all">{row.live.url}</span>
                          </Row>
                          <Row label="Auth">{row.live.authStatus}</Row>
                        </div>
                      ) : (
                        <Empty>Declared here but not registered on the harness yet.</Empty>
                      )}
                    </li>
                  ))}
                </ul>
              )
            }
          </SectionBody>
        </Panel>
      </TabsContent>

      <TabsContent value="skills" className="flex flex-col gap-4">
        <Panel
          title="Skills"
          detail="Every skills/*/SKILL.md, registered by the name in its own frontmatter. TrueForge reads a skill's content from git at the pinned ref, so an unpushed local edit is not what the agent loads."
          aside={<ApplyButton scope="skills" label="Apply skills" />}
        >
          <SectionBody section={snapshot.skills}>
            {(rows) =>
              rows.length === 0 ? (
                <Empty>The harness has no skills registered.</Empty>
              ) : (
                <ul className="flex flex-col">
                  {rows.map((row) => (
                    <li
                      key={row.name}
                      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border/50 py-2.5 last:border-b-0"
                    >
                      <span className="flex flex-wrap items-center gap-2.5">
                        <span className="text-body text-foreground">{row.name}</span>
                        <DriftBadge drift={row.drift} />
                      </span>
                      <span className="text-meta text-muted-foreground">
                        {row.live ? `${row.live.path ?? "/"} at ${row.live.ref}` : "not registered yet"}
                      </span>
                    </li>
                  ))}
                </ul>
              )
            }
          </SectionBody>
        </Panel>
      </TabsContent>

      <TabsContent value="sandbox" className="flex flex-col gap-4">
        <Panel
          title="Sandbox provider"
          detail="TrueForge's own Daytona account, which is what config.sandbox.enabled and therefore every skill in the agent manifest runs on. It is not the reproduction sandbox BountyDesk provisions itself from DAYTONA_API_KEY: two Daytona configurations, two keys, and nothing on this screen touches the other one."
          aside={
            snapshot.sandbox.ok && snapshot.sandbox.value ? (
              <Badge variant="outline">{snapshot.sandbox.value.status}</Badge>
            ) : null
          }
        >
          <SectionBody section={snapshot.sandbox}>
            {(sandbox) => (
              <div className="flex flex-col gap-4">
                {sandbox ? (
                  <div className="flex flex-col">
                    <Row label="Type">{sandbox.type}</Row>
                    {/* The only honest signal that a pasted key actually works: the harness
                        checks it against Daytona rather than storing it unverified. */}
                    <Row label="Status">{sandbox.status}</Row>
                    <Row label="Detail">{sandbox.statusReason ?? "None"}</Row>
                  </div>
                ) : (
                  <Empty>
                    No sandbox provider is configured. The agent manifest will not apply until one
                    is, because it sets config.sandbox.enabled.
                  </Empty>
                )}
                <SandboxForm sandbox={sandbox} />
              </div>
            )}
          </SectionBody>
        </Panel>
      </TabsContent>

      <TabsContent value="agent" className="flex flex-col gap-4">
        <Panel
          title="Saved agent"
          detail="Read only apart from the apply. The manifest is a committed artifact, and a form over it would make a second source of truth for the agent's instructions and its approval-gated tool list."
          aside={<ApplyButton scope="agent" label="Apply agent" />}
        >
          <SectionBody section={snapshot.agents}>
            {(rows) =>
              rows.length === 0 ? (
                <Empty>No agent is saved on the harness.</Empty>
              ) : (
                <ul className="flex flex-col gap-3">
                  {rows.map((row) => (
                    <li key={row.name} className="rounded-md border border-border/50 bg-background p-4">
                      <Heading name={row.name} drift={row.drift} />
                      {row.live ? (
                        <div className="flex flex-col">
                          <Row label="Model">{row.live.model}</Row>
                          <Row label="Connectors">{row.live.connectors.join(", ") || "None"}</Row>
                          <Row label="Skills">{row.live.skills.join(", ") || "None"}</Row>
                        </div>
                      ) : (
                        <Empty>
                          Committed here but not saved on the harness. Register a model provider
                          and a sandbox provider first, then apply.
                        </Empty>
                      )}
                    </li>
                  ))}
                </ul>
              )
            }
          </SectionBody>
        </Panel>

        <Panel
          title="Committed manifest"
          detail="agent/bountydesk.agent.json, exactly as it would be applied."
          aside={<Badge variant="outline">Read only</Badge>}
        >
          <pre className="overflow-x-auto rounded-md border border-border/50 bg-background p-4 font-mono text-meta text-muted-foreground">
            {snapshot.agentManifest}
          </pre>
        </Panel>
      </TabsContent>
    </Tabs>
  );
}

function SectionBody<T>({
  section,
  children,
}: {
  section: Section<T>;
  children: (value: T) => React.ReactNode;
}) {
  if (!section.ok) {
    return (
      <p role="alert" className="text-body text-destructive">
        {section.error}
      </p>
    );
  }
  return <>{children(section.value)}</>;
}

function Heading({ name, drift }: { name: string; drift: Drift }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 pb-2">
      <span className="text-body font-medium text-foreground">{name}</span>
      <DriftBadge drift={drift} />
    </div>
  );
}

/**
 * Drift is reported, never repaired. An unmanaged resource belongs to another project on the
 * same harness, the API has no DELETE for one, and a control offering to tidy it would be a
 * control offering to break someone else's agent.
 */
function DriftBadge({ drift }: { drift: Drift }) {
  if (drift === "unmanaged") return <Badge variant="outline">Not managed here</Badge>;
  if (drift === "missing") return <Badge variant="outline">Not applied</Badge>;
  return <Badge variant="outline">Registered</Badge>;
}

function ApplyButton({ scope, label }: { scope: "connectors" | "skills" | "agent"; label: string }) {
  const [result, action, pending] = useActionState<ActionResult | null, FormData>(
    applyManagedResources,
    null,
  );

  return (
    <form action={action} className="flex flex-col items-end gap-1.5">
      <input type="hidden" name="scope" value={scope} />
      <Button type="submit" size="sm" loading={pending}>
        <ArrowsClockwise data-icon="inline-start" />
        {label}
      </Button>
      {result?.ok ? <Badge variant="outline">Applied</Badge> : null}
      {result && !result.ok ? (
        <p role="alert" className="max-w-md text-right text-sm text-destructive">
          {result.error}
        </p>
      ) : null}
    </form>
  );
}
