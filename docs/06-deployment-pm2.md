# 部署（pm2）

目标：在一台 VPS 上以 Node.js / TypeScript 形式常驻运行 orchestrator，由 pm2 管理进程与日志。

## 目录建议
- 安装目录：`/opt/blockrunnooor/`
- 配置目录：`/etc/blockrunnooor/`
- 账号配置目录：`/etc/blockrunnooor/accounts/`
- 运行状态：`/var/lib/blockrunnooor/state/`
- 钱包清单：`/var/lib/blockrunnooor/wallets/`
- secrets（可选，加密后）：`/var/lib/blockrunnooor/secrets/`

## 安装与构建（示例）
```bash
git clone https://github.com/RohanKishibeCN/Blockrunnooor /opt/blockrunnooor
cd /opt/blockrunnooor
npm ci
npm run build
```

## pm2 配置（ecosystem）
建议提供 `ecosystem.config.cjs`，以便固定入口脚本与环境变量加载方式。

```js
module.exports = {
  apps: [
    {
      name: "blockrunnooor",
      script: "dist/index.js",
      cwd: "/opt/blockrunnooor",
      env: {
        BRNOO_STATE_DB_PATH: "/var/lib/blockrunnooor/state/state.db",
        BRNOO_ACCOUNTS_DIR: "/etc/blockrunnooor/accounts",
      },
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
}
```

## 启动/停止/查看日志
```bash
pm2 start /opt/blockrunnooor/ecosystem.config.cjs
pm2 status
pm2 logs blockrunnooor --lines 200
pm2 restart blockrunnooor
pm2 stop blockrunnooor
```

## 升级流程（建议）
```bash
cd /opt/blockrunnooor
git pull --rebase
npm ci
npm run build
pm2 restart blockrunnooor
pm2 logs blockrunnooor --lines 200
```
