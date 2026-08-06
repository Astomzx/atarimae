import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Unused args are fine when prefixed with _, which is how we mark
      // deliberately-ignored callback parameters.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // Floating promises are the single most common source of silent failures
      // in a Fastify + background worker codebase. Never downgrade to a warning.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",

      // Permission checks must not be written against `any`.
      "@typescript-eslint/no-explicit-any": "error",

      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },

  // Build and test configuration files sit outside their package's tsconfig
  // include, so type-aware rules cannot resolve them.
  {
    files: ["**/*.config.ts", "**/*.config.mts", "**/*.config.js", "**/*.config.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node,
    },
  },

  // CLI entry points legitimately write to stdout.
  {
    files: ["scripts/**", "apps/server/src/openapi.ts"],
    rules: {
      "no-console": "off",
    },
  },

  // Plain Node scripts: no tsconfig project, Node globals.
  {
    files: ["scripts/**/*.mjs", "*.js", "*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node,
      sourceType: "module",
    },
  },

  prettier,
);
