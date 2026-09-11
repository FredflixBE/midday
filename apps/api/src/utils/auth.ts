import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";

export type Session = {
  user: {
    id: string;
    email?: string;
    full_name?: string;
  };
  teamId?: string;
};

type SupabaseJWTPayload = JWTPayload & {
  /** Supabase's standard top-level claim; not set on every token. */
  email?: string;
  user_metadata?: {
    email?: string;
    full_name?: string;
    [key: string]: string | undefined;
  };
};

// Primary: verify via JWKS (asymmetric ES256/RS256). jose caches the
// keyset in memory so only the first call hits the network.
const JWKS = createRemoteJWKSet(
  new URL(`${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`),
);

// Fallback: HS256 shared secret for tokens issued before key rotation.
// Remove this once the legacy JWT secret is revoked in Supabase.
const HS256_SECRET = process.env.SUPABASE_JWT_SECRET
  ? new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET)
  : null;

function extractSession(payload: JWTPayload): Session {
  const p = payload as SupabaseJWTPayload;
  return {
    user: {
      id: p.sub!,
      // `user_metadata.email` first, because that is where a signup writes it
      // and what every existing caller has been reading. The top-level claim
      // is the fallback: tokens that carry only it used to reach the API with
      // no email at all, which now decides whether someone is the developer.
      email: p.user_metadata?.email ?? p.email,
      full_name: p.user_metadata?.full_name,
    },
  };
}

export async function verifyAccessToken(
  accessToken?: string,
): Promise<Session | null> {
  if (!accessToken) return null;

  try {
    const { payload } = await jwtVerify(accessToken, JWKS);
    return extractSession(payload);
  } catch {
    // JWKS verification failed -- try HS256 fallback if configured.
  }

  if (HS256_SECRET) {
    try {
      const { payload } = await jwtVerify(accessToken, HS256_SECRET);
      return extractSession(payload);
    } catch {
      // Both methods failed.
    }
  }

  return null;
}
