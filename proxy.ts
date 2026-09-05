import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  SOURCE_URL,
  landingRedirectEnabled,
  shouldRedirectToSource,
} from "@/lib/deployment/landing-redirect";

export function proxy(request: NextRequest) {
  if (!landingRedirectEnabled()) {
    return NextResponse.next();
  }

  if (!shouldRedirectToSource(request.nextUrl.pathname, request.headers.get("host"))) {
    return NextResponse.next();
  }

  return NextResponse.redirect(SOURCE_URL, 302);
}

export const config = {
  matcher: ["/((?!_next/).*)"],
};
