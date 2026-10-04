import typescriptParser from "@typescript-eslint/parser";

export default [{
  files: ["src/**/*.ts"],
  languageOptions: {
    parser: typescriptParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
  rules: {
    "eqeqeq": ["error", "always"],
    "no-duplicate-case": "error",
    "no-dupe-args": "error",
    "no-unreachable": "error",
    "valid-typeof": "error",
  },
}];
