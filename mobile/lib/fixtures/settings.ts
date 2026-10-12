import type { ConnectionRow, EmailReviewer, IntegrationRow, MobileMe } from "../types"
import { DIGEST, ago } from "./ids"

export const me = (): MobileMe => ({
  allowlisted: true,
  login: "Alex Morgan",
  email: "alex@example.com",
  avatarUrl: null,
  role: "owner",
})

const repo = (over: Partial<ConnectionRow>): ConnectionRow => ({
  id: "inst-1",
  account: "Vaibhav91one",
  status: "active",
  fullName: "",
  owner: "Vaibhav91one",
  name: "",
  label: "",
  hint: "",
  target: null,
  repoId: 0,
  configured: false,
  connected: true,
  isPrivate: false,
  contentsPermission: null,
  advisoriesPermission: "write",
  reportCount: 0,
  awaitingReview: 0,
  delivered: 0,
  lastReportAt: null,
  lastSyncedAt: ago(5),
  manageUrl: null,
  onboarding: null,
  onboardingProgress: null,
  onboardingDetail: null,
  ...over,
})

export const connections = (): ConnectionRow[] => [
  repo({
    id: "repo-1001",
    repoId: 1001,
    name: "juice-shop",
    fullName: "Vaibhav91one/juice-shop",
    label: "juice-shop",
    target: "v17.3.0",
    configured: true,
    reportCount: 10,
    awaitingReview: 3,
    delivered: 1,
    lastReportAt: ago(4),
    onboarding: { manifest: { startCommand: "npm start", scopeRules: [{ allow: "localhost" }] }, imageName: "ghcr.io/vaibhav91one/juice-shop", imageDigest: DIGEST },
    // The bound target is live while a rebuild is in flight, which is the stage the mockup lights.
    onboardingProgress: { state: "PENDING_BUILD", reason: null },
    onboardingDetail: {
      state: "PENDING_BUILD",
      progressNote: null,
      reason: null,
      strategy: "dockerfile",
      ecosystem: "node",
      imageName: "ghcr.io/vaibhav91one/juice-shop",
      imageDigest: DIGEST,
      buildMarker: "1867b92",
      approvedBy: "alex@example.com",
      approvedAt: ago(10000),
      review: { verdict: "SANDBOXABLE", reason: "Single container, no external services" },
      hasDockerfile: true,
      hasBuildLog: true,
      hasManifest: true,
      hasBuildPlan: true,
    },
  }),
  repo({ id: "repo-1002", repoId: 1002, name: "api-gateway", fullName: "Vaibhav91one/api-gateway", label: "api-gateway", target: null }),
  repo({ id: "repo-1003", repoId: 1003, name: "billing-core", fullName: "Vaibhav91one/billing-core", label: "billing-core", isPrivate: true, status: "suspended" }),
]

export const integrations = (): IntegrationRow[] => [
  { id: "email", name: "Email", detail: "3 reviewers verified", icon: "mail", installed: true, action: { kind: "none", label: "Active" } },
  { id: "github", name: "GitHub", detail: "1 installation", icon: "github", installed: true, action: { kind: "none", label: "Connected" } },
]

export const emailReviewers = (): EmailReviewer[] => [
  { email: "alex@example.com", role: "owner", verified: true, codeOutstanding: false, addedByEmail: null, createdAt: null },
  { email: "sam@example.com", role: "member", verified: true, codeOutstanding: false, addedByEmail: "alex@example.com", createdAt: "2026-10-03T09:00:00.000Z" },
  { email: "priya@example.com", role: "member", verified: false, codeOutstanding: true, addedByEmail: "alex@example.com", createdAt: ago(4) },
]
