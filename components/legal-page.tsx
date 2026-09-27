import Image from "next/image";
import Link from "next/link";

/**
 * The shell both legal pages sit in. It carries the header lockup, the title, and the back link,
 * so each page only writes its own sections. These pages exist because the sign-in card links to
 * them, and a dead link on a security product's front door reads worse than an honest page.
 */
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6 py-16">
      <Link href="/login" className="flex w-fit items-center gap-2">
        <Image src="/trix.svg" alt="" width={32} height={32} />
        <span className="text-heading text-foreground">BountyDesk</span>
      </Link>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-title text-foreground">{title}</h1>
        <p className="text-meta text-muted-foreground">Last updated {updated}</p>
      </div>
      <div className="flex flex-col gap-6 text-body text-muted-foreground">{children}</div>
      <Link
        href="/login"
        className="w-fit text-body text-foreground underline underline-offset-4"
      >
        Back to sign in
      </Link>
    </main>
  );
}

/** A titled block within a legal page. */
export function LegalSection({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-heading text-foreground">{heading}</h2>
      {children}
    </section>
  );
}
