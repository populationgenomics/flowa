import {
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
  type Mock,
} from "vitest";
import { Hono } from "hono";
import {
  createRemoteJWKSet,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
  type KeyObject,
} from "jose";
import { createOidcMiddleware, validateOidcToken } from "../src/auth/oidc.js";

// Replace `createRemoteJWKSet` so tests don't fetch over the network.
// Module is otherwise the real jose; SignJWT, jwtVerify, generateKeyPair
// pass through.
vi.mock("jose", async () => {
  const actual = await vi.importActual<typeof import("jose")>("jose");
  return {
    ...actual,
    createRemoteJWKSet: vi.fn(),
  };
});

const ISSUER = "https://idp.test/";
const AUDIENCE = "chat-service-test";
const JWKS_URL = "https://idp.test/oidc.test/jwks.json";

// Generate the keypair once per file. The chat-service oidc module caches
// the JWKS resolver per URL at module level, so the resolver returned to
// `createRemoteJWKSet` on the first call is what every later call sees —
// reseeding per test would silently re-use the original resolver and
// validate tokens against the wrong public key.
let privateKey: KeyObject;
let publicKey: KeyObject;

beforeAll(async () => {
  const keypair = await generateKeyPair("RS256");
  privateKey = keypair.privateKey as KeyObject;
  publicKey = keypair.publicKey as KeyObject;
  const keyResolver = vi.fn().mockResolvedValue(publicKey);
  (createRemoteJWKSet as Mock).mockReturnValue(keyResolver);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function mintToken(payload: JWTPayload = {}): Promise<string> {
  return await new SignJWT({ sub: "user-1", ...payload })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

// ---------------------------------------------------------------------------
// validateOidcToken — happy path + structural failures
// ---------------------------------------------------------------------------

describe("validateOidcToken", () => {
  test("returns the decoded claims on a valid signature", async () => {
    const token = await mintToken({ email: "alice@example.com" });
    const claims = await validateOidcToken(`Bearer ${token}`, {
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(claims.sub).toBe("user-1");
    expect(claims.email).toBe("alice@example.com");
  });

  test("rejects a missing Authorization header", async () => {
    await expect(
      validateOidcToken(undefined, {
        jwksUrl: JWKS_URL,
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).rejects.toThrow(/Missing or invalid Authorization header/);
  });

  test("rejects a non-Bearer scheme", async () => {
    await expect(
      validateOidcToken("Basic abc", {
        jwksUrl: JWKS_URL,
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).rejects.toThrow(/Missing or invalid Authorization header/);
  });

  test("rejects a token signed for a different audience", async () => {
    const token = await mintToken();
    await expect(
      validateOidcToken(`Bearer ${token}`, {
        jwksUrl: JWKS_URL,
        issuer: ISSUER,
        audience: "different-audience",
      }),
    ).rejects.toThrow();
  });

  test("rejects a token with a tampered signature", async () => {
    const token = await mintToken();
    const tampered = token.slice(0, -4) + "AAAA";
    await expect(
      validateOidcToken(`Bearer ${tampered}`, {
        jwksUrl: JWKS_URL,
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// devMode behaviour
// ---------------------------------------------------------------------------

describe("validateOidcToken devMode", () => {
  test("bypasses signature verification when devMode=true and NODE_ENV != production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    // Hand-roll a JWT-shaped string with no real signature; the body is a
    // base64url-encoded JSON object the bypass branch decodes verbatim.
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
      "base64url",
    );
    const payload = Buffer.from(
      JSON.stringify({ sub: "dev-user", roles: ["admin"] }),
    ).toString("base64url");
    const token = `${header}.${payload}.signature-doesnt-matter`;
    const claims = await validateOidcToken(`Bearer ${token}`, {
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      audience: AUDIENCE,
      devMode: true,
    });
    expect(claims.sub).toBe("dev-user");
    expect(claims.roles).toEqual(["admin"]);
  });

  test("hard-fails when devMode=true and NODE_ENV=production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(
      validateOidcToken("Bearer anything.at.all", {
        jwksUrl: JWKS_URL,
        issuer: ISSUER,
        audience: AUDIENCE,
        devMode: true,
      }),
    ).rejects.toThrow(/Refusing to bypass JWT verification/);
  });
});

// ---------------------------------------------------------------------------
// createOidcMiddleware
// ---------------------------------------------------------------------------

describe("createOidcMiddleware", () => {
  test("401s on missing Authorization header", async () => {
    const app = new Hono();
    app.use(
      "*",
      createOidcMiddleware({
        jwksUrl: JWKS_URL,
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    );
    app.get("/protected", (c) => c.text("ok"));
    const res = await app.request("/protected");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Unauthorized" });
  });

  test("401s on invalid signature", async () => {
    const app = new Hono();
    app.use(
      "*",
      createOidcMiddleware({
        jwksUrl: JWKS_URL,
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    );
    app.get("/protected", (c) => c.text("ok"));
    const res = await app.request("/protected", {
      headers: { Authorization: "Bearer not.a.real.token" },
    });
    expect(res.status).toBe(401);
  });

  test("calls next() and exposes claims via context on a valid token", async () => {
    const token = await mintToken({ scope: "chat" });
    const app = new Hono<{ Variables: { oidcClaims: JWTPayload } }>();
    app.use(
      "*",
      createOidcMiddleware({
        jwksUrl: JWKS_URL,
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    );
    app.get("/protected", (c) => {
      const claims = c.get("oidcClaims");
      return c.json({ sub: claims.sub, scope: claims.scope });
    });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: "user-1", scope: "chat" });
  });
});
