import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { MiddlewareHandler } from "hono";

export interface OidcValidatorConfig {
  jwksUrl: string;
  issuer: string;
  audience: string;
  /**
   * When true, decode the JWT body without verifying the signature. Useful
   * for local development against a stub IDP. NEVER enable in production —
   * the token is trusted as-is.
   */
  devMode?: boolean;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(url: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, jwks);
  }
  return jwks;
}

/**
 * Validate a Bearer token from an Authorization header against an OIDC
 * IDP. Returns the decoded claims on success; throws on missing header,
 * malformed token, or signature/audience/issuer mismatch.
 *
 * Generic over IDP — works against any OIDC-compliant provider (Auth0,
 * Keycloak, Okta, GitHub, etc.).
 */
export async function validateOidcToken(
  authHeader: string | undefined,
  config: OidcValidatorConfig,
): Promise<JWTPayload> {
  if (config.devMode && process.env.NODE_ENV === "production") {
    // Hard fail rather than degrade to insecure validation in prod.
    throw new Error(
      "OIDC devMode is enabled but NODE_ENV=production. Refusing to bypass JWT verification.",
    );
  }

  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing or invalid Authorization header");
  }
  const token = authHeader.slice(7);

  if (config.devMode) {
    const [, payloadB64] = token.split(".");
    if (!payloadB64) throw new Error("Invalid token format");
    return JSON.parse(
      Buffer.from(payloadB64, "base64url").toString(),
    ) as JWTPayload;
  }

  const { payload } = await jwtVerify(token, getJwks(config.jwksUrl), {
    audience: config.audience,
    issuer: config.issuer,
  });
  return payload;
}

/**
 * Hono middleware factory that validates the Authorization header against
 * the configured OIDC IDP. The decoded claims are stored on the context
 * variable `oidcClaims` for downstream handlers to read via
 * `c.get("oidcClaims")`.
 */
export function createOidcMiddleware(
  config: OidcValidatorConfig,
): MiddlewareHandler {
  return async (c, next) => {
    try {
      const claims = await validateOidcToken(
        c.req.header("Authorization"),
        config,
      );
      c.set("oidcClaims", claims);
    } catch {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return next();
  };
}
