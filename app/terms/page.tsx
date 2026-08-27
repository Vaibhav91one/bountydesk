import { LegalPlaceholder } from "@/components/legal-placeholder";

export const metadata = { title: "Terms · BountyDesk" };

export default function TermsPage() {
  return (
    <LegalPlaceholder title="Terms of service">
      The terms are not published yet. Until they are, BountyDesk is a demonstration: sign-in
      identifies a reviewer, and nothing is posted anywhere without a human approving the
      exact text first.
    </LegalPlaceholder>
  );
}
