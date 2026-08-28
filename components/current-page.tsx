"use client";

import { usePathname } from "next/navigation";

import { NAV } from "@/components/app-sidebar";

/**
 * The header label for whatever route is open.
 *
 * It reads the same NAV list the sidebar does, so a route can never be named one thing on the
 * left and another along the top. An unlisted route gets no label rather than a wrong one.
 */
export function CurrentPage() {
  const pathname = usePathname();
  const current = NAV.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));
  if (!current) return null;

  return (
    <span className="flex items-center gap-2 text-body text-muted-foreground">
      <current.icon className="size-4" />
      {current.label}
    </span>
  );
}
