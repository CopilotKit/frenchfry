import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import tsEslintPlugin from "@typescript-eslint/eslint-plugin";
import tsEslintParser from "@typescript-eslint/parser";

const sourceFiles = ["**/*.ts", "**/*.tsx"];

export default [
  {
    ignores: [
      "**/dist/**",
      "**/*.d.ts",
      "coverage/**",
      "node_modules/**",
      "skills/**"
    ]
  },
  js.configs.recommended,
  {
    files: sourceFiles,
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      },
      parser: tsEslintParser,
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname
      }
    },
    plugins: {
      "@typescript-eslint": tsEslintPlugin
    },
    rules: {
      ...tsEslintPlugin.configs["recommended-type-checked"].rules,
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/no-explicit-any": "error"
    }
  },
  eslintConfigPrettier
];
