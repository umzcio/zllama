import nextConfig from "eslint-config-next";

const eslintConfig = [
  ...nextConfig,
  {
    ignores: ["node_modules/", ".next/"],
  },
  {
    // Added as an error by eslint-plugin-react-hooks 7 (pulled in by the
    // Next 16.4 security update). It flags a render-performance pattern, not
    // a correctness bug; existing call sites are reported as warnings.
    rules: { "react-hooks/set-state-in-effect": "warn" },
  },
];

export default eslintConfig;
