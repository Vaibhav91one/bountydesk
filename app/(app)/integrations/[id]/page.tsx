import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowSquareOut, CaretRight } from "@phosphor-icons/react/ssr";
import { Gmail, GitHubLight, OneDrive } from "developer-icons";
import { Folder } from "@phosphor-icons/react/ssr";

import { RollingIcon } from "@/components/rolling-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requireReviewer } from "@/lib/auth/dal";
import { appListingUrl, installationSettingsUrl, installUrl } from "@/lib/auth/oauth";
import { formatStamp } from "@/lib/format";
import { listConnections } from "@/lib/github/connections";
import { findIntegration, INTEGRATIONS, type IntegrationIcon } from "../catalog";

import { ManageAccess, type AccessInstallation } from "./manage-access";

const ICONS = {
  github: GitHubLight,
  gmail: Gmail,
  onedrive: OneDrive,
  folder: Folder,
} as const satisfies Record<IntegrationIcon, unknown>;

export function generateStaticParams() {
  return INTEGRATIONS.map((integration) => ({ id: integration.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const integration = findIntegration((await params).id);
  return { title: `${integration?.name ?? "Integration"} · BountyDesk` };
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border/50 py-3 last:border-b-0">
      <span className="text-meta text-muted-foreground">{label}</span>
      <span className="min-w-0 text-body text-foreground">{children}</span>
    </div>
  );
}

function Out({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1.5 text-body text-brand-soft underline-offset-4 hover:underline"
    >
      {children}
      <ArrowSquareOut aria-hidden="true" className="size-3.5" />
    </a>
  );
}

/**
 * One integration, in full.
 *
 * The catalogue supplies what the integration is; this page supplies what is true of it right
 * now, and the two are kept apart on purpose. Every figure on the right comes from the
 * database or the App's own configuration. Where there is nothing to report, the row says so
 * rather than being filled in to make the panel look finished.
 */
export default async function IntegrationPage({ params }: { params: Promise<{ id: string }> }) {
  await requireReviewer();
  const integration = findIntegration((await params).id);
  if (!integration) notFound();

  const Icon = ICONS[integration.icon];
  // Only GitHub has anything installed to read. The other three have no connection model at
  // all, which is the honest reason their panels are shorter rather than emptier.
  const connections = integration.id === "github" ? await listConnections() : [];
  const live = connections.filter((connection) => !connection.suspendedAt);
  const repositories = live.flatMap((connection) => connection.repositories);
  const admissible = repositories.filter((repo) => repo.status === "admissible");
  const installed = connections.length > 0;

  const access: AccessInstallation[] = connections.map((connection) => ({
    id: connection.installationRowId,
    accountLogin: connection.accountLogin,
    accountType: connection.accountType,
    suspended: connection.suspendedAt !== null,
    settingsUrl: installationSettingsUrl(
      connection.installationId,
      connection.accountType,
      connection.accountLogin,
    ),
    repositories: connection.repositories.map((repo) => ({
      fullName: repo.fullName,
      status: repo.status,
      target: repo.targetProfileName,
    })),
  }));

  return (
    <main className="flex flex-1 flex-col">
      <header className="flex flex-col gap-5 border-b border-border/50 px-8 py-7">
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-meta">
          <Link href="/integrations" className="text-muted-foreground hover:text-foreground">
            Integrations
          </Link>
          <CaretRight aria-hidden="true" className="size-3 text-muted-foreground" />
          <span className="text-foreground">{integration.name}</span>
        </nav>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-background">
              <Icon className="size-5" />
            </span>
            <h1 className="text-title text-foreground">{integration.name}</h1>
            {integration.built ? (
              installed ? (
                <Badge variant="success">Installed</Badge>
              ) : (
                <Badge variant="outline">Not installed</Badge>
              )
            ) : (
              <Badge variant="outline">{integration.status ?? "Not built"}</Badge>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {integration.id === "github" ? (
              <>
                {/* Configure is the repository list, because what there is to configure on a
                    repository is which target profile it is bound to. */}
                <Button
                  size="sm"
                  variant="outline"
                  nativeButton={false}
                  render={<Link href="/connections" />}
                >
                  Configure
                </Button>
                {installed ? <ManageAccess name={integration.name} installations={access} /> : null}
                <Button size="sm" nativeButton={false} render={<a href={installUrl()} />}>
                  <RollingIcon icon={GitHubLight} className="size-4" />
                  {installed ? "Add installation" : "Install"}
                </Button>
              </>
            ) : null}
          </div>
        </div>

        <p className="max-w-3xl text-body text-muted-foreground">{integration.tagline}</p>
      </header>

      <div className="grid gap-8 p-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex flex-col gap-7">
          {integration.sections.map((section) => (
            <section key={section.title} className="flex flex-col gap-3">
              <h2 className="text-heading text-foreground">{section.title}</h2>
              {section.body ? (
                <p className="max-w-3xl text-body text-muted-foreground">{section.body}</p>
              ) : null}
              {section.bullets ? (
                <ul className="flex max-w-3xl list-disc flex-col gap-2 pl-5">
                  {section.bullets.map((bullet) => (
                    <li key={bullet} className="text-body text-muted-foreground">
                      {bullet}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}
        </div>

        <aside className="flex flex-col gap-3">
          <h2 className="text-heading text-foreground">Details</h2>
          <div className="flex flex-col rounded-xl border border-border/50 bg-card px-4">
            <Detail label="Developer">{integration.developer}</Detail>

            {integration.id === "github" ? (
              <>
                <Detail label="App">
                  <Out href={appListingUrl()}>{appListingUrl().replace("https://", "")}</Out>
                </Detail>
                <Detail label="Installations">
                  {connections.length === 0
                    ? "None"
                    : `${live.length} live${connections.length > live.length ? `, ${connections.length - live.length} suspended` : ""}`}
                </Detail>
                <Detail label="Repositories granted">{repositories.length}</Detail>
                <Detail label="Accepting reports">{admissible.length}</Detail>
                {connections.length > 0 ? (
                  <Detail label="Last change">
                    {formatStamp(
                      new Date(
                        Math.max(...connections.map((c) => c.lastSyncedAt.getTime())),
                      ),
                    )}
                  </Detail>
                ) : null}
              </>
            ) : (
              <Detail label="Status">Not built</Detail>
            )}

            {integration.links.map((link) => (
              <Detail key={link.label} label={link.label}>
                {link.external ? (
                  <Out href={link.href}>Read</Out>
                ) : (
                  <Link
                    href={link.href}
                    className="text-body text-brand-soft underline-offset-4 hover:underline"
                  >
                    Read
                  </Link>
                )}
              </Detail>
            ))}
          </div>
        </aside>
      </div>
    </main>
  );
}
