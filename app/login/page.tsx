import Image from "next/image";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";

import { MascotMarquee } from "@/components/mascot-marquee";
import { MASCOT_STATES } from "@/lib/mascot/catalog";

import { SocialSignIn } from "./social-sign-in";

/**
 * Sign-in offers Google and GitHub, both through Clerk. Any signed-in visitor is bounced to /home,
 * which applies the reviewer allowlist: a signed-in account that is not a reviewer lands on
 * /not-authorized rather than looping back here.
 */
export default async function LoginPage() {
  const { userId } = await auth();
  if (userId) redirect("/home");

  return (
    <div className="flex min-h-full flex-1 bg-background">
      {/* The branded half is the one thing that can go: below lg the card carries the branding,
          and a 64px headline on a phone is a scroll, not a hero. */}
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

      <section className="flex min-w-0 flex-1 items-center justify-center p-6">
        <div className="flex w-full max-w-[440px] flex-col gap-9 rounded-2xl bg-card p-8 shadow-[0_24px_24px_rgba(0,0,0,0.5)] sm:p-10">
          <header className="flex flex-col items-center gap-2.5 text-center">
            {/* The lockup stands in for the word, so the line reads "Sign in to BountyDesk"
                with the mark doing the last two syllables. */}
            <h1 className="flex flex-wrap items-center justify-center gap-x-2.5 text-title text-foreground">
              Sign in to
              <Image src="/logo-lockup.svg" alt="BountyDesk" width={201} height={30} priority />
            </h1>
            <p className="text-body text-muted-foreground">
              Bugs, CVEs, bounties. Reproduced securely.
            </p>
          </header>

          <SocialSignIn />

          <p className="text-center text-meta text-muted-foreground">
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
        </div>
      </section>
    </div>
  );
}
