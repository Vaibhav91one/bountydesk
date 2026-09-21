import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { SignIn } from "@clerk/nextjs";

import { MascotMarquee } from "@/components/mascot-marquee";
import { MASCOT_STATES } from "@/lib/mascot/catalog";

/**
 * Sign-in is Clerk's, offering Google and GitHub. Any signed-in visitor is bounced to /home, which
 * applies the reviewer allowlist: a signed-in account that is not a reviewer lands on
 * /not-authorized rather than looping back here.
 */
export default async function LoginPage() {
  const { userId } = await auth();
  if (userId) redirect("/home");

  return (
    <div className="flex min-h-full flex-1 bg-background">
      {/* The branded half is the one thing that can go: below lg the sign-in card carries enough
          on its own, and a 64px headline on a phone is a scroll, not a hero. */}
      <section className="hidden w-[680px] shrink-0 flex-col justify-center overflow-hidden p-16 lg:flex">
        <div className="flex flex-col items-start gap-6">
          <p className="text-heading font-medium text-brand-soft">Meet Agent Bounty</p>
          <p className="text-display font-normal text-foreground">
            Your all-in-one
            <MascotMarquee states={[...MASCOT_STATES]} />
            threat hunter
          </p>
          <p className="max-w-[480px] text-lead text-muted-foreground">
            Intake, scope check, reproduction in an isolated sandbox, and a verdict that ships
            only after you approve the exact words. One place, start to finish.
          </p>
        </div>
      </section>

      <section className="flex min-w-0 flex-1 flex-col items-center justify-center gap-6 p-6">
        <SignIn routing="hash" fallbackRedirectUrl="/home" signUpUrl="/login" />
        <p className="max-w-[380px] text-center text-meta text-muted-foreground">
          BountyDesk is a demonstration right now. See the placeholder{" "}
          <a href="/terms" className="text-foreground underline underline-offset-2">
            Terms
          </a>{" "}
          &{" "}
          <a href="/privacy" className="text-foreground underline underline-offset-2">
            Privacy Policy
          </a>{" "}
          for what that means today.
        </p>
      </section>
    </div>
  );
}
