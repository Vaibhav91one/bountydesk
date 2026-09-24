import type { AnyColumn } from "drizzle-orm";

import {
  and,
  connectedRepository,
  db,
  desc,
  eq,
  githubInstallation,
  inArray,
  isNull,
  or,
  sql,
  targetOnboarding,
  targetProfile,
} from "@/lib/db";
import { installUrl } from "@/lib/auth/oauth";
import { manageRepositoriesUrl } from "@/lib/github/connections";
import { grantIsLive } from "@/lib/targets/bind";
import { lookupRepositories, type RepositoryLookup } from "@/lib/targets/repository-lookup";

/**
 * A target suggestion for an email report, read off the repository links in its body.
 *
 * The body is reporter-controlled, so a link here only decides which of the reviewer's own
 * options is highlighted. It is matched against connected repositories the server already holds,
 * and binding still goes through bindTarget on an explicit click. Nothing in this file binds or
 * reproduces. Its only network use is GitHub's public repository metadata, read anonymously
 * through the shared cache in ./repository-lookup, to follow renames and to spot a fork.
 */

const MAX_BODY = 64 * 1024;
const MAX_MENTIONS = 10;

// The character before github.com may not be a letter, digit, dot or hyphen, so notgithub.com and
// evil.github.com do not match. The slash straight after it rules out github.com.evil.io.
const LINK = /(?:^|[^A-Za-z0-9.-])(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)/gi;
// GitHub's own login rule, the same one lib/reports/case.ts applies to a reporter handle.
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
// First path segments that are GitHub pages rather than accounts. Listing them keeps
// github.com/orgs/acme out of the "isn't connected" line.
const RESERVED = new Set([
  "orgs", "settings", "apps", "marketplace", "sponsors", "features", "topics",
  "collections", "notifications", "login", "search", "advisories", "enterprise",
]);

/**
 * The distinct `owner/repo` names a text links to, in order of first mention.
 *
 * Distinct case-insensitively, as GitHub treats names, but spelled the way the text first wrote
 * them: the lowercased form is only for matching, and a reviewer reads the name as the reporter
 * wrote it.
 */
export function repositoryMentions(text: string): string[] {
  const found = new Map<string, string>();
  for (const match of text.slice(0, MAX_BODY).matchAll(LINK)) {
    const owner = match[1];
    // Sentence punctuation and a clone URL's .git are not part of the name.
    const repo = match[2].replace(/\.git$/i, "").replace(/\.+$/, "");
    if (!LOGIN.test(owner) || RESERVED.has(owner.toLowerCase())) continue;
    if (!repo || repo.length > 100) continue;
    const name = `${owner}/${repo}`;
    if (!found.has(name.toLowerCase())) found.set(name.toLowerCase(), name);
    if (found.size >= MAX_MENTIONS) break;
  }
  return [...found.values()];
}

/** How far a linked repository is from being something a report can be reproduced against. */
export type MentionStatus =
  | "ready"
  | "onboarding"
  | "awaiting-approval"
  | "failed"
  | "unsupported"
  | "not-connected";

/**
 * How the connected repository stands in for a link: it is the linked repository, it is a fork of
 * it, or GitHub has no repository at the link and the only connected project with that repository
 * name is it (an upstream whose old name no longer redirects, as bkimminich/juice-shop does not).
 */
export type MatchVia = "link" | "fork" | "name";

export type MentionProgress = {
  /** The link as the report spelled it. */
  name: string;
  /** GitHub's current name for the link, when it differs from it: the repository was renamed or moved. */
  canonical: string | null;
  status: MentionStatus;
  /** The connected repository standing in for it: itself, or a fork of it. Null when none. */
  repoFullName: string | null;
  via: MatchVia | null;
  /** Why onboarding stopped, for failed and unsupported. */
  reason: string | null;
  /** The last error of an onboarding attempt that will be retried, so "building" is never shown over a failing build. */
  retrying: string | null;
  /**
   * A fork of it that exists under an account the App is installed on but is not connected yet,
   * or the repository itself when it already sits under such an account. Only looked up for the
   * link a reviewer has the Connect guide open on.
   */
  forkedAs: string | null;
};

const MAX_REASON = 240;

/**
 * An onboarding error as a person reads it. Provider errors arrive as "POST /x -> 400 {json}", and
 * the part worth reading is the JSON's message; everything is capped so one long stack trace cannot
 * fill the dialog. Shown as text, never markup.
 */
export function readableOnboardingError(error: string | null): string | null {
  if (!error) return null;
  const message = error.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)/)?.[1];
  const text = (message ?? error).replace(/\s+/g, " ").trim();
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text;
}

export type TargetSuggestion = {
  /** Linked repositories whose connected repository, or fork, has a live grant and a built target. */
  matched: {
    profileId: string;
    profileName: string;
    fullName: string;
    mention: string;
    canonical: string | null;
    via: MatchVia;
  }[];
  /** Linked repositories BountyDesk holds no usable target for, as the report spelled them. */
  unconnected: string[];
  /** Where each linked repository stands, in the order the report mentioned them. */
  progress: MentionProgress[];
  /**
   * Where a reviewer adds a repository to the App: one link per live installation, or the
   * install page when there is none. Only filled when something is unconnected.
   */
  connectLinks: { account: string; href: string }[];
};

// Most advanced first: when a link matches several connected repositories (the project itself
// and a fork, say), the one closest to a reproduction is the one worth showing.
const RANK: MentionStatus[] = ["ready", "awaiting-approval", "onboarding", "failed", "unsupported", "not-connected"];

// A name a report linked rarely starts to exist, so its 404 is believed for hours. A fork is
// looked up because a reviewer is about to create it, so its 404 is re-checked every few minutes.
// ponytail: one open guide costs 20 requests an hour per installed account against GitHub's
// anonymous 60; an installation token from the worker would lift that if more accounts install.
const MENTION_MISSING_SECONDS = 6 * 60 * 60;
const FORK_MISSING_SECONDS = 3 * 60;
const MAX_FORK_ACCOUNTS = 3;

export type SuggestOptions = {
  /** The link the reviewer has the Connect guide open on. Only a link the body holds is honoured. */
  guide?: string | null;
  fetchImpl?: typeof fetch;
};

export async function suggestTargets(body: string, opts: SuggestOptions = {}): Promise<TargetSuggestion> {
  const mentions = repositoryMentions(body);
  if (mentions.length === 0) return { matched: [], unconnected: [], progress: [], connectLinks: [] };

  const lookups = await lookupQuietly(mentions, MENTION_MISSING_SECONDS, opts.fetchImpl);
  const known = mentions.map((name) => {
    const lookup = lookups.get(name.toLowerCase());
    const current = lookup?.state === "found" ? lookup.fullName : null;
    return {
      name,
      canonical: current && current.toLowerCase() !== name.toLowerCase() ? current : null,
      missing: lookup?.state === "missing",
    };
  });
  const keys = [...new Set(known.flatMap((k) => [k.name, k.canonical ?? k.name].map((n) => n.toLowerCase())))];
  const repoNames = [...new Set(known.filter((k) => k.missing).map((k) => repoPart(k.name)))];

  // A repository stands in for a link when it is the linked repository (under its current name),
  // or a fork whose parent or fork-chain root is. The link only ever selects among rows the server
  // already holds.
  const byRepoName = (column: AnyColumn) =>
    inArray(sql`lower(split_part(${column}, '/', 2))`, repoNames);
  const rows = await db
    .select({
      fullName: connectedRepository.fullName,
      parentFullName: connectedRepository.parentFullName,
      sourceFullName: connectedRepository.sourceFullName,
      active: connectedRepository.active,
      archivedAt: connectedRepository.archivedAt,
      installationSuspendedAt: githubInstallation.suspendedAt,
      installationDeletedAt: githubInstallation.deletedAt,
      profileId: targetProfile.id,
      profileName: targetProfile.name,
      profileRetiredAt: targetProfile.retiredAt,
      onboardingState: targetOnboarding.state,
      onboardingError: targetOnboarding.lastError,
      buildPlan: targetOnboarding.buildPlan,
    })
    .from(connectedRepository)
    .innerJoin(githubInstallation, eq(connectedRepository.installationId, githubInstallation.id))
    .leftJoin(targetProfile, eq(connectedRepository.targetProfileId, targetProfile.id))
    .leftJoin(targetOnboarding, eq(targetOnboarding.repoId, connectedRepository.repoId))
    .where(
      or(
        inArray(sql`lower(${connectedRepository.fullName})`, keys),
        inArray(sql`lower(${connectedRepository.parentFullName})`, keys),
        inArray(sql`lower(${connectedRepository.sourceFullName})`, keys),
        ...(repoNames.length
          ? [
              byRepoName(connectedRepository.fullName),
              byRepoName(connectedRepository.parentFullName),
              byRepoName(connectedRepository.sourceFullName),
            ]
          : []),
      ),
    );

  type Row = (typeof rows)[number];
  const statusOf = (row: Row): MentionStatus => {
    // A revoked, archived or suspended grant is as good as not connected: it cannot be bound.
    if (!grantIsLive(row)) return "not-connected";
    if (row.profileId && !row.profileRetiredAt) return "ready";
    switch (row.onboardingState) {
      case "AWAITING_APPROVAL":
        return "awaiting-approval";
      case "FAILED":
        return "failed";
      case "UNSUPPORTED":
        return "unsupported";
      case null:
        // Connected but never onboarded, which is what happens to a private repository.
        return "unsupported";
      default:
        return "onboarding";
    }
  };
  const reasonOf = (row: Row, status: MentionStatus): string | null => {
    if (status === "failed") return readableOnboardingError(row.onboardingError);
    if (status !== "unsupported") return null;
    if (!row.onboardingState) return "It was connected but not onboarded, which is what happens to a private repository.";
    return (row.buildPlan as { reason?: string } | null)?.reason ?? null;
  };
  const namesOf = (row: Row) => [row.fullName, row.parentFullName, row.sourceFullName];

  const matched: TargetSuggestion["matched"] = [];
  const progress: MentionProgress[] = known.map(({ name, canonical, missing }) => {
    const direct = new Set([name.toLowerCase(), (canonical ?? name).toLowerCase()]);
    let candidates = rows.filter((row) => namesOf(row).some((n) => n && direct.has(n.toLowerCase())));
    let nameOnly = false;
    if (candidates.length === 0 && missing) {
      // GitHub has nothing at the link, so match on the repository name, but only when every
      // connected repository with that name belongs to one project (a fork chain shares its
      // root). A common name like "api" shared by two projects suggests neither.
      const repo = repoPart(name);
      const same = rows.filter((row) => namesOf(row).some((n) => n && repoPart(n) === repo));
      if (new Set(same.map((row) => (row.sourceFullName ?? row.fullName).toLowerCase())).size === 1) {
        candidates = same;
        nameOnly = true;
      }
    }
    const best = candidates
      .map((row) => ({ row, status: statusOf(row) }))
      .sort((a, b) => RANK.indexOf(a.status) - RANK.indexOf(b.status))[0];
    if (!best || best.status === "not-connected") {
      return {
        name,
        canonical,
        status: "not-connected",
        repoFullName: null,
        via: null,
        reason: null,
        retrying: null,
        forkedAs: null,
      };
    }
    const via: MatchVia = nameOnly ? "name" : direct.has(best.row.fullName.toLowerCase()) ? "link" : "fork";
    if (best.status === "ready" && best.row.profileId && best.row.profileName) {
      matched.push({
        profileId: best.row.profileId,
        profileName: best.row.profileName,
        fullName: best.row.fullName,
        mention: name,
        canonical,
        via,
      });
    }
    return {
      name,
      canonical,
      status: best.status,
      repoFullName: best.row.fullName,
      via,
      reason: reasonOf(best.row, best.status),
      retrying: best.status === "onboarding" ? readableOnboardingError(best.row.onboardingError) : null,
      forkedAs: null,
    };
  });

  const unconnected = progress.filter((p) => p.status !== "ready").map((p) => p.name);
  if (unconnected.length === 0) return { matched, unconnected, progress, connectLinks: [] };

  const installations = await liveInstallations();
  const guide = opts.guide?.toLowerCase();
  const guided = guide ? progress.find((p) => p.status === "not-connected" && p.name.toLowerCase() === guide) : undefined;
  const guidedKnown = guided ? known.find((k) => k.name === guided.name) : undefined;
  // A link GitHub has nothing at has no fork to find.
  if (guided && guidedKnown && !guidedKnown.missing) {
    guided.forkedAs = await findFork(guidedKnown.canonical ?? guided.name, installations, opts.fetchImpl);
  }
  return { matched, unconnected, progress, connectLinks: connectLinks(installations) };
}

function repoPart(fullName: string): string {
  return (fullName.split("/")[1] ?? "").toLowerCase();
}

/**
 * GitHub's answers, or none. A lookup only sharpens a suggestion, so a GitHub outage, an exhausted
 * rate limit or a database without the cache table leaves the case file working on literal names.
 */
async function lookupQuietly(
  names: string[],
  missingSeconds: number,
  fetchImpl?: typeof fetch,
): Promise<Map<string, RepositoryLookup>> {
  try {
    return await lookupRepositories(names, { missingSeconds, fetchImpl });
  } catch (error) {
    console.warn("target suggestion: repository lookup failed", error);
    return new Map();
  }
}

type Installation = { installationId: number; login: string; type: string | null };

async function liveInstallations(): Promise<Installation[]> {
  return db
    .select({
      installationId: githubInstallation.installationId,
      login: githubInstallation.accountLogin,
      type: githubInstallation.accountType,
    })
    .from(githubInstallation)
    .where(and(isNull(githubInstallation.suspendedAt), isNull(githubInstallation.deletedAt)))
    // Newest first, so the fork check's cap keeps the account most likely just set up for this.
    .orderBy(desc(githubInstallation.createdAt));
}

/**
 * The fork a reviewer made of `upstream` under an installed account, before it is added to the
 * App. GitHub names a fork after its upstream by default, so each account is asked about one name,
 * and the answer only counts when GitHub says that repository is a fork of `upstream`. A fork given
 * another name, or a private one, is not found; the guide then waits for it to be connected.
 */
async function findFork(
  upstream: string,
  installations: Installation[],
  fetchImpl?: typeof fetch,
): Promise<string | null> {
  const [owner, repo] = upstream.split("/");
  const logins = installations.map((i) => i.login).filter((login) => LOGIN.test(login));
  if (logins.some((login) => login.toLowerCase() === owner.toLowerCase())) return upstream;

  const candidates = logins.slice(0, MAX_FORK_ACCOUNTS).map((login) => `${login}/${repo}`);
  const lookups = await lookupQuietly(candidates, FORK_MISSING_SECONDS, fetchImpl);
  for (const candidate of candidates) {
    const lookup = lookups.get(candidate.toLowerCase());
    if (lookup?.state !== "found" || !lookup.fullName) continue;
    const lineage = [lookup.parentFullName, lookup.sourceFullName];
    if (lineage.some((n) => n?.toLowerCase() === upstream.toLowerCase())) return lookup.fullName;
  }
  return null;
}

function connectLinks(installations: Installation[]): TargetSuggestion["connectLinks"] {
  const links = installations.flatMap(({ installationId, login, type }) => {
    const href = manageRepositoriesUrl(Number(installationId), { login, type });
    return href ? [{ account: login, href }] : [];
  });
  return links.length ? links : [{ account: "GitHub", href: installUrl() }];
}
