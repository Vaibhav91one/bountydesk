import Image from "next/image";
import Link from "next/link";
import { Sparkle } from "@phosphor-icons/react/ssr";

import { RollingIcon } from "@/components/rolling-icon";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The public header, for the pages a visitor can reach without signing in.
 *
 * A server component: three anchors do not earn a client boundary, and a hamburger would add
 * one for a menu with nothing in it. Below md the links go and the sign-in button stays, which
 * is the only control that matters on a phone.
 *
 * `sticky` comes off when something above it sticks instead. Two stacked sticky elements each
 * claiming top-0 overlap, so the landing page wraps the banner and this in one sticky box and
 * lets the box do it.
 *
 * `entrance` is the last beat of the landing page's load sequence: the page introduces itself
 * and the furniture arrives afterwards. CSS, so it runs off the prerendered HTML rather than
 * waiting for hydration, and it is off everywhere else.
 */
export function SiteHeader({
  links = true,
  sticky = true,
  entrance = false,
}: {
  links?: boolean;
  sticky?: boolean;
  entrance?: boolean;
}) {
  return (
    <header
      className={cn(
        "bg-background/70 backdrop-blur-md",
        sticky && "sticky top-0 z-50",
        entrance &&
          "animate-in slide-in-from-top-4 fade-in fill-mode-both duration-500 [animation-delay:1150ms] motion-reduce:animate-none",
      )}
    >
      <div className="mx-auto flex h-18 w-full max-w-7xl items-center justify-between gap-6 px-6">
        <Link
          href="/"
          className="flex shrink-0 items-center"
          aria-label="BountyDesk home"
        >
          <Image
            src="/logo-lockup.svg"
            alt="BountyDesk"
            width={158}
            height={24}
            priority
          />
        </Link>

        <nav className="flex items-center gap-1 sm:gap-2">
          {links ? (
            <div className="mr-4 hidden items-center gap-8 md:flex lg:gap-10">
              <a
                href="#how"
                className="text-body text-muted-foreground hover:text-foreground"
              >
                How it works
              </a>
              <a
                href="#faq"
                className="text-body text-muted-foreground hover:text-foreground"
              >
                Questions
              </a>
            </div>
          ) : null}

          <Button
            size="sm"
            nativeButton={false}
            render={<Link href="/login" />}
            className="rounded-full px-4"
          >
            <RollingIcon icon={Sparkle} weight="fill" className="size-4" /> Get
            started
          </Button>
        </nav>
      </div>
    </header>
  );
}
