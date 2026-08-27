import Image from "next/image";
import { redirect } from "next/navigation";
import { GitHubLight, Google } from "developer-icons";
import { ShieldCheck, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { currentSession } from "@/lib/auth/dal";

const MESSAGES: Record<string, string> = {
  state: "That login link did not start here. Try again.",
  forbidden: "That GitHub account is not on the reviewer list.",
  denied: "GitHub did not return an authorization code.",
  github: "GitHub would not confirm who you are. Try again.",
};

/**
 * 11px small print, in three places that have to match.
 *
 * The design specifies #737373 here, which is 3.8:1 on the card and under AA for text
 * this small. --muted-foreground is the same family at 7:1, and one of these lines is the
 * reason the Google button is disabled, so it has to be readable.
 */
const FINE_PRINT = "text-[11px] leading-[1.5] text-muted-foreground";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await currentSession()) redirect("/settings/channels");

  const { error } = await searchParams;

  return (
    <div className="flex min-h-full flex-1 bg-background">
      {/* The branded half is the one thing that can go: below lg the card's own mascot and
          heading carry the branding, and a 64px headline on a phone is a scroll, not a hero. */}
      <section className="relative hidden w-[680px] shrink-0 flex-col justify-center overflow-hidden p-16 lg:flex">
        <div className="absolute top-7 left-10 flex items-center gap-2">
          <Image src="/trix.svg" alt="" width={44} height={44} priority />
          <span className="font-heading text-[28px] text-foreground">BountyDesk</span>
        </div>

        <div className="flex flex-col items-start gap-6">
          <p className="inline-flex items-center gap-2 rounded-full border border-brand/30 bg-brand/15 px-3 py-1.5 font-heading text-sm text-foreground">
            <ShieldCheck className="size-3.5 text-brand" />
            Enterprise Security Shield
          </p>
          <p className="font-heading text-[64px] leading-[1.15] text-foreground">
            Secure your open-source supply chain
          </p>
        </div>
      </section>

      <section className="flex min-w-0 flex-1 items-center justify-center p-6">
        <div className="flex w-full max-w-[440px] flex-col gap-7 rounded-2xl bg-card p-6 shadow-[0_24px_24px_rgba(0,0,0,0.5)] sm:p-10">
          <header className="flex flex-col items-center gap-4">
            <Image src="/trix.svg" alt="" width={48} height={48} priority />
            <div className="flex flex-col items-center gap-1.5 text-center">
              <h1 className="font-heading text-[24px] text-foreground">
                Sign in to BountyDesk
              </h1>
              <p className="text-sm text-muted-foreground">
                Welcome back. Enter your credentials to access.
              </p>
            </div>
          </header>

          {error ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
            >
              <TriangleAlert className="mt-px size-4 shrink-0" />
              <span>{MESSAGES[error] ?? "Login failed. Try again."}</span>
            </p>
          ) : null}

          <div className="flex flex-col gap-4">
            <Button
              variant="outline"
              nativeButton={false}
              render={<a href="/api/auth/github" />}
              className="h-11 w-full justify-center gap-2.5 rounded-md"
            >
              <GitHubLight className="size-4" />
              Continue with GitHub
            </Button>

            {/* Disabled rather than absent: Google sign-in is designed and coming, and a
                button that appears the day it works is easier to explain than one that
                appears out of nowhere. The reason below is what makes the disabling fair. */}
            <Button
              variant="outline"
              disabled
              aria-describedby="google-unavailable"
              className="h-11 w-full justify-center gap-2.5 rounded-md"
            >
              <Google className="size-[18px]" />
              Continue with Google
            </Button>

            <div className={`flex flex-col gap-1.5 text-center ${FINE_PRINT}`}>
              <p id="google-unavailable">Google sign-in is not available yet.</p>
              <p>
                GitHub signs you in only. Repository access comes from installing the App.
              </p>
            </div>
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
