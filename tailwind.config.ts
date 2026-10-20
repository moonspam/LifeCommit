import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        terminal: {
          bg: "#0d1117",
          surface: "#161b22",
          border: "#30363d",
          green: "#39d353",
          "green-dim": "#26a641",
          red: "#f78166",
          blue: "#79c0ff",
          yellow: "#e3b341",
          purple: "#d2a8ff",
          gray: "#8b949e",
          white: "#c9d1d9",
        },
      },
      fontFamily: {
        mono: ["var(--font-fira)", "monospace"],
      },
      animation: {
        blink: "blink 1s step-end infinite",
        "fade-in": "fadeIn 0.3s ease-in",
      },
      keyframes: {
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
        fadeIn: {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
