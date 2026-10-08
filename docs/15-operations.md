# 运维手册：构建、部署、监控与恢复

本手册对应当前实现（`omavote` 0.1.0）。部署默认处于**影子模式**：在既有治理流程批准切换（[18](18-governance-switch-proposal.md)）之前，所有提案、投票与结果都没有治理效力。命令与接口的完整清单见 [16](16-api.md)，外部验收的记录方式见 [17](17-external-acceptance.md)。

## 1. 组成

| 进程 | 作用 | 持有的秘密 |
|---|---|---|
| CKB 全节点 | 规范链与 Indexer；RPC 只监听本机或私网 | 无 |
| `omavote serve` | 同步与复算、API、前端静态文件、接收信封并签发回执；`[relay] embedded = true` 时同时发布 | 回执密钥（不持有资金）；嵌入中继时还有热钱包密钥 |
| `omavote relay` | 单独的发布进程（推荐生产使用），与 `serve` 共用数据库 | 热钱包密钥 |
| Caddy | HTTPS、请求体大小限制 | TLS 证书 |

同一个数据库只允许一个 `serve`、一个发布者：两者分别在数据库旁持有 `<db>.lock` 与 `<db>.relay.lock`，第二个进程会拒绝启动。两个发布者共用队列和赞助资金会互相抢 cell。镜像或备用中继使用自己的数据库、回执密钥和赞助账户。

## 2. 构建与发布包

```bash
scripts/ci.sh        # fmt、clippy -D warnings、全部测试、RustSec、两套验证器、前端
scripts/package.sh   # output/releases/omavote-<commit>-<arch>.tar.gz 及 .sha256
```

发布包内容：
- `bin/omavote`；
- `web/dist`；
- 已构建的 `verifier-ts`（不含依赖，使用前在其目录运行 `npm ci --omit=dev`）；
- `docs/`、`schemas/`、`vectors/`、`deploy/` 与开发链证据；
- `BUILD.txt`：源码 commit、未提交改动、rustc/node 版本与平台；
- `SHA256SUMS`。

解包后先运行 `sha256sum -c SHA256SUMS`，再对比公布的压缩包 SHA-256。二进制只在构建平台的 libc 上验证过。

## 3. 节点

- 自有、已完成区块验证的 CKB 全节点，启用 RPC `Indexer` 模块，保留完整历史 witness。
- 生产环境不要启用 `IntegrationTest`（它允许截断链，只用于开发链测试）。
- RPC 只对本机或私网开放。Omavote 只读节点、只广播交易，不修改节点配置。

## 4. 配置（TOML，相对路径以配置文件所在目录为准）

`omavote example-config` 输出完整样例。

| 键 | 含义 |
|---|---|
| `node.rpc`、`node.poll_interval_ms` | 自有节点 RPC；轮询间隔 |
| `network.omnilock` / `network.pw_lock` | 仅开发链可声明；主网与测试网使用固定注册表，覆盖会被拒绝 |
| `protocol.initial_roles_hash` 或 `initial_roles_file` | 由切换提案固定的初始流程角色；未设置时没有任何人能签流程记录 |
| `protocol.process_publication_delay_ms` | 流程记录发布期限（候选 72 小时），须按批准值设置 |
| `protocol.governance_confirmed` | 默认 `false`（影子模式）。仅在治理批准切换后改为 `true`；它只控制标签，不改变任何计算 |
| `server.listen` / `database` / `web_root` | API 地址、SQLite 路径、前端目录 |
| `server.receipt_key_file` | 回执签名密钥；缺省时不接收提交 |
| `server.cors_origins` | 允许跨域提交的完整 origin。空表示：GET 对任何 origin 开放，提交只允许同源 |
| `relay.embedded` / `key_file` | 是否在 `serve` 内发布；热钱包密钥文件 |
| `relay.fee_rate` / `interval_ms` / `confirmations` / `max_carriers_per_tx` | 费率（shannon/1000 字节）、发布间隔、回执标为 CONFIRMED 的确认数、每笔交易的载体数上限 |
| `sync.start_height` / `anchor_blocks` | 加速起点 H0 与保留的锚点区块数（见 §7） |

以下设置构成“复算设置”：网络参数、初始角色、流程期限、`start_height`。改变其中任何一项，服务端会清空链缓存并从节点重建。中继队列与回执保留。

## 5. 密钥

```bash
omavote keygen /etc/omavote/receipt.key
omavote keygen /etc/omavote/relay.key --rpc http://127.0.0.1:8114   # 打印热钱包地址
```

- **权限与归属**：两个文件权限都是 0600，分属不同的系统用户：`omavote-relay` 只读 `relay.key`。
- **热钱包资金**：只放有限周转资金。每个载体占 139 CKB，后续交易会回收；另付手续费。余额的查看方式见 §8。
- **禁放的密钥**：不要把 owner、委员会或金库密钥放到服务器上。委员会成员用自己的钱包签流程记录；确需离线签名时可用 `omavote sign --key FILE --format ckb|evm`。
- **开发链密钥**：开发链的 faucet 与测试身份（`omavote devnet …`）派生自公开标签，任何时候都不能接收真实资金。

## 6. 影子模式与正式切换

`governance_confirmed = false` 时，`/api/status` 与 `/api/network` 返回 `shadow_mode: true`，页面顶部显示“影子模式”横幅。影子期间旧平台仍是唯一正式入口，两边票数不相加。

切换步骤见 [18](18-governance-switch-proposal.md)：
1. 治理批准初始角色、参数与生效边界；
2. 运营者按批准文件填写配置并发布不可变软件包；
3. 设置 `governance_confirmed = true`，用新数据库启动。

这个布尔值只是标签，不能证明合法性。

## 7. 上线边界 H0 与加速起点

H0 是第一块可能含 Omavote 协议对象的区块。H0 及以下不得已有 policy、角色、manifest 或授权。

```bash
omavote verify --rpc http://127.0.0.1:8114 --from-height H0 --compare --check-clock \
  --initial-roles-hash 0x... --poll 0x...
```

`--compare` 同时做基准回放（从创世块），要求 H0 处存款集合相同、H0 之后登记的提案结果相同。通过后设置 `[sync] start_height = H0`。

首次启动时，服务端从自有节点的 Indexer 推导 H0 处的 DAO 存款集合：
- 固定 tip 下的存活存款；
- 加上 H0 之后才被花费、需从花费交易还原的旧存款。

推导结果保存在数据库中，重启时复用。若链重组到 H0 以下，同步会报错（见 `last_error`），需停服后运行 `omavote rebuild-index` 重新推导。

## 7.1 用户的独立来源

页面签名前，会把本服务器的最新区块与一个独立来源比对（[11 §5](11-authorization.md)），高度和哈希都一致才签名。
- **主网与测试网**：未配置独立来源时页面拒绝签名。
- **运营者应在构建时提供默认来源**：例如另一家运营者的 `https://…/api/status`，构建时设 `VITE_TIP_SOURCE`。用户也可在「设置」中改为自己节点的 RPC。
- **对外提供来源**：本服务的 GET 接口对任何 origin 开放 CORS，可以作为别家页面的独立来源。

## 8. 监控

`GET /api/status`：

| 字段 | 告警条件（建议） |
|---|---|
| `indexed`、`node_tip`、`lag_blocks` | 落后超过约 20 块 |
| `synced`、`last_error` | `last_error` 非空超过 1 分钟 |
| `reorgs.count`、`reorgs.last.depth` | 出现深度 ≥ 3 的重组 |
| `relay.queue.RECEIVED` | 积压长时间不降 |
| `relay.oldest_in_flight_ms` | 超过约 10 分钟 |
| `relay.balance_shannon` | 低于约 2,000 CKB（见下） |
| `shadow_mode` | 与部署意图不符 |

分进程部署时 `serve` 读不到热钱包密钥，`relay.address` 与 `relay.balance_shannon` 不出现；用节点 RPC `get_cells_capacity` 按 `keygen` 打印的地址查询余额。

`/api/anchor` 在索引落后于节点或不在节点规范链上时返回 503，签名会等待，这在出块瞬间是正常现象。持续 503 表示节点或索引有问题。日志写到标准错误，systemd 下用 `journalctl -u omavote -f` 查看。

## 9. 备份与恢复

```bash
omavote backup --config /etc/omavote/omavote.toml --out /secure/backup/omavote-$(date +%F).sqlite
```

- **备份方式**：在线一致性复制（SQLite backup API，含完整性检查），新文件权限 0600。
- **密钥另行备份**：备份文件不含密钥，回执密钥、热钱包密钥和配置要另行用安全渠道备份。
- **必须保留的部分**：中继队列与回执不能重建，必须备份；链缓存可以随时从节点重建。
- **不要直接复制**：不要复制运行中的 `.sqlite` 而漏掉 WAL 文件。

**恢复**：
1. 安装同一版本；
2. 放回配置、两把密钥和数据库副本；
3. 启动 `serve`。

服务端回放缓存并与节点核对 tip。若有区块已不在规范链上，发布者会把相关项退回队列重发；锚点被孤立的消息需要用户重签。

**只重建链索引**：

```bash
systemctl stop omavote omavote-relay
omavote rebuild-index --config /etc/omavote/omavote.toml
systemctl start omavote omavote-relay
```

它清除区块缓存、DAO 历史和加速起点，保留中继队列与回执。`serve` 或 `relay` 在运行时，命令会拒绝执行。

更换链、初始角色、流程期限或 H0 时，服务端会自动重建链缓存。若要完全切换到另一个部署，使用新数据库，并先导出旧回执供审计。

## 10. 升级

1. 备份数据库与密钥。
2. 校验新发布包的 SHA-256 与 `SHA256SUMS`。
3. 停止服务，替换二进制与 `web/dist`，启动。
4. 观察 `/api/status` 回到 synced。
5. 用 `omavote verify` 和 `scripts/diff-verifiers.sh` 对已有提案复算，核对结果哈希没有变化。

线格式、schema 或结果字段的任何变化，必须发布新向量和版本说明，不能静默改写已签对象。

## 11. 中继与故障切换

- **免费与平等**：用户的授权、投票、改票、撤回全部免费，YES/NO/CANCEL 一视同仁。
- **发布节奏**：中继每次只有一笔交易在途；在途交易被重组或丢弃时会原样重发。
- **识别他人已发布的信封**：同一信封已由别的中继或帮助者上链时，队列项标为 `ALREADY_ON_CHAIN`，不重复发布；若那笔交易随后被重组掉，再回到队列由本中继发布。
- **故障切换**：信封与中继无关，原中继停机时可以换中继：
  1. 用户在「设置」中把服务器地址换成另一家中继；
  2. 在「回执」页把本机保存的同一份已签信封重新提交，无需重签。

  备用中继需要在 `cors_origins` 中允许原页面的 origin，或者用户直接打开备用中继自己的页面。
- **运营者的准备**：在投票窗口之前准备至少一家独立运营的备用中继，并演练一次切换（[17](17-external-acceptance.md)）。

## 12. 开发链

```bash
deploy/devnet/setup.sh      # 下载 ckb v0.210.0，初始化开发链（固定 genesis），启动节点与矿工
deploy/devnet/run-demo.sh   # 端到端演示：存款、授权、投票、重组、复算
deploy/devnet/run-e2e.sh    # 浏览器端到端（桌面与手机）
```

开发链启用了 `IntegrationTest` RPC，用于重组测试。所有开发链密钥都是公开的测试密钥。
