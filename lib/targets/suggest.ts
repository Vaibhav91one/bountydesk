import {
  and,
  connectedRepository,
  db,
  eq,
  githubInstallation,
  inArray,
  isNull,
  sql,
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

export type TargetSuggestion = {
  /** Linked repositories that are connected, granted, and own a built target. */
  matched: { profileId: string; profileName: string; fullName: string }[];
  /** Linked repositories BountyDesk holds no usable target for, as the report spelled them. */
  unconnected: string[];
  /**
   * Where a reviewer adds a repository to the App: one link per live installation, or the
   * install page when there is none. Only filled when something is unconnected.
   */
  connectLinks: { account: string; href: string }[];
};

export async function suggestTargets(body: string): Promise<TargetSuggestion> {
  const mentions = repositoryMentions(body);
  if (mentions.length === 0) return { matched: [], unconnected: [], connectLinks: [] };
  const keys = mentions.map((name) => name.toLowerCase());

  const rows = await db
    .select({
      fullName: connectedRepository.fullName,
      active: connectedRepository.active,
      archivedAt: connectedRepository.archivedAt,
      installationSuspendedAt: githubInstallation.suspendedAt,
      installationDeletedAt: githubInstallation.deletedAt,
      profileId: targetProfile.id,
      profileName: targetProfile.name,
    })
    .from(connectedRepository)
    .innerJoin(githubInstallation, eq(connectedRepository.installationId, githubInstallation.id))
    .innerJoin(targetProfile, eq(connectedRepository.targetProfileId, targetProfile.id))
    .where(
      and(
        inArray(sql`lower(${connectedRepository.fullName})`, keys),
        isNull(targetProfile.retiredAt),
      ),
    );

  const live = rows.filter(grantIsLive);
  const matched = keys.flatMap((key) =>
    live
      .filter((row) => row.fullName.toLowerCase() === key)
      .map(({ profileId, profileName, fullName }) => ({ profileId, profileName, fullName })),
  );
  const unconnected = mentions.filter(
    (name) => !matched.some((m) => m.fullName.toLowerCase() === name.toLowerCase()),
  );
  return { matched, unconnected, connectLinks: unconnected.length ? await connectLinks() : [] };
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
