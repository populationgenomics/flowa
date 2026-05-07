import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

const config: Config = {
  content: [
    "./src/**/*.{ts,tsx}",
    // The consumed @flowajs/react-viewer package ships JS classes that the
    // demo renders. In a workspace install, pnpm resolves the dep to the
    // package's source — Tailwind's JIT must scan it so the classes used
    // there end up in the final stylesheet. Cover both the source tree
    // (workspace symlink) and the dist output (published-style install).
    "../../packages/react-viewer/src/**/*.{ts,tsx}",
    "../../packages/react-viewer/dist/**/*.{js,mjs,cjs}",
  ],
  theme: {
    extend: {},
  },
  plugins: [typography],
};

export default config;
