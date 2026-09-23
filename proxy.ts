import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import {
  landingRedirectEnabled,
  landingRedirectTarget,
  shouldRedirectToSource,
} from "@/lib/deployment/landing-redirect";

/**
 * One proxy file (Next 16's renamed middleware). Clerk populates the auth context for every
 * matched request so the DAL can read the session server-side; the landing redirect keeps its
 * old behavior, composed inside the Clerk handler rather than as a second proxy layer.
 */
export const proxy = clerkMiddleware((_auth, request) => {
  if (
    landingRedirectEnabled() &&
    shouldRedirectToSource(request.nextUrl.pathname, request.headers.get("host"))
  ) {
    return NextResponse.redirect(
      landingRedirectTarget(request.nextUrl.pathname, request.nextUrl.search),
      302,
    );
  }
  return NextResponse.next();
});

// Everything except Next's build assets. That already covers the API routes and Clerk's own
// `/__clerk` handshake path, so no separate matcher entry is needed for either.
export const config = {
  matcher: ["/((?!_next/).*)"],
};
