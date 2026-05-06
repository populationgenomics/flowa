import { resolve } from "node:path";

/** Absolute path to the storage root shared with chat-service. */
export function getDemoDataDir(): string {
  return resolve(process.cwd(), process.env.DEMO_DATA_DIR ?? "./demo-data");
}

/** Absolute path to the SQLite triage database. */
export function getTriageDbPath(): string {
  return resolve(getDemoDataDir(), "triage.sqlite");
}

/** Base URL of the in-process demo-gateway (Python FastAPI service).
 *
 * Defaults align with `start.ts`'s default ports. Override via
 * `DEMO_GATEWAY_URL` to point Next.js at a gateway running on a
 * non-standard host or port (e.g. when running the gateway in a
 * separate container during development). */
export function getDemoGatewayUrl(): string {
  if (process.env.DEMO_GATEWAY_URL) return process.env.DEMO_GATEWAY_URL;
  const port = process.env.DEMO_GATEWAY_PORT ?? "7702";
  return `http://localhost:${port}`;
}
