/**
 * The two files that let `app.bountydesk.vaibhav.quest` links open the mobile app instead of the
 * browser. Both carry per-developer values (Apple team id, Android signing fingerprints) that are
 * not secrets but are not known to the repo, so they come from the environment. Until a value is
 * set the file is withheld (404) instead of published with a placeholder: a wrong association file
 * is cached by the OS and is slow to correct.
 */

export const MOBILE_APP_ID = "dev.bountydesk.mobile";

type LinkEnv = Record<string, string | undefined>;

// The reviewer web routes a push tap or shared link lands on.
export const APP_PATHS = ["/reports/*", "/inbox"];

const TEAM_ID = /^[A-Z0-9]{10}$/;
const SHA256_FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export type AppleAppSiteAssociation = {
  applinks: {
    details: Array<{ appIDs: string[]; components: Array<{ "/": string }> }>;
  };
};

export function appleAppSiteAssociation(env: LinkEnv = process.env): AppleAppSiteAssociation | null {
  const teamId = env.MOBILE_IOS_TEAM_ID?.trim();
  if (!teamId || !TEAM_ID.test(teamId)) return null;

  return {
    applinks: {
      details: [
        {
          appIDs: [`${teamId}.${MOBILE_APP_ID}`],
          components: APP_PATHS.map((path) => ({ "/": path })),
        },
      ],
    },
  };
}

export type AssetLinks = Array<{
  relation: string[];
  target: { namespace: "android_app"; package_name: string; sha256_cert_fingerprints: string[] };
}>;

export function assetLinks(env: LinkEnv = process.env): AssetLinks | null {
  const fingerprints = (env.MOBILE_ANDROID_SHA256_FINGERPRINTS ?? "")
    .split(",")
    .map((fp) => fp.trim().toUpperCase())
    .filter(Boolean);
  if (fingerprints.length === 0 || !fingerprints.every((fp) => SHA256_FINGERPRINT.test(fp))) return null;

  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: MOBILE_APP_ID, sha256_cert_fingerprints: fingerprints },
    },
  ];
}
