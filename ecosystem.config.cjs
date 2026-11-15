const path = require("node:path");

module.exports = {
  apps: [{
    name: "crafters-automod",
    cwd: __dirname,
    script: path.join(__dirname, "dist", "index.js"),
    interpreter: "node",
    exec_mode: "fork",
    instances: 1,
    force: false,
    watch: false,
    pmx: false,
    autorestart: true,
    restart_delay: 10000,
    min_uptime: 30000,
    max_restarts: 10,
    kill_timeout: 30000,
    shutdown_with_message: true,
    env: { NODE_ENV: "production" },
  }],
};
