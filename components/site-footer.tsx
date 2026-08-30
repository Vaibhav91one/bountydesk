import Image from "next/image";
import Link from "next/link";
import { ArrowSquareOut } from "@phosphor-icons/react/ssr";

const SOURCE = "https://github.com/Vaibhav91one/bountydesk";

const COLUMNS: {
  title: string;
  links: { label: string; href: string; out?: boolean }[];
}[] = [
  {
    title: "Product",
    links: [
      { label: "Sign in", href: "/login" },
      { label: "How it works", href: "/#how" },
    ],
  },
  {
    title: "Project",
    links: [
      { label: "Source", href: SOURCE, out: true },
      {
        label: "Design record",
        href: `${SOURCE}/blob/main/docs/decisions.md`,
        out: true,
      },
      {
        label: "Agent guide",
        href: `${SOURCE}/blob/main/AGENTS.md`,
        out: true,
      },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Terms", href: "/terms" },
      { label: "Privacy", href: "/privacy" },
    ],
  },
];

export function SiteFooter({ appLinkPrefetch = true }: { appLinkPrefetch?: boolean }) {
  return (
    <footer className="mt-24 border-t border-border/50">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-12 px-6 py-14">
        {/* Brand on the left, links pushed to the right. One row on a wide window and two
            stacked on a narrow one, which is what lg:flex-row does without a second layout. */}
        <div className="flex flex-col gap-10 lg:flex-row lg:justify-between lg:gap-16">
          <div className="flex max-w-xs flex-col gap-3">
            <Link
              href="/"
              className="flex w-fit items-center"
              aria-label="BountyDesk home"
            >
              <Image
                src="/logo-lockup.svg"
                alt="BountyDesk"
                width={158}
                height={24}
              />
            </Link>
            <p className="text-meta text-muted-foreground">
              Bugs, CVEs, bounties. Reproduced securely.
            </p>
          </div>

          <div className="grid gap-10 sm:grid-cols-3 lg:gap-16">
            {COLUMNS.map((column) => (
              <div key={column.title} className="flex flex-col gap-3">
                <h2 className="text-meta text-foreground">{column.title}</h2>
                <ul className="flex flex-col gap-2.5">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      {link.out ? (
                        <a
                          href={link.href}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-center gap-1.5 text-meta text-muted-foreground hover:text-foreground"
                        >
                          {link.label}
                          <ArrowSquareOut
                            aria-hidden="true"
                            className="size-3"
                          />
                        </a>
                      ) : (
                        <Link
                          href={link.href}
                          prefetch={appLinkPrefetch}
                          className="text-meta text-muted-foreground hover:text-foreground"
                        >
                          {link.label}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <p className="text-meta text-muted-foreground">
          Built on the TrueForge agent harness. Agent Bounty drafts; a person
          signs.
        </p>
      </div>

      {/* Type rather than an asset, so it scales with the viewport and costs no request.
          aria-hidden because the header already carries the name, and overflow-hidden because
          negative tracking at 18vw runs past the edge on a narrow window.

          Agent Bounty stands in the middle of the name. Sized in vw like the type around it so
          it holds its place in the lockup at any width, and lifted a little because the mascot
          reads as centred on its body while the words sit on a baseline. It is louder than the
          4.5% type on purpose: at that opacity the drawing would disappear entirely. */}
      <div aria-hidden="true" className="overflow-hidden">
        <span className="flex translate-y-[0.16em] items-center justify-center px-2 text-[14vw] lg:px-6 leading-none font-semibold tracking-tighter text-foreground/[0.045] select-none">
          Bounty
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/mascot/idle.svg"
            alt=""
            width={256}
            height={256}
            className="-translate-y-[0.09em] mx-[0.02em] size-[0.78em] shrink-0 opacity-25"
          />
          Desk
        </span>
      </div>
    </footer>
  );
}
