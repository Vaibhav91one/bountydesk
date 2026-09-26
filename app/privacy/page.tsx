import { LegalPage, LegalSection } from "@/components/legal-page";

export const metadata = { title: "Privacy · BountyDesk" };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy" updated="September 2026">
      <p>
        BountyDesk is a demonstration project with no company behind it. This page describes the
        data it handles as it runs today. It does not sell data, and it shares nothing beyond the
        services it needs to do its job: GitHub for issues, the model provider that runs the
        agent, and the email provider that delivers a verdict.
      </p>

      <LegalSection heading="Signing in">
        <p>
          Signing in with Google or GitHub goes through Clerk and identifies you as a reviewer.
          BountyDesk reads your account identity from Clerk and checks it against a reviewer
          allowlist. It does not see your password.
        </p>
      </LegalSection>

      <LegalSection heading="What the system stores">
        <p>
          It keeps the reports it is sent and their evidence, the reporter contact address it
          needs to deliver a verdict by email, the GitHub account, installation, and repository
          metadata it receives through the GitHub App, the target configuration it is authorized
          to touch, the raw inbound webhook and email payloads, processing errors, the verdict
          and delivery text a reviewer approves, the delivery provider&rsquo;s response to each
          attempt, and a step-by-step log of each agent session.
        </p>
      </LegalSection>

      <LegalSection heading="GitHub access">
        <p>
          Through the GitHub App, BountyDesk asks for the least access it needs: read access to
          repository metadata and read and write access to issues, so it can read a report and
          post an approved verdict back. A connected public repository is cloned anonymously.
          When an installation is suspended or removed, intake and delivery stop.
        </p>
      </LegalSection>

      <LegalSection heading="Retention">
        <p>
          Because this is a demonstration, data is kept for as long as the project runs and is
          not on a fixed deletion schedule. Some records are deliberately permanent: a verdict,
          an approval decision, a session event, and a delivery attempt cannot be edited or
          deleted, so there is an honest, tamper-evident trail of what was decided and sent.
        </p>
      </LegalSection>

      <LegalSection heading="Contact">
        <p>
          BountyDesk is developed in the open at{" "}
          <a
            href="https://github.com/Vaibhav91one/bountydesk"
            className="text-foreground underline underline-offset-4"
          >
            github.com/Vaibhav91one/bountydesk
          </a>
          . Open an issue there with any question about your data or the project.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
