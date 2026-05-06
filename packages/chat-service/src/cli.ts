/** Default env-driven entry. Production deployments needing custom
 *  cred-mint flows or per-deployment auth wiring should write their own
 *  thin entry that calls `createApp` from `./server` directly. See
 *  README.md "Production deployment". */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig } from "./config.js";
import { createApp } from "./server.js";
import { createStorage } from "./storage/factory.js";
import { createProvider } from "./llm/factory.js";
import { createOidcMiddleware } from "./auth/oidc.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const storage = await createStorage(config.storage);
  const provider = await createProvider(config.llmModel);

  const chatApp = createApp({
    storage,
    provider,
    jwtSecret: config.jwtSecret,
    promptDir: config.promptDir,
    jwtTtlSeconds: config.jwtTtlSeconds,
    corsOrigins: config.corsOrigins,
  });

  // Apply the OIDC middleware on POST /sessions when configured. The
  // route is unauthenticated otherwise (suitable for the demo / local
  // development; production deployments should always set OIDC_*).
  let app: Hono;
  if (config.oidc) {
    app = new Hono();
    app.use(
      "/sessions",
      createOidcMiddleware({
        ...config.oidc,
        devMode: process.env.NODE_ENV === "development",
      }),
    );
    app.route("/", chatApp);
  } else {
    app = chatApp;
  }

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`chat-service listening on port ${info.port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
