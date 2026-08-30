import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { SOURCE_URL, shouldRedirectToSource } from "@/lib/deployment/landing-redirect";

export function proxy(request: NextRequest) {
  if (!shouldRedirectToSource(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  return NextResponse.redirect(SOURCE_URL, 302);
}

export const config = {
  matcher: ["/((?!_next/).*)"],
};
