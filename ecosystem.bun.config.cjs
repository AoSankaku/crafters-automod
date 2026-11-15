const config = require("./ecosystem.config.cjs");

module.exports = {
  apps: config.apps.map((app) => ({ ...app, interpreter: "bun" })),
};
