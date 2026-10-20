import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  ...nextCoreWebVitals,
  {
    ignores: ["android/**", "out/**", ".next/**"],
  },
];

export default eslintConfig;
