import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: { mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"] },
    },
  },
} satisfies Config;
