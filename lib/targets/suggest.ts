import {
  and,
  connectedRepository,
  db,
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

/**
 * A target suggestion for an email report, read off the repository links in its body.
 *
 * The body is reporter-controlled, so a link here only decides which of the reviewer's own
 * options is highlighted. It is matched against connected repositories the server already holds,
 * and binding still goes through bindTarget on an explicit click. Nothing in this file binds,
 * reproduces or reaches the network.
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

export type MentionProgress = {
  /** The link as the report spelled it. */
  name: string;
  status: MentionStatus;
  /** The connected repository standing in for it: itself, or a fork of it. Null when none. */
  repoFullName: string | null;
  /** Why onboarding stopped, for failed and unsupported. */
  reason: string | null;
};

export type TargetSuggestion = {
  /** Linked repositories whose connected repository, or fork, has a live grant and a built target. */
  matched: { profileId: string; profileName: string; fullName: string; mention: string }[];
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

export async function suggestTargets(body: string): Promise<TargetSuggestion> {
  const mentions = repositoryMentions(body);
  if (mentions.length === 0) return { matched: [], unconnected: [], progress: [], connectLinks: [] };
  const keys = mentions.map((name) => name.toLowerCase());

  // A repository stands in for a link when it is the linked repository, or a fork whose parent
  // or fork-chain root is. The link only ever selects among rows the server already holds.
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
    if (status === "failed") return row.onboardingError;
    if (status !== "unsupported") return null;
    if (!row.onboardingState) return "It was connected but not onboarded, which is what happens to a private repository.";
    return (row.buildPlan as { reason?: string } | null)?.reason ?? null;
  };

  const matched: TargetSuggestion["matched"] = [];
  const progress: MentionProgress[] = mentions.map((name) => {
    const key = name.toLowerCase();
    const candidates = rows
      .filter((row) =>
        [row.fullName, row.parentFullName, row.sourceFullName].some((n) => n?.toLowerCase() === key),
      )
      .map((row) => ({ row, status: statusOf(row) }))
      .sort((a, b) => RANK.indexOf(a.status) - RANK.indexOf(b.status));
    const best = candidates[0];
    if (!best || best.status === "not-connected") {
      return { name, status: "not-connected", repoFullName: null, reason: null };
    }
    if (best.status === "ready" && best.row.profileId && best.row.profileName) {
      matched.push({
        profileId: best.row.profileId,
        profileName: best.row.profileName,
        fullName: best.row.fullName,
        mention: name,
      });
    }
    return { name, status: best.status, repoFullName: best.row.fullName, reason: reasonOf(best.row, best.status) };
  });

  const unconnected = progress.filter((p) => p.status !== "ready").map((p) => p.name);
  return { matched, unconnected, progress, connectLinks: unconnected.length ? await connectLinks() : [] };
}

async function connectLinks(): Promise<TargetSuggestion["connectLinks"]> {
  const installations = await db
    .select({
      installationId: githubInstallation.installationId,
      login: githubInstallation.accountLogin,
      type: githubInstallation.accountType,
    })
    .from(githubInstallation)
    .where(and(isNull(githubInstallation.suspendedAt), isNull(githubInstallation.deletedAt)));

  const links = installations.flatMap(({ installationId, login, type }) => {
    const href = manageRepositoriesUrl(Number(installationId), { login, type });
    return href ? [{ account: login, href }] : [];
  });
  return links.length ? links : [{ account: "GitHub", href: installUrl() }];
}
