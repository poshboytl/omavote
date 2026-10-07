# 部署与运维（草案）

本目录给出单机部署所需的文件。实现只在本地开发链上运行过；正式上线前仍须完成 [docs/14](../docs/14-implementation-status.md) 中列出的真机测试、治理参数确认与人工审计。

## 组成

| 进程 | 文件 | 说明 |
|---|---|---|
| CKB 全节点 | `ckb.service` | 自有节点，RPC 只监听本机，并启用 `Indexer` 模块 |
| `omavote serve` | `omavote.service`、`omavote.example.toml` | 同步与复算、API、前端静态文件、接收信封并签发回执；只持有回执密钥，不持有资金 |
| `omavote relay` | `omavote-relay.service`、`relay.example.toml` | 中继发布进程，单独的系统用户，唯一能读取热钱包私钥的进程 |
| Caddy | `Caddyfile` | HTTPS 与请求体大小限制 |
| 开发链 | `devnet/setup.sh`、`devnet/run-demo.sh` | 本地开发链与端到端演示 |

## 安装步骤

1. 构建：`cargo build --release --locked -p omavote`，并公布 `target/release/omavote` 的 SHA-256。前端：`cd web && npm ci && npm run wasm && npm run build`，把 `web/dist` 复制到 `web_root`。
2. 生成密钥：`omavote keygen /etc/omavote/receipt.key`、`omavote keygen /etc/omavote/relay.key --rpc http://127.0.0.1:8114`。后者打印热钱包地址。两个文件的权限都是 0600，并分属两个系统用户。
3. 热钱包只转入有限周转资金：每个载体占 139 CKB，可回收；另加手续费。余额见 `GET /api/status` 的 `relay.balance_shannon`。
4. 按治理决定填写 `[protocol]`：初始流程角色（`initial_roles_hash` 或角色文件）与流程记录发布期限。更改这两项会使服务端重建链上派生数据。
5. 启动：`systemctl enable --now ckb omavote omavote-relay caddy`。

## 备份

- **必须备份**：两个密钥文件、配置文件，以及数据库中的中继队列与回执（`relay_items`、`relay_txs` 表）。
- **无需备份**：区块缓存和 DAO 历史都可从节点重建，删除数据库后会自动重新同步。

## 监控

`GET /api/status` 返回以下字段：

| 字段 | 含义 |
|---|---|
| `indexed` | 已索引的高度与哈希 |
| `node_tip`、`lag_blocks` | 节点高度与落后的区块数 |
| `synced`、`last_error` | 同步状态与最近一次错误 |
| `reorgs` | 链重组次数与最近一次的深度 |
| `relay.queue` | 各状态的队列数 |
| `relay.balance_shannon` | 热钱包余额 |

需要告警的情况：落后超过约 20 个区块、出现 `last_error`、`RECEIVED` 积压长时间不降、余额低于约 2,000 CKB。

## 独立复核

任何人都可以只用自己的节点复算：

```bash
omavote verify --rpc http://127.0.0.1:8114 --poll 0x<poll_id> --check-clock --out bundle.json
```

另有独立实现的 TypeScript 验证器（`verifier-ts/`），可与之交叉比对。
