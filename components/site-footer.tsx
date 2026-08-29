import Link from "next/link";
import { ArrowSquareOut } from "@phosphor-icons/react/ssr";

const SOURCE = "https://github.com/Vaibhav91one/bountydesk";

const COLUMNS: { title: string; links: { label: string; href: string; out?: boolean }[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Sign in", href: "/login" },
      { label: "How it works", href: "/#how" },
      { label: "What runs today", href: "/#status" },
    ],
  },
  {
    title: "Project",
    links: [
      { label: "Source", href: SOURCE, out: true },
      { label: "Design record", href: `${SOURCE}/blob/main/docs/decisions.md`, out: true },
      { label: "Agent guide", href: `${SOURCE}/blob/main/AGENTS.md`, out: true },
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

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-border/50">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-12 px-6 py-14">
        <div className="grid gap-10 sm:grid-cols-3">
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
                        <ArrowSquareOut aria-hidden="true" className="size-3" />
                      </a>
                    ) : (
                      <Link
                        href={link.href}
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

        <p className="text-meta text-muted-foreground">
          Built on the TrueForge agent harness. Agent Bounty drafts; a person signs.
        </p>
      </div>

      {/* Type rather than an asset, so it scales with the viewport and costs no request.
          aria-hidden because the header already carries the name, and overflow-hidden because
          negative tracking at 18vw runs past the edge on a narrow window. */}
      <div aria-hidden="true" className="overflow-hidden">
        <span className="block translate-y-[0.16em] px-6 text-[18vw] leading-none font-semibold tracking-tighter text-foreground/[0.045] select-none">
          BountyDesk
        </span>
      </div>
    </footer>
  );
}
