module.exports = {
  apps: [
    {
      name: "blockrunnooor",
      script: "dist/index.js",
      cwd: __dirname,
      env: {
        BRNOO_ENV_FILE: "/etc/blockrunnooor/blockrunnooor.env"
      },
      max_restarts: 10,
      restart_delay: 3000
    }
  ]
}
