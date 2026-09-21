import { ShieldWarning } from "@phosphor-icons/react/ssr";

import { SignOutButton } from "@clerk/nextjs";

import { Button } from "@/components/ui/button";

/**
 * Where a signed-in account that is not on the reviewer allowlist lands. It is authenticated, so
 * sending it back to sign-in would loop; this is the honest dead end instead, with a way out.
 */
export default function NotAuthorizedPage() {
  return (
    <div className="flex min-h-full flex-1 items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-[440px] flex-col items-center gap-5 rounded-2xl bg-card p-8 text-center shadow-[0_24px_24px_rgba(0,0,0,0.5)] sm:p-10">
        <ShieldWarning className="size-10 text-brand-soft" />
        <h1 className="text-title text-foreground">You are signed in, but not a reviewer</h1>
        <p className="text-body text-muted-foreground">
          This account is not on the reviewer allowlist, so it cannot open the console. Ask an
          administrator to add your email, then sign in again.
        </p>
        <SignOutButton redirectUrl="/login">
          <Button variant="outline" className="h-11 w-full justify-center">
            Sign out
          </Button>
        </SignOutButton>
      </div>
    </div>
  );
}
