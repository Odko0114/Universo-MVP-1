// @ts-check
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./e2e",
  webServer: {
    command: "npm start",
    url: "http://localhost:3000/healthz",
    reuseExistingServer: true,
  },
  use: {
    baseURL: "http://localhost:3000",
  },
});
