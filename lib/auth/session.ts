/**
 * Operator sessions.
 *
 * Identity comes from Clerk (Google or GitHub sign-in); this app only reads the resolved
 * session through the DAL and decides authorization on it. Reviewer power is an email
 * allowlist, so the email is the key the allowlist checks.
 *
 * What a session does not carry is a GitHub token. Repository access comes from the App
 * installation, which is deliberately separate from who is signed in.
 */
export type Session = {
  /** A display name for the UI and the approval audit trail. */
  login: string;
  /** The verified primary email. The reviewer allowlist keys on this. */
  email: string;
  /** Profile image from the identity provider (e.g. a Google avatar), or null. */
  avatarUrl: string | null;
};
