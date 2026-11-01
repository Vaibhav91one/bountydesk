/**
 * The private subnet Daytona puts a link group on. Each group is its own isolated bridge network
 * drawn from this range: two concurrent groups were both handed 172.25.0.2 and 172.25.0.3, so an
 * address in this range only ever routes inside the caller's own group, and a sandbox in no group
 * reached nothing in it (verified live, 2026-11-01). The range cannot be narrowed per group because
 * the policy is set at create time, before Daytona assigns the group's addresses. As of 2026-11-01 Daytona refuses every in-group connection, in both
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
