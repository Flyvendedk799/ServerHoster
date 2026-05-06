// Flat config for ESLint 9+. Run with `npm run lint`.
// This config is intentionally light-touch: it catches correctness bugs
// without arguing about style (Prettier owns formatting).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.config.js",
      "**/vite.config.ts",
      "apps/web/dist/**",
      "apps/server/dist/**",
      // Compiled JS sitting next to TS sources in apps/web. Lint the .tsx,
      // not the build output.
      "apps/web/src/**/*.js",
      "packaging/windows-service.js"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      // The dashboard already opts out of exhaustive-deps via inline
      // `// eslint-disable-next-line react-hooks/exhaustive-deps` comments
      // for hand-managed effect deps. Keep the rule loaded so those
      // directives resolve, but don't enforce it project-wide.
      "react-hooks/exhaustive-deps": "off",
      "react-hooks/rules-of-hooks": "error"
    }
  },
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
        AbortController: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly"
      }
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-constant-condition": ["error", { checkLoops: false }],
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off"
    }
  },
  {
    // Electron main process is CommonJS — needs Node globals + require().
    files: ["apps/desktop/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "readonly",
        exports: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        AbortSignal: "readonly"
      }
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off"
    }
  }
];
