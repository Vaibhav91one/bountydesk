/**
 * The private subnet Daytona puts a link group on (each group is its own network; seen as
 * 172.25.0.x and 172.25.1.x). As of 2026-11-01 Daytona refuses every in-group connection, in both
 * directions, while networkBlockAll is true, which silently broke the browser probe, the OOB
 * listener, the workbench and mesh targets. networkBlockAll false with this as the only
 * networkAllowList entry restores in-group traffic while every internet address still gets
 * Daytona's "Internet is restricted" denial (verified live with both modes, 2026-11-01). A
 * sandbox in no group has no address in this range, so for it the policy is the same as
 * networkBlockAll.
 */
export const LINK_NETWORK_CIDR = "172.25.0.0/16";

/**
 * Why a sandbox's reported egress policy is not offline, or null when it is. Two policies count:
 * networkBlockAll with no allow list, or networkBlockAll false with LINK_NETWORK_CIDR as the only
 * allowed range (what createSandbox sends). Anything else, including any domain allow list, is not.
 */
export function offlinePolicyError(sandbox: {
  networkBlockAll: boolean;
  networkAllowList: string | null;
  domainAllowList: string | null;
}): string | null {
  if (!sandbox.networkBlockAll && sandbox.networkAllowList !== LINK_NETWORK_CIDR) {
    return "networkBlockAll false and an allow list other than the link network";
  }
  if (sandbox.domainAllowList || (sandbox.networkBlockAll && sandbox.networkAllowList)) {
    return "a non-empty egress allow list";
  }
  return null;
}
