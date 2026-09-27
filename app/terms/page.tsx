import { LegalPage, LegalSection } from "@/components/legal-page";

export const metadata = { title: "Terms · BountyDesk" };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of service" updated="September 2026">
      <p>
        BountyDesk is a demonstration project. There is no company behind it and it is not a
        paid service. It takes a security report, reproduces the reported issue against a target
        it has been authorized to test, and delivers a verdict only after a person approves the
        exact wording. These terms cover how you may use it while it runs in that form.
      </p>

      <LegalSection heading="Authorized targets only">
        <p>
          Reproduction runs against a target profile held on the server, never against a target
          you name yourself. Use BountyDesk only against the targets it is configured and
          authorized to test. Do not use it to probe, attack, or gather information about any
          system you do not own or have permission to test, and do not submit reports whose
          purpose is to abuse the sandbox or reach anything outside the target.
        </p>
      </LegalSection>

      <LegalSection heading="Provided as is">
        <p>
          The service is provided as is, with no warranty of any kind. Its verdicts are the
          output of an automated agent that a person reviews, not a professional security audit,
          and a reproduced or not-reproduced result can be wrong. There is no guarantee that the
          service is available, correct, or fit for any purpose, and you are responsible for what
          you do with anything it produces.
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
          . Open an issue there with any question about these terms or the project.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
