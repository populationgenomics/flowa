/**
 * Boot orchestrator: loads .env, probes the three listening ports, seeds
 * fixtures into ./demo-data/ on first boot, then launches Next.js,
 * chat-service, and demo-gateway concurrently. All three are local
 * concerns — no network, no docker, no cross-process IPC beyond HTTP.
 */

import { existsSync, mkdirSync, cpSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
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

// demo-gateway is a uv-managed Python project. Probe for uv early so the
// failure mode is a one-liner pointing at the install docs, not an opaque
// "command not found" deep inside `concurrently`'s child-process output.
const uvProbe = spawnSync("uv", ["--version"], { stdio: "ignore" });
if (uvProbe.status !== 0) {
  console.error(
    "uv is not on PATH. Install it via https://docs.astral.sh/uv/getting-started/installation/ (or `brew install uv` / `pip install uv`).",
  );
  process.exit(1);
}

const nextPort = Number.parseInt(process.env.DEMO_NEXT_PORT ?? "7700", 10);
const chatPort = Number.parseInt(process.env.CHAT_SERVICE_PORT ?? "7701", 10);
const gatewayPort = Number.parseInt(
  process.env.DEMO_GATEWAY_PORT ?? "7702",
  10,
);

for (const [name, port] of [
  ["DEMO_NEXT_PORT", nextPort],
  ["CHAT_SERVICE_PORT", chatPort],
  ["DEMO_GATEWAY_PORT", gatewayPort],
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

// pdfjs worker + cmaps must live under public/ for the viewer page to
// reach them. The pnpm workspace's `ignore-scripts=true` policy
// suppresses pdfjs-dist's postinstall, and our own postinstall could
// also be skipped, so re-run the copy idempotently on every boot.
const pdfjsCopy = spawnSync(
  "pnpm",
  ["exec", "tsx", "scripts/copy-pdfjs-assets.ts"],
  { cwd: demoRoot, stdio: "inherit" },
);
if (pdfjsCopy.status !== 0) {
  console.error("failed to copy pdfjs assets into public/pdfjs/");
  process.exit(1);
}

// Translate LLM_MODEL + BEDROCK_INFERENCE_PROFILE into the FLOWA_* shape
// pydantic-settings expects on the Python side. Provider creds (AWS_*,
// ANTHROPIC_API_KEY, GOOGLE_*, OPENAI_API_KEY) are read by each SDK
// directly via standard env-var names — no translation needed.
const llmModel = process.env.LLM_MODEL;
const bedrockProfile = process.env.BEDROCK_INFERENCE_PROFILE;
// flowa's prompt loader resolves `./prompts` relative to cwd by default,
// which is wrong here because demo-gateway runs from `examples/demo/`.
// Point it at the in-tree prompt set explicitly via the absolute path.
const flowaPromptDir = resolve(demoRoot, "..", "..", "prompts");
const flowaEnv: Record<string, string> = {
  FLOWA_STORAGE_BASE: dataRoot,
  FLOWA_EXTRACTION_MODEL__NAME: llmModel,
  FLOWA_CONVERT_MODEL__NAME: llmModel,
  FLOWA_PROMPT_DIR: flowaPromptDir,
};
if (bedrockProfile) {
  flowaEnv.FLOWA_EXTRACTION_MODEL__BEDROCK_INFERENCE_PROFILE = bedrockProfile;
  flowaEnv.FLOWA_CONVERT_MODEL__BEDROCK_INFERENCE_PROFILE = bedrockProfile;
}

const env = {
  ...process.env,
  CHAT_SERVICE_PORT: String(chatPort),
  DEMO_NEXT_PORT: String(nextPort),
  DEMO_GATEWAY_PORT: String(gatewayPort),
  DEMO_DATA_DIR: dataRoot,
  ...flowaEnv,
};

const gatewayRoot = resolve(demoRoot, "..", "demo-gateway");

const { result } = concurrently(
  [
    {
      // `@flowajs/react-viewer` is consumed via its `exports` map, which
      // points at `dist/`. Without a watcher, source edits in
      // `packages/react-viewer/src/` are invisible to Next dev until
      // the package is rebuilt manually. Run tsup in watch mode so
      // every src edit re-emits dist/ and Next picks it up via its
      // own HMR.
      name: "viewer",
      command: "pnpm --filter @flowajs/react-viewer build:watch",
      cwd: demoRoot,
      env,
      prefixColor: "blue",
    },
    {
      name: "chat",
      command: "tsx scripts/chat-service.ts",
      cwd: demoRoot,
      env,
      prefixColor: "magenta",
    },
    {
      name: "gateway",
      // `uv run` starts in the demo-gateway project's environment; the
      // `--project` flag makes it work even when invoked from a
      // different cwd, so the demo doesn't have to chdir before spawn.
      command: `uv run --project ${JSON.stringify(gatewayRoot)} demo-gateway`,
      cwd: demoRoot,
      env,
      prefixColor: "yellow",
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
    killOthersOn: ["failure", "success"],
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
