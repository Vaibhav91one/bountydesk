import { LegalPlaceholder } from "@/components/legal-placeholder";

export const metadata = { title: "Privacy · BountyDesk" };

export default function PrivacyPage() {
  return (
    <LegalPlaceholder title="Privacy policy">
      The policy is not published yet. What the schema stores today: the reports it is sent
      and their evidence, GitHub account, installation and repository metadata, the target
      configuration BountyDesk is authorized to touch, raw inbound webhook payloads,
      processing errors, the verdict and delivery text a reviewer approves, GitHub&rsquo;s
      response to each delivery attempt, and a step-by-step session event log.
    </LegalPlaceholder>
  );
}
