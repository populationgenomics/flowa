/**
 * Boot orchestrator: loads .env, probes the two listening ports, seeds
 * fixtures into ./demo-data/ on first boot, then launches Next.js +
 * the chat-service entry concurrently. All four are local concerns —
 * no network, no docker, no cross-process IPC beyond HTTP.
 */

import { existsSync, mkdirSync, cpSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import concurrently from "concurrently";

const __dirname = dirname(fileURLToPath(import.meta.url));
const demoRoot = resolve(__dirname, "..");

try {
  process.loadEnvFile(resolve(demoRoot, ".env"));
} catch {
  // .env is optional, but practically required for a real LLM run.
}

if (!process.env.LLM_MODEL) {
  console.error(
    "LLM_MODEL is not set. Copy .env.example to .env and uncomment one provider block.",
  );
  process.exit(1);
}

const nextPort = Number.parseInt(process.env.DEMO_NEXT_PORT ?? "7700", 10);
const chatPort = Number.parseInt(process.env.CHAT_SERVICE_PORT ?? "7701", 10);

for (const [name, port] of [
  ["DEMO_NEXT_PORT", nextPort],
  ["CHAT_SERVICE_PORT", chatPort],
] as const) {
  if (!Number.isFinite(port) || port <= 0 || port > 65_535) {
    console.error(`${name} must be a port between 1 and 65535, got: ${port}`);
    process.exit(1);
  }
  if (await isPortInUse(port)) {
    console.error(
      `Port ${port} (${name}) is already in use. Set ${name}=<other-port> in .env to override.`,
    );
    process.exit(1);
  }
}

const dataRoot = resolve(demoRoot, process.env.DEMO_DATA_DIR ?? "./demo-data");
const fixturesRoot = resolve(demoRoot, "fixtures");

if (!existsSync(dataRoot) && existsSync(fixturesRoot)) {
  console.log(`seeding ${dataRoot} from fixtures/`);
  mkdirSync(dataRoot, { recursive: true });
  cpSync(fixturesRoot, dataRoot, { recursive: true });
}

const env = {
  ...process.env,
  CHAT_SERVICE_PORT: String(chatPort),
  DEMO_NEXT_PORT: String(nextPort),
  DEMO_DATA_DIR: dataRoot,
};

const { result } = concurrently(
  [
    {
      name: "chat",
      command: "tsx scripts/chat-service.ts",
      cwd: demoRoot,
      env,
      prefixColor: "magenta",
    },
    {
      name: "next",
      command: `next dev -p ${nextPort}`,
      cwd: demoRoot,
      env,
      prefixColor: "cyan",
    },
  ],
  {
    prefix: "{name}",
    killOthers: ["failure", "success"],
    restartTries: 0,
  },
);

try {
  await result;
} catch (errors) {
  // concurrently rejects with an array of CloseEvents when a child exits
  // non-zero. Surface a tighter message and let the non-zero exit cascade.
  const list = Array.isArray(errors) ? errors : [errors];
  for (const e of list) {
    if (e && typeof e === "object" && "command" in e && "exitCode" in e) {
      console.error(
        `[${(e as { command: { name?: string } }).command.name ?? "?"}] exited with ${(e as { exitCode: number | string }).exitCode}`,
      );
    }
  }
  process.exit(1);
}

async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const tester = createServer()
      .once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          resolvePromise(true);
        } else {
          resolvePromise(false);
        }
      })
      .once("listening", () => {
        const addr = tester.address() as AddressInfo;
        if (typeof addr === "object" && addr.port === port) {
          tester.close(() => resolvePromise(false));
        } else {
          resolvePromise(false);
        }
      })
      .listen(port, "127.0.0.1");
  });
}
