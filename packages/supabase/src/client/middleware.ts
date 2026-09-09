import { createServerClient } from "@supabase/ssr";
import type { NextRequest, NextResponse } from "next/server";

export async function updateSession(
  request: NextRequest,
  response: NextResponse,
) {
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }

          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Same suppression as the server client, for the same reason and one more.
  //
  // getClaims() below verifies the JWT's signature against the project's JWKS,
  // so nothing here trusts the cookie for authentication. The warning fires
  // anyway because proxy.ts calls mfa.getAuthenticatorAssuranceLevel() on
  // every request, and that reads user.factors off the stored session — a
  // read inside the library, not application code trusting cookie data.
  //
  // The caveat, recorded in FF-1441: that AAL check derives nextLevel from
  // those unverified factors, while currentLevel comes from the verified
  // token. Someone already signed in could strip factors from their own
  // cookie and skip their own MFA prompt. Closing it means getUser() — a
  // round trip to the Auth server on every request — which is why upstream
  // does not.
  // @ts-expect-error - suppressGetSessionWarning is a protected property
  supabase.auth.suppressGetSessionWarning = true;

  // Do not run code between createServerClient and getClaims().
  // A simple mistake could make it very hard to debug issues with
  // users being randomly logged out.
  //
  // getClaims() validates the JWT signature against the project's
  // published JWKS and refreshes expired tokens. Never trust
  // getSession() inside server code — it isn't guaranteed to
  // revalidate the Auth token.
  const { data, error } = await supabase.auth.getClaims();
  const isAuthenticated = !!data && !error;

  return {
    response,
    isAuthenticated,
    supabase,
  };
}
