import Image from "next/image";
import { redirect } from "next/navigation";
import { Google } from "developer-icons";
import { Warning } from "@phosphor-icons/react/ssr";

import { Button } from "@/components/ui/button";
import { MascotMarquee } from "@/components/mascot-marquee";
import { mascotStates } from "@/lib/mascot/states";
import { currentSession } from "@/lib/auth/dal";

import { SignInButton } from "./sign-in-button";

const MESSAGES: Record<string, string> = {
  state: "That login link did not start here. Try again.",
  forbidden: "That GitHub account is not on the reviewer list.",
  denied: "GitHub did not return an authorization code.",
  github: "GitHub would not confirm who you are. Try again.",
};

/**
 * 11px small print, in the two places that have to match.
 *
 * The design specifies #737373 here, which is 3.8:1 on the card and under AA for text
 * this small. --muted-foreground is the same family at 7:1, and one of these lines is the
 * reason the Google button is disabled, so it has to be readable.
 */
const FINE_PRINT = "text-meta text-muted-foreground";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await currentSession()) redirect("/home");

  const { error } = await searchParams;

  return (
    <div className="flex min-h-full flex-1 bg-background">
      {/* The branded half is the one thing that can go: below lg the card's own mascot and
          heading carry the branding, and a 64px headline on a phone is a scroll, not a hero. */}
      <section className="hidden w-[680px] shrink-0 flex-col justify-center overflow-hidden p-16 lg:flex">
        <div className="flex flex-col items-start gap-6">
          <p className="text-heading font-medium text-brand-soft">Meet Agent Bounty</p>
          <p className="text-display font-normal text-foreground">
            Your all-in-one
            <MascotMarquee states={mascotStates()} />
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

          {error ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-body text-destructive"
            >
              <Warning className="mt-px size-4 shrink-0" />
              <span>{MESSAGES[error] ?? "Login failed. Try again."}</span>
            </p>
          ) : null}

          <div className="flex flex-col gap-5">
            <SignInButton />

            {/* Disabled rather than absent: Google sign-in is designed and coming, and a
                button that appears the day it works is easier to explain than one that
                appears out of nowhere. The reason below is what makes the disabling fair. */}
            <Button
              variant="outline"
              disabled
              aria-describedby="google-unavailable"
              className="h-11 w-full justify-center gap-2.5"
            >
              <Google className="size-[18px]" />
              Continue with Google
            </Button>

            <p id="google-unavailable" className={`text-center ${FINE_PRINT}`}>
              Google sign-in is not available yet.
            </p>
          </div>

          <p className={`text-center ${FINE_PRINT}`}>
            By continuing you agree to the{" "}
            <a href="/terms" className="text-foreground underline underline-offset-2">
              Terms
            </a>{" "}
            &{" "}
            <a href="/privacy" className="text-foreground underline underline-offset-2">
              Privacy Policy
            </a>
            .
          </p>
        </div>
      </section>
    </div>
  );
}
