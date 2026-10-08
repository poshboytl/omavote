# 部署与运维（草案）

本目录给出单机部署所需的文件，完整说明见 [运维手册](../docs/15-operations.md)，接口见 [docs/16](../docs/16-api.md)。实现只在本地开发链上运行过；正式上线前仍须完成 [docs/14](../docs/14-implementation-status.md) 中列出的真机测试、治理参数确认与人工审计（记录方式见 [docs/17](../docs/17-external-acceptance.md)）。部署默认处于影子模式（`governance_confirmed = false`），治理批准切换（[docs/18](../docs/18-governance-switch-proposal.md)）之前，结果没有治理效力。

## 组成

| 进程 | 文件 | 说明 |
|---|---|---|
| CKB 全节点 | `ckb.service` | 自有节点，RPC 只监听本机，并启用 `Indexer` 模块 |
| `omavote serve` | `omavote.service`、`omavote.example.toml` | 同步与复算、API、前端静态文件、接收信封并签发回执；只持有回执密钥，不持有资金 |
| `omavote relay` | `omavote-relay.service`、`relay.example.toml` | 中继发布进程，单独的系统用户，唯一能读取热钱包私钥的进程 |
| Caddy | `Caddyfile` | HTTPS 与请求体大小限制 |
| 开发链 | `devnet/setup.sh`、`devnet/run-demo.sh`、`devnet/run-e2e.sh` | 本地开发链、端到端演示与浏览器端到端测试 |

## 安装步骤

1. 构建：`scripts/ci.sh` 通过后运行 `scripts/package.sh`，得到含二进制、`web/dist`、验证器与 `SHA256SUMS` 的发布包，公布压缩包的 SHA-256。部署时先 `sha256sum -c SHA256SUMS`，再把 `web/dist` 放到 `web_root`。
2. 生成密钥：`omavote keygen /etc/omavote/receipt.key`、`omavote keygen /etc/omavote/relay.key --rpc http://127.0.0.1:8114`。后者打印热钱包地址。两个文件的权限都是 0600，并分属两个系统用户。
3. 热钱包只转入有限周转资金：每个载体占 139 CKB，可回收；另加手续费。余额见 `GET /api/status` 的 `relay.balance_shannon`。
4. 按治理决定填写 `[protocol]`：初始流程角色（`initial_roles_hash` 或角色文件）与流程记录发布期限；`governance_confirmed` 保持 `false`，直到治理批准切换。主网可设 `[sync] start_height` 加速起步（先用 `omavote verify --from-height H0 --compare` 核对）。更改角色、期限或起点会使服务端重建链缓存，中继队列与回执保留。
5. 启动：`systemctl enable --now ckb omavote omavote-relay caddy`。

## 备份

```bash
omavote backup --config /etc/omavote/omavote.toml --out /secure/backup/omavote-$(date +%F).sqlite
```

- 在线一致性备份，新文件权限 0600。中继队列与回执只存在数据库里，必须备份；区块缓存和 DAO 历史可以从节点重建。
- 密钥文件和配置不在备份里，另行用安全渠道备份。
- 只重建链索引（保留队列与回执）：停止 `omavote` 与 `omavote-relay` 后运行 `omavote rebuild-index --config ...`，再启动。

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
| `relay.oldest_in_flight_ms` | 最早一笔已广播、尚未收录的中继交易已等待的毫秒数 |
| `shadow_mode` | 未经治理确认时为 `true` |

分进程部署时 `serve` 读不到热钱包密钥，`relay.balance_shannon` 不出现，需用节点 RPC `get_cells_capacity` 按热钱包地址查询。

需要告警的情况：落后超过约 20 个区块、出现 `last_error`、`RECEIVED` 积压长时间不降、在途交易超过约 10 分钟未收录、余额低于约 2,000 CKB。

## 独立复核

任何人都可以只用自己的节点复算：

```bash
omavote verify --rpc http://127.0.0.1:8114 --poll 0x<poll_id> --check-clock --out bundle.json
omavote verify-evidence --input omavote-<id>-bundle-history.json --rpc http://127.0.0.1:8114
```

第二条重放页面下载的带历史证据包，并与自己的节点逐块比对。另有独立实现的 TypeScript 验证器（`verifier-ts/`），可与之交叉比对（`scripts/diff-verifiers.sh`）。
