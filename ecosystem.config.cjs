module.exports = {
  apps: [
    {
      name: "blockrunnooor",
      script: "dist/index.js",
      cwd: "/opt/blockrunnooor",
      env: {
        BRNOO_STATE_DB_PATH: "/var/lib/blockrunnooor/state/state.db",
        BRNOO_ACCOUNTS_DIR: "/etc/blockrunnooor/accounts"
      },
      max_restarts: 10,
      restart_delay: 3000
    }
  ]
}
