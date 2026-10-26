import tseslint from "typescript-eslint";

export default [
  ...tseslint.configs.recommended,
  { ignores: ["**/node_modules/**", "**/dist/**", "target/**", "tmp/**"] },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "no-debugger": "error",
      "no-constant-condition": "error",
      "no-unreachable": "error",
    },
  },
];
