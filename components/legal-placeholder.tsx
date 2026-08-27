import Image from "next/image";
import Link from "next/link";

/**
 * The shell both legal pages sit in.
 *
 * They exist because the sign-in card links to them, and a dead link on a security product's
 * front door is worse than an honest page saying the document is still being written.
 */
export function LegalPlaceholder({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 p-6">
      <Link href="/login" className="flex w-fit items-center gap-2">
        <Image src="/trix.svg" alt="" width={32} height={32} />
        <span className="font-heading text-xl text-foreground">BountyDesk</span>
      </Link>
      <h1 className="font-heading text-[32px] text-foreground">{title}</h1>
      <p className="text-sm leading-6 text-muted-foreground">{children}</p>
      <Link
        href="/login"
        className="w-fit text-sm text-foreground underline underline-offset-4"
      >
        Back to sign in
      </Link>
    </main>
  );
}
