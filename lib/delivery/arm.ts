import type { IssueComment } from "@/lib/github/comment";

import type { DeliveryLease } from "./queue";

/** The injectable boundary keeps the transports deterministic in worker tests. */
export type DeliveryDeps = {
  githubAppId: number;
  hashContent: (payload: string) => string;
  mintToken: (
    installationId: number,
    repoId: number,
    opts?: { signal?: AbortSignal },
  ) => Promise<{ token: string; expiresAt: string }>;
  postComment: (opts: {
    token: string;
    fullName: string;
    issueNumber: number;
    body: string;
    signal?: AbortSignal;
  }) => Promise<{ id: number }>;
  listComments: (opts: {
    token: string;
    fullName: string;
    issueNumber: number;
    signal?: AbortSignal;
  }) => Promise<IssueComment[]>;
  /**
   * Required rather than optional on purpose: an absent sender would silently turn email
   * delivery into a no-op, and a delivery that quietly does nothing is worse than one that
   * fails loudly. The GitHub tests stub it with a throw, which doubles as an assertion that
   * the GitHub arm never sends mail.
   */
  sendEmail: (opts: {
    to: string;
    subject: string;
    text: string;
    html: string;
    idempotencyKey: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  }) => Promise<{ id: string }>;
};

/**
 * What a channel arm is handed. Everything here has already passed the shared gates: the verdict
 * exists, its payload hashes to what was approved, an APPROVED decision agrees, the verdict belongs
 * to this report, the delivery marker is present exactly once, and the report is still DELIVERING.
 * An arm's only remaining job is to resolve its own destination and put the bytes on the wire.
 */
export type DeliveryContext = {
  lease: DeliveryLease;
  /** The immutable, hash-checked verdict payload. The only body any channel may send. */
  payload: string;
  report: {
    id: string;
    channel: "github" | "email" | "manual";
    sourceRef: string;
    /** Reporter-controlled: for email it is their own subject line, so treat it as untrusted. */
    title: string;
    reporterContact: string | null;
  };
  leaseSeconds: number;
  startedAt: Date;
  signal?: AbortSignal;
};

/**
 * `completesReport` is the whole difference between the two transports. A GitHub 201 is itself
 * the receipt, so the report is DELIVERED in the same transaction. An email 200 only means the
 * provider accepted it, so the report stays DELIVERING until its delivered webhook arrives.
 * Collapsing this flag would silently break the transport-receipt invariant.
 *
 * A transient failure is thrown rather than returned, so the worker's existing catch puts the row
 * back on its backoff.
 */
export type ArmOutcome =
  | { kind: "sent"; responseStatus: number; responseBody: string; completesReport: boolean }
  | { kind: "replayed"; note: string; completesReport: boolean }
  | { kind: "refused"; message: string; hold?: boolean };

export type DeliveryArm = (ctx: DeliveryContext, deps: DeliveryDeps) => Promise<ArmOutcome>;
