import { CircleNotch } from "@phosphor-icons/react/ssr";

/**
 * The loading state for the public routes.
 *
 * A spinner and nothing else. The signed-in console has its own skeletons, which can be
 * specific because the shapes there are known before the data is; out here the next screen
 * could be the sign-in page or a legal placeholder, and a skeleton would be guessing.
 */
export default function Loading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-dvh flex-1 items-center justify-center bg-background"
    >
      <CircleNotch className="size-6 animate-spin text-muted-foreground motion-reduce:animate-none" />
      <span className="sr-only">Loading</span>
    </div>
  );
}
