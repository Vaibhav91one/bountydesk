import { requireReviewer } from "@/lib/auth/dal";

/**
 * The gate for every settings surface.
 *
 * Putting it in the layout rather than in each page means a new page under /settings is
 * protected by existing, not by someone remembering. Server actions do not run layouts,
 * so each action re-checks for itself.
 */
export default async function SettingsLayout({ children }: LayoutProps<"/settings">) {
  await requireReviewer();

  return <div className="mx-auto w-full max-w-5xl px-6 py-10">{children}</div>;
}
