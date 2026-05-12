# 部署（pm2 / systemd）

推荐：优先使用 pm2 部署 Node.js / TypeScript 版本，见 `docs/06-deployment-pm2.md`。

说明：本文件保留 systemd 部署骨架，适用于需要由 systemd 接管的环境。你需要把 ExecStart 指向你的实际 orchestrator 可执行文件/脚本。

## 目录建议
- 配置：`/etc/blockrunnooor/`
- secrets（加密后）：`/var/lib/blockrunnooor/secrets/`
- 运行状态（可选）：`/var/lib/blockrunnooor/state/`

## systemd service 示例
创建：`/etc/systemd/system/blockrunnooor.service`

```ini
[Unit]
Description=Blockrunnooor Orchestrator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=blockrun
Group=blockrun
WorkingDirectory=/opt/blockrunnooor

EnvironmentFile=/etc/blockrunnooor/blockrunnooor.env

ExecStart=/usr/bin/env bash -lc '/opt/blockrunnooor/bin/orchestrator'

Restart=always
RestartSec=3

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/blockrunnooor /var/log/blockrunnooor
UMask=0077

[Install]
WantedBy=multi-user.target
```

## 启动/停止/查看日志
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now blockrunnooor.service
sudo systemctl status blockrunnooor.service
sudo journalctl -u blockrunnooor.service -f
sudo systemctl restart blockrunnooor.service
sudo systemctl stop blockrunnooor.service
```

## 升级流程（建议）
- 拉取代码/制品
- 验证配置（检查 env）
- `systemctl restart`
- 观察 5~10 分钟：错误率、成本、Notion 写入是否正常
- 如异常：回滚制品并重启
