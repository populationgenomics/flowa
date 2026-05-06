/**
 * Manual LLM round-trip exerciser. Boots `@flowajs/chat-service` in-process
 * with the generic deployment schema, posts a session against the fixture
 * aggregate, sends one chat turn, and prints the SSE stream so you can eye
 * the result. Intended as a "does my .env actually work" sanity check.
 *
 * Run from the repo root:
 *   pnpm --filter @flowajs/demo exercise-llm
 *
 * Requires the demo's `.env` to be populated with a working LLM provider
 * + the seeded `./demo-data/` fixture. `start.ts` seeds the fixture on
 * first boot; this script also seeds it idempotently so it can run
 * standalone.
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createApp } from "@flowajs/chat-service/server";
import { createFsStorage } from "@flowajs/chat-service/storage/fs";
import { createProvider } from "@flowajs/chat-service/llm";
import { ArtifactSchema } from "@flowajs/prompts/generic";

const __dirname = dirname(fileURLToPath(import.meta.url));
const demoRoot = resolve(__dirname, "..");

try {
  process.loadEnvFile(resolve(demoRoot, ".env"));
} catch {
  // .env is optional but practically required for this script.
}

const llmModel = process.env.LLM_MODEL;
if (!llmModel) {
  console.error(
    "LLM_MODEL is not set. Copy .env.example to .env and uncomment one provider block.",
  );
  process.exit(1);
}

const dataRoot = resolve(demoRoot, process.env.DEMO_DATA_DIR ?? "./demo-data");
const fixturesRoot = resolve(demoRoot, "fixtures");
if (!existsSync(dataRoot) && existsSync(fixturesRoot)) {
  mkdirSync(dataRoot, { recursive: true });
  cpSync(fixturesRoot, dataRoot, { recursive: true });
  console.log(`seeded ${dataRoot} from fixtures/`);
}

const promptDir = dirname(
  fileURLToPath(import.meta.resolve("@flowajs/prompts/generic")),
);

const storage = createFsStorage({ root: dataRoot });
const provider = await createProvider(llmModel);

console.log(
  `provider: ${provider.name} | model: ${llmModel}` +
    (process.env.BEDROCK_INFERENCE_PROFILE
      ? ` | inferenceProfile: ${process.env.BEDROCK_INFERENCE_PROFILE}`
      : ""),
);

const app = createApp({
  storage,
  provider,
  schema: ArtifactSchema,
  jwtSecret: randomBytes(32).toString("hex"),
  promptDir,
});

const VARIANT_ID = "F508del";
const CATEGORY = "acmg_classification";

// Read the seeded aggregate, stringify the first result as the initial
// artifact (mirroring what a UI page would do before posting /sessions).
const aggregateText = await storage.readText(
  `assessments/${VARIANT_ID}/aggregate.json`,
);
if (!aggregateText) {
  console.error(
    `No aggregate.json found at assessments/${VARIANT_ID}. Did the fixture copy step run?`,
  );
  process.exit(1);
}
const aggregate = JSON.parse(aggregateText) as {
  results: { category: string }[];
};
const result = aggregate.results.find((r) => r.category === CATEGORY);
if (!result) {
  console.error(`No result with category=${CATEGORY} in aggregate.json.`);
  process.exit(1);
}
const initialArtifact = JSON.stringify(result, null, 2);

console.log("\n--- POST /sessions ---");
const sessionRes = await app.request("/sessions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    variant_id: VARIANT_ID,
    user_id: "exercise@example.invalid",
    category: CATEGORY,
    initial_artifact: initialArtifact,
    initial_version: 0,
  }),
});
console.log(`status: ${sessionRes.status}`);
if (sessionRes.status !== 200) {
  console.error(await sessionRes.text());
  process.exit(1);
}
const session = (await sessionRes.json()) as {
  session_id: string;
  token: string;
  expires_at: string;
};
console.log(`session_id: ${session.session_id}`);

console.log("\n--- POST /chat/:id (streaming) ---");
const chatRes = await app.request(`/chat/${session.session_id}`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.token}`,
  },
  body: JSON.stringify({
    messages: [
      {
        id: "u1",
        role: "user",
        parts: [
          {
            type: "text",
            text: "Read the description, then add one short sentence to the notes section pointing out that the variant is most common in populations of European ancestry. Use a citation only if a paper supports that fact; otherwise add the sentence without a citation. Return when done.",
          },
        ],
      },
    ],
    triage_state: { claims: [], comments: [], papers_done: [] },
  }),
});
console.log(`status: ${chatRes.status}`);
if (chatRes.status !== 200 || !chatRes.body) {
  console.error(await chatRes.text());
  process.exit(1);
}

// Tee the SSE stream to stdout so we can see what the LLM actually does.
const reader = chatRes.body.getReader();
const decoder = new TextDecoder();
let totalBytes = 0;
let chunkCount = 0;
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  totalBytes += value.byteLength;
  chunkCount++;
  process.stdout.write(decoder.decode(value, { stream: true }));
}
process.stdout.write(decoder.decode());
console.log(
  `\n\n--- stream complete: ${chunkCount} chunks, ${totalBytes} bytes ---`,
);
