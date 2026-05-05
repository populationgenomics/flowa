import { SignJWT, jwtVerify } from "jose";

export interface SessionClaims {
  session_id: string;
  variant_id: string;
  user_id: string;
  category: string;
}

export interface SessionTokenConfig {
  secret: string;
  ttlSeconds: number;
}

export async function signSessionToken(
  claims: SessionClaims,
  config: SessionTokenConfig,
): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + config.ttlSeconds * 1000);
  const secret = new TextEncoder().encode(config.secret);
  const token = await new SignJWT(claims as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(expiresAt)
    .setIssuedAt()
    .sign(secret);
  return { token, expiresAt };
}

export async function verifySessionToken(
  token: string,
  config: SessionTokenConfig,
): Promise<SessionClaims & { expiresAt: Date }> {
  const secret = new TextEncoder().encode(config.secret);
  const { payload } = await jwtVerify(token, secret);
  return {
    session_id: payload.session_id as string,
    variant_id: payload.variant_id as string,
    user_id: payload.user_id as string,
    category: payload.category as string,
    expiresAt: new Date((payload.exp as number) * 1000),
  };
}
