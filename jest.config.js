const nextJest = require("next/jest");

const createJestConfig = nextJest({
  // Path to the Next.js app so next/jest can load next.config.js and .env files.
  dir: "./",
});

/** @type {import('jest').Config} */
const customJestConfig = {
  // Pure logic modules run fine on the node environment. Switch a specific
  // test file to jsdom with a top-of-file `@jest-environment jsdom` docblock
  // when testing React components.
  testEnvironment: "node",
  // Only treat files under __tests__ or *.test.* / *.spec.* as tests.
  testMatch: ["**/__tests__/**/*.[jt]s?(x)", "**/?(*.)+(spec|test).[jt]s?(x)"],
  // Map the same path aliases the app would use, if any are added later.
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
  collectCoverageFrom: ["lib/**/*.{js,jsx}", "!**/node_modules/**", "!**/.next/**"],
};

module.exports = createJestConfig(customJestConfig);
