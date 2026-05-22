import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  // No Preflight: consumers manage base/reset styles themselves. The shell
  // composes Mantine components, and Mantine ships its own reset. Including
  // Preflight would fight Mantine's defaults in every consumer.
  corePlugins: {
    preflight: false,
  },
  plugins: [],
};

export default config;
