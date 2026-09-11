"use strict";
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.js",
  timeout: 180_000,
  expect: { timeout: 8000 },
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { browserName: "chromium", headless: true, viewport: { width: 1440, height: 1000 }, actionTimeout: 15_000, navigationTimeout: 15_000, trace: "retain-on-failure" },
});
