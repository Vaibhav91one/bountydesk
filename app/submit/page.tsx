import Image from "next/image";
import Link from "next/link";

import { UploadForm } from "./upload-form";

export const metadata = { title: "Submit a report · BountyDesk" };

/**
 * The public upload page, for a reporter with no GitHub account and no email thread. It sits outside
 * the signed-in console on purpose: the uploader is not a reviewer. What it posts is untrusted and is
 * held for a reviewer before anything runs on it.
 */
export default function SubmitPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6 py-16">
      <Link href="/" className="flex w-fit items-center gap-2">
        <Image src="/trix.svg" alt="" width={32} height={32} />
        <span className="text-heading text-foreground">BountyDesk</span>
      </Link>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-title text-foreground">Submit a security report</h1>
        <p className="text-body text-muted-foreground">
          A reviewer reads every upload before anything runs on it. You will get a code by email to
          confirm your address; the verdict is sent there only once it is confirmed and a reviewer
          has approved the exact text.
        </p>
      </div>
      <UploadForm />
    </main>
  );
}
