# HTTP API 与命令行参考

本文对应当前实现（`omavote` 0.1.0）。协议对象的字段与校验规则以 [03](03-protocol.md)、[11](11-authorization.md) 和 `schemas/omavote-v2.schema.json` 为准；部署与运维见 [15](15-operations.md)。

## 1. 约定

- **数字与标识**：请求与响应都是 JSON。整数一律写成十进制字符串（协议 JSON 没有数字类型）；哈希与标识写成 `0x` 开头的小写十六进制。
- **标识的含义**：
  - `owner_id` 是 owner lock script 的哈希；
  - `poll_id`、`authorization_id`、`record_id` 是对应对象的哈希；
  - `key_id` 是授权密钥的标识（[11](11-authorization.md)）。
- **索引位置 `at`**：读接口返回 `at: {number, hash, clock_ms}`，即回答所依据的已索引区块。`clock_ms` 是该块的协议时钟：截至其父块的 37 个时间戳取中位数。
- **错误格式**：`{"error": {"code": "...", "detail": "..."}}`。
  - `400 BAD_REQUEST`：参数格式不对；
  - `404 NOT_FOUND`：对象不存在（未知的 `/api/...` 路径同样返回 JSON 404，不会落到前端页面）；
  - `413`：请求体超过 64 KiB；
  - `422`：提交被拒绝，码表见 §4；
  - `429`：同时进行的论坛导入过多；
  - `502`：论坛不可用；
  - `503`：节点不可用或索引未就绪。
- **跨域**：
  - `cors_origins` 为空时，GET 对任何 origin 开放（便于别家页面把本服务当作独立来源），提交只允许同源；
  - `cors_origins` 非空时，只有列出的 origin 可以跨域读取和提交。
- **安全头**：前端页面带严格 CSP。脚本只来自同源；`connect-src` 允许 HTTPS 和本机 HTTP，用于签名前比对独立来源。

## 2. 状态与网络

| 方法与路径 | 说明 |
|---|---|
| `GET /api/status` | 运行状态，字段见下 |
| `GET /api/network` | 网络参数与签名所需的固定对象，字段见下 |
| `GET /api/anchor` | 签名锚点：节点当前的最新区块（[11 §2、§5](11-authorization.md)） |
| `GET /api/diagnostics?limit=&kind=` | 复算中被拒绝或忽略的对象，最新的在前；`limit` 默认 100，最大 1000 |

`/api/status` 的字段：

| 字段 | 含义 |
|---|---|
| `version` | 软件版本 |
| `network.name`、`network.genesis_hash` | 网络名与创世块哈希 |
| `indexed`、`node_tip`、`lag_blocks` | 已索引的位置、节点高度、落后的区块数 |
| `synced`、`last_sync_ms`、`last_error` | 同步状态 |
| `reorgs.count`、`reorgs.last` | 重组次数；最近一次的时间、旧 tip、分叉高度与深度 |
| `polls`、`diagnostics` | 提案数与诊断条数 |
| `shadow_mode` | 未经治理确认时为 `true`（[15 §6](15-operations.md)） |
| `relay.intake`、`relay.receipt_key` | 是否接收提交；回执公钥 |
| `relay.queue` | 各状态的队列数 |
| `relay.oldest_in_flight_ms` | 最早一笔已广播、未收录的交易已等待的毫秒数 |
| `relay.address`、`relay.balance_shannon` | 热钱包地址与余额。只在嵌入中继、或 `serve` 能读取 `relay.key_file` 时出现；分进程部署时见 [15 §8](15-operations.md) |

`/api/network` 的字段：

| 字段 | 含义 |
|---|---|
| `network` | 网络参数：创世块哈希、地址前缀、各 lock 的 code hash |
| `genesis_cells` | secp256k1 dep group 与 DAO 代码的 out point |
| `authorization_policy` | 授权策略对象与哈希；`published` 是它在链上的位置，未发布时为 `null` |
| `default_registry` | 默认适配器注册表 |
| `default_rules` | 默认规则集 |
| `initial_roles_hash`、`current_roles` | 部署固定的初始流程角色；当前生效的角色对象 |
| `process_publication_delay_ms`、`max_control_publication_delay_ms` | 流程记录与授权控制的发布期限 |
| `receipt_key` | 回执公钥 |
| `shadow_mode` | 同 `/api/status` |

`/api/anchor` 的说明：
- **返回内容**：`{anchor: {number, hash, clock_ms, control_publication_deadline_ms, process_publication_deadline_ms}}`。
- **核对方式**：服务端先向节点读取当前高度和规范哈希，最多等 3 秒让索引追上。
- **失败返回**：
  - 索引仍落后：`503 NOT_SYNCED`；
  - 索引的 tip 不在节点规范链上：`503 REORGANIZING`；
  - 节点无响应：`503 NODE_UNAVAILABLE`。

  页面遇到 503 会等待后重试，不会用旧区块签名。

## 3. 提案、选票与授权

| 方法与路径 | 说明 |
|---|---|
| `GET /api/proposals` | 全部提案摘要，按登记高度从新到旧 |
| `GET /api/proposals/{poll_id}` | 提案详情：manifest 载荷、开始边界、关闭状态、流程记录与计票结果（`result_core`、`result_hash`） |
| `GET /api/proposals/{poll_id}/ballots?owner=` | 有效选票（可按 owner 过滤） |
| `GET /api/proposals/{poll_id}/records` | 与该提案相关的流程记录 |
| `GET /api/results/{poll_id}/bundle` | 证据包，以附件形式下载，见下 |
| `GET /api/owners/{owner_id}/power` | owner 当前的 DAO 存款与票权 |
| `GET /api/owners/{owner_id}/power?block_hash=` | owner 在某个规范区块时的存款列表与合计 |
| `GET /api/owners/{owner_id}/authorizations?policy_hash=` | 授权流：当前授权与历史；`policy_hash` 默认取本网络的授权策略 |
| `GET /api/owners/{owner_id}/ballots` | 该 owner 在各提案中的选票 |
| `GET /api/owners/{owner_id}/queued` | 本中继已接收、尚未确认的该 owner 的选票与授权控制（含信封）。签名前用它把锚点抬到排队对象之上 |
| `GET /api/address/{address}` | 由完整地址查询 owner：同 `power`，另加 `owner_lock` 与 `lock_kind`（`secp256k1_blake160`、`omnilock`、`pw_lock` 或 `other`） |
| `GET /api/authorizations/{authorization_id}` | 授权的当前状态、所在授权流与被拒绝的记录 |
| `GET /api/keys/{key_id}/authorizations` | 授予某个密钥的全部授权 |
| `GET /feed.atom` | 新提案与流程记录的 Atom 订阅（最新 100 条） |
| `GET /api/owners/{owner_id}/feed.atom` | 某个 owner 的选票与授权变化 |

`/api/owners/{owner_id}/authorizations` 只提供已索引 tip 的视图：传入其他区块的 `at_block_hash` 会返回 400，历史状态从响应的 `history` 中读取。

**证据包** `/api/results/{poll_id}/bundle` 的结构：
- **默认内容**：manifest、生效的规则与流程对象、全部有效选票及其链上位置、`result_core` 与 `result_hash`，结构见 schema。
- **`?history=true`** 再附加三项，供两个复算器离线重放：
  - `history: {from_height, to_height, from_genesis, completeness}`；
  - `blocks`：缩减后的区块，每块带 `timestamp_ms`，复算器据此自行计算时钟；
  - `bootstrap`：加速起点的种子，仅当部署不从创世块开始时出现。

  `completeness` 明确写着离线无法证明完整，要用自己的节点运行 `omavote verify-evidence --rpc` 证明。

## 4. 提交

`POST /api/envelopes`，请求体是一个协议对象（JCS 后不超过 32 KiB；选票、授权与流程信封不超过 8 KiB）。

可接收的对象：

| 识别方式 | 对象 |
|---|---|
| 含 `body.message_kind = "ballot"` | 选票信封（投票、改票、撤回） |
| 含 `body.message_kind = "authorization_control"` | 授权控制信封（GRANT、CANCEL） |
| 含 `proofs` | 流程记录信封（委员会签名） |
| 含 `manifest` | 提案登记载荷（manifest 与发起人证明） |
| `message_kind = "authorization_policy"` | 授权策略对象 |
| `message_kind = "process_roles"` | 流程角色对象 |

服务端只做预检，最终是否有效以链上复算为准。

**接受后的响应**：

| 字段 | 含义 |
|---|---|
| `status` | 见下表 |
| `duplicate` | 同一对象此前已提交过时为 `true`，返回原有的队列项 |
| `message_kind`、`object_id`、`scope_id`、`owner_id` | 对象类别与标识 |
| `tx_hash`、`block_number`、`block_hash` | 发布后的链上位置 |
| `error` | 最近一次处理的说明（例如交易被拒后正在重试） |
| `received_ms`、`envelope_hash` | 接收时间与信封哈希 |
| `receipt` | `{body, signature}`，见下 |

若对象已经在链上而本中继从未收到过，返回 `{status: "ALREADY_ON_CHAIN", message_kind, object_id}`，不签发回执。

**回执** `receipt.body`：
- 字段：`message_kind: "relay_receipt"`、`protocol_version`、`network_genesis_hash`、`relay_receipt_key`、`item_kind`、`object_id`、`envelope_hash`、`received_at_ms`、`publish_by_ms`；
- 签名：`signature` 是对 `H("OMAVOTE/RELAY-RECEIPT/V2\0" || JCS(body))` 的 secp256k1 可恢复签名。

回执只证明“某中继在某时收到了这份信封”，不是链上证明。

**队列状态**：

| 状态 | 含义 |
|---|---|
| `RECEIVED` | 已接收，等待发布 |
| `BROADCAST` | 已广播，等待收录；交易从交易池消失或被重组移出时原样重发 |
| `INCLUDED` | 已收录，确认数不足 `relay.confirmations` |
| `CONFIRMED` | 已达到确认数 |
| `ALREADY_ON_CHAIN` | 同一信封已由别的中继或帮助者发布；那笔交易若被重组掉，项目回到 `RECEIVED` |
| `EXPIRED` | 期限已过仍未收录：选票为投票截止，授权控制与流程记录为各自的发布期限，提案登记为开始时间 |

`GET /api/receipts/{object_id}` 返回同一对象的队列项与回执，用于事后查询。

**拒绝码**：拒绝时返回 HTTP 422，`code` 取以下之一。

| 码 | 含义 |
|---|---|
| `INVALID_FORMAT` | 格式、大小、规范化或期限字段不对 |
| `WRONG_NETWORK` | 对象属于另一个网络，或规则与 manifest 不一致 |
| `UNKNOWN_POLL` | 提案尚未在链上登记 |
| `LATE_MANIFEST` | 提案没有有效的开始，或开始时间已过 |
| `OUT_OF_WINDOW` | 不在投票窗口内 |
| `ANCHOR_INVALID` | 锚点不是已知的规范区块，或早于 manifest |
| `ADAPTER_NOT_ACCEPTED` | 签名适配器不被接受 |
| `INVALID_SIGNATURE` | 签名无效，或委员会签名数不足门槛 |
| `WRONG_OWNER`、`NO_ACTIVE_GRANT`、`KEY_MISMATCH` | 代理签名与授权不符 |
| `GRANT_EXPIRED`、`INVALID_TERM` | 授权已过期，或期限超出范围 |
| `PUBLICATION_EXPIRED` | 发布期限已过 |
| `POLICY_UNPUBLISHED` | 授权策略尚未发布 |
| `ROLES_MISMATCH` | 流程记录引用的不是当前生效的角色 |
| `NO_DEPOSIT_AT_CAST` | 被代表的 owner 没有有效的 DAO 存款 |
| `NOT_SPONSORED` | 不在免费赞助范围内，例如没有存款也没有授权的控制，或发起人存款低于门槛 |

另有两种 503：
- `RELAY_DISABLED`：本服务不接收提交；
- `NOT_SYNCED`：索引落后节点超过 1 块，或同步报错。

**辅助接口**：
- `POST /api/core/{method}` 通过 HTTP 调用与浏览器相同的 WASM 核心，供命令行客户端生成规范文本、哈希和签名对象。方法如 `jcs`、`ckb_hash`、`ballot`、`control`、`record`、`proposal_text`、`manifest_from_draft`、`verify_owner`，完整列表见 `crates/omavote-wasm/src/lib.rs`。
- `GET /api/forum/import?topic=` 读取 Nervos Talk 主题首帖的当前修订：
  - 输入：主题号或 `https://talk.nervos.org/t/…` 链接；
  - 访问限制：只访问 talk.nervos.org，拒绝跳转，15 秒超时，最大 2 MB，同时最多 4 个导入；
  - 返回内容：标题、修订号、原文与哈希、作者、文中出现的地址（只作为收款人候选）；
  - 不可信的部分：导入内容需要发起人逐项确认，论坛点赞数不经验证；
  - 失败时：码以 `FORUM_` 开头。输入无效返回 400，同时进行的导入过多返回 429（`FORUM_BUSY`），论坛不可用或内容不完整返回 502。

## 5. 命令行

`omavote <command> --help` 显示完整参数。

| 命令 | 作用 |
|---|---|
| `serve --config F` | 同步、复算、API、前端、接收提交；`[relay] embedded = true` 时同时发布 |
| `relay --config F` | 只运行发布者（持有热钱包密钥的独立进程） |
| `verify` | 用自己的节点复算，参数见下 |
| `verify-evidence --input F [--poll ID] [--rpc URL]` | 重放下载的证据包。离线时检查区块链接、由时间戳算出的时钟与结果；加 `--rpc` 时与自己的节点逐块比对并重新缩减，证明证据包没有遗漏或改动协议数据 |
| `network [--rpc URL] [--network-overrides F]` | 打印从创世块读出的网络参数 |
| `keygen PATH [--rpc URL]` | 生成 0600 的 secp256k1 密钥文件；给出 `--rpc` 时打印对应地址 |
| `example-config` | 打印配置样例 |
| `backup --config F --out NEW` | 在线一致性备份（不含密钥） |
| `rebuild-index --config F` | 清除链索引，保留队列与回执；`serve` 或 `relay` 运行时拒绝执行 |
| `sign --key F --format ckb\|evm --text-file F\|-` | 用密钥文件签一段文本，等同 Neuron 或 MetaMask `personal_sign` 的结果 |
| `demo`、`demo-roles` | 开发链端到端演示；演示用的确定性流程角色 |
| `devnet identity\|fund\|deposit\|balance` | 开发链辅助：由公开标签派生的测试身份、faucet 转账、DAO 存款、普通余额。拒绝在主网和测试网上运行 |

`verify` 的参数：

| 参数 | 含义 |
|---|---|
| `--rpc URL` | 自己的节点 |
| `--poll ID` | 只报告该提案；默认报告全部 |
| `--initial-roles-hash H`、`--process-delay-ms MS` | 部署参数，必须与运营者公布的一致 |
| `--network-overrides F` | 仅开发链：声明 Omnilock 与 PW Lock |
| `--to N` | 复算到该高度；默认取开始时的节点 tip |
| `--check-clock` | 每个时钟都与节点的 `get_block_median_time` 比对 |
| `--out F` | 写出该提案的证据包 |
| `--dump-blocks F` | 写出缩减后的区块，供差分测试 |
| `--from-height H [--anchor-blocks N] [--compare]` | 加速起点；`--compare` 同时从创世块重放，要求两边完全一致 |

两个复算器的差分检查：

```bash
scripts/diff-verifiers.sh http://127.0.0.1:8114 --poll 0x...
node verifier-ts/dist/cli.js replay bundle-history.json --poll 0x...
node verifier-ts/dist/cli.js check-vectors vectors/
```

TypeScript 复算器只依据文档与向量独立编写。它可以直接读取带历史的证据包，忽略多出的顶层字段，并用 `timestamp_ms` 自行计算时钟。
