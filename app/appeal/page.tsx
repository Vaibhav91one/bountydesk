import Image from "next/image";
import Link from "next/link";

import { AppealForm } from "./appeal-form";

export const metadata = { title: "Appeal a verdict · BountyDesk" };

/**
 * Public page for a reporter to contest a delivered verdict. It reads no report data: the page
 * renders the same for any id, and the server decides on the emailed code.
 */
export default async function AppealPage({ searchParams }: { searchParams: Promise<{ report?: string }> }) {
  const { report } = await searchParams;
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6 py-16">
      <Link href="/" className="flex w-fit items-center gap-2">
        <Image src="/trix.svg" alt="" width={32} height={32} />
        <span className="text-heading text-foreground">BountyDesk</span>
      </Link>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-title text-foreground">Appeal a verdict</h1>
        <p className="text-body text-muted-foreground">
          Enter the address the verdict was sent to. We email it a code, and a reviewer reads your
          appeal after you enter it.
        </p>
      </div>
      <AppealForm initialReportId={typeof report === "string" ? report : ""} />
    </main>
  );
}
