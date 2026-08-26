/**
 * Cookie plumbing for the auth routes.
 *
 * The route handlers read cookies off the Request and write them as Set-Cookie headers,
 * rather than going through next/headers. Both are supported, but this way a handler is a
 * plain function from Request to Response, which is what lets the login callback be tested
 * end to end instead of only through its helpers.
 */
export type CookieOptions = {
  maxAge: number;
  secure: boolean;
};

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;

    return decodeURIComponent(part.slice(eq + 1).trim());
  }

  return undefined;
}

function serialize(name: string, value: string, { maxAge, secure }: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");

  return parts.join("; ");
}

export function setCookie(name: string, value: string, options: CookieOptions): string {
  return serialize(name, value, options);
}

/** Expire a cookie. Same attributes as the one that set it, or the browser keeps both. */
export function clearCookie(name: string, secure: boolean): string {
  return serialize(name, "", { maxAge: 0, secure });
}

/** A redirect that can carry Set-Cookie. Response.redirect returns immutable headers. */
export function redirect(location: string, cookies: string[] = [], status = 302): Response {
  const headers = new Headers({ location });
  for (const cookie of cookies) headers.append("set-cookie", cookie);

  return new Response(null, { status, headers });
}
