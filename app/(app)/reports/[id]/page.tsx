import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "@phosphor-icons/react/ssr";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { requireReviewer } from "@/lib/auth/dal";
import { isReportId, readCase } from "@/lib/reports/case";
import { caseLiveView } from "@/lib/reports/case-view";

import { CaseApproval } from "./case-approval";
import { CaseRealtimeBadges } from "./case-realtime-badges";
import { CaseView } from "./case-view";

export const metadata = { title: "Case file · BountyDesk" };

/**
 * A link out to GitHub, or the same text unlinked.
 *
 * The href is null whenever the destination cannot be built honestly: an email report has no
 * issue, a repository we no longer hold has no owner or name. Rendering an anchor to a URL
 * assembled from half the pieces sends a reviewer somewhere that is not this report.
 */
function External({ href, children }: { href: string | null; children: React.ReactNode }) {
  if (!href) return <span className="text-foreground">{children}</span>;

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-foreground underline-offset-4 hover:text-brand-soft hover:underline"
    >
      {children}
    </a>
  );
}

/** The reporter as an avatar. The handle stays as the label and the tooltip. */
function Reporter({
  handle,
  href,
  avatarUrl,
}: {
  handle: string;
  href: string | null;
  avatarUrl: string | null;
}) {
  const badge = (
    <Avatar className="size-5">
      {/* Loaded from github.com, which is where the reviewer is already authenticated. The
          fallback covers a handle that is not a login and an image that will not load. */}
      {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
      <AvatarFallback className="text-[10px]">
        {handle.slice(0, 2).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );

  if (!href) {
    return (
      <span className="flex items-center gap-1.5 text-foreground" title={handle}>
        {badge}
        <span className="sr-only">{handle}</span>
      </span>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={handle}
      className="flex items-center gap-1.5 text-foreground hover:text-brand-soft"
    >
      {badge}
      <span className="sr-only">{handle}</span>
    </a>
  );
}

/**
 * The case file.
 *
 * This component renders the report's identity, which is fixed for the life of the report: its
 * title, who opened it, and where it came from. Everything that can change while a reviewer is
 * looking at it is below, in CaseView and CaseApproval, which share one polled read of
 * caseLiveView. The same view is built here for their initialData, so first paint is fully
 * server-rendered and nothing arrives late.
 *
 * Nothing on this page polls the server component itself any more. It used to, at 2.5s, which
 * re-ran readCase and a five second TrueForge call for markup that mostly had not changed.
 */
export default async function CaseFilePage({ params }: { params: Promise<{ id: string }> }) {
  await requireReviewer();
  const { id } = await params;

  // A uuid that does not exist and a string that is not a uuid are the same answer to a
  // reviewer, and letting the malformed one reach the database only produces a 500.
  const file = isReportId(id) ? await readCase(id) : null;
  if (!file) notFound();

  const initial = caseLiveView(file);

  return (
    <main className="flex flex-1 flex-col">
      {/* 53px on the right, so the approval button's edge meets the Open on GitHub button in
          the card below it: the page's own p-8 is 32, the card's border is 1, and its header
          pads by px-5. Written as pl/pr rather than px with an override, because two utilities
          setting the same property are resolved by stylesheet order, not by the order they
          appear in the attribute. */}
      <header className="flex flex-col gap-4 border-b border-border/50 py-7 pl-8 pr-[53px]">
        <Link
          href="/board"
          className="flex w-fit items-center gap-2 text-meta text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Review queue
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2.5">
            {/* GitHub's shape: the title, then its number in the same line at lower
                contrast. The number is part of the identity, not a separate field. */}
            <h1 className="text-title text-foreground">
              {file.title}
              {file.issueNumber ? (
                <span className="ml-2 font-normal text-muted-foreground">
                  #{file.issueNumber}
                </span>
              ) : null}
            </h1>

            <p className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-meta text-muted-foreground">
              <CaseRealtimeBadges reportId={file.id} initialStatus={initial} />

              <span aria-hidden="true">·</span>

              {file.reporterHandle ? (
                <>
                  {/* The avatar stands in for the name, so the name has to survive somewhere
                      a screen reader and a hover can both reach it. */}
                  <Reporter
                    handle={file.reporterHandle}
                    href={file.reporterUrl}
                    avatarUrl={file.reporterAvatarUrl}
                  />
                  <span>opened</span>
                </>
              ) : null}

              <External href={file.issueUrl}>{file.sourceLabel}</External>

              {file.repositoryFullName ? (
                <>
                  <span>in</span>
                  <External href={file.repositoryUrl}>{file.repositoryFullName}</External>
                </>
              ) : null}
            </p>
          </div>

          <CaseApproval reportId={file.id} initial={initial} />
        </div>
      </header>

      <CaseView
        reportId={file.id}
        initial={initial}
        issueUrl={file.issueUrl}
        channel={file.channel}
        repositoryFullName={file.repositoryFullName}
      />
    </main>
  );
}
