# 技术方案与里程碑 v0.1

日期：2026-10-08。依据：[03 主协议](03-protocol.md)与 [11 授权规范](11-authorization.md)定义的未部署 V2 草案。实施者：Claude 单人。本文件把设计落到可执行的工程计划；协议语义仍以 03/11 为准，本文 §4 补定的编码细节在 V2 冻结时并入 03。

## 1. 技术选型

| 部分 | 选择 | 理由 |
|---|---|---|
| 协议核心 | Rust，只用纯 Rust 依赖，同时编译成 WASM | 票面渲染、哈希、验签和状态机只写一份；服务端、命令行验证器和浏览器用同一份代码，签名文本逐字节一致 |
| 服务端 | Rust 单二进制：tokio + axum + SQLite（rusqlite，静态链接） | 一个文件加 systemd 就能运行；嵌入式数据库不需另起服务；CKB 官方类型与哈希都有 Rust crate |
| 链数据 | 自有 CKB 全节点的 JSON-RPC | 规范要求从自己的节点取历史，公共 RPC 只能加速 |
| 前端 | React + TypeScript + Vite，调用核心的 WASM | 纯静态站点，可镜像；MetaMask 走 EIP-1193 `personal_sign`，Neuron 走复制粘贴 |
| 独立验证器 | TypeScript + CCC（另一套 CKB SDK） | 不复用 Rust 代码，只依据规范和测试向量，与主实现做差分比对 |
| 部署 | omavote 二进制 + ckb 节点 + Caddy（HTTPS） | 三个进程，全部是单文件程序 |

不选全 TypeScript 的原因：全链回放性能较弱，用不上官方 Rust crate。

## 2. 仓库结构

```text
Cargo.toml                 Rust workspace
crates/omavote-core/       协议核心：无 IO、确定性
crates/omavote-wasm/       浏览器绑定（wasm-bindgen）
crates/omavote/            二进制：serve / relay / verify / vectors 子命令
web/                       前端（React + Vite）
verifier-ts/               独立验证器（TypeScript + CCC）
vectors/                   跨语言测试向量（JSON）
schemas/                   机器可读 JSON Schema
deploy/                    systemd、Caddyfile、配置样例、开发链脚本
docs/、research/           设计文档与研究模型
```

## 3. 协议核心 `omavote-core`

核心不做任何网络或磁盘 IO。输入是按规范链顺序排列的区块数据，输出是各提案的 `result_core`、证据和诊断。

| 模块 | 职责 |
|---|---|
| `json` | 严格 JSON 解析（拒绝重复 key、数字、非法 Unicode、深度超限）与 RFC 8785 JCS 输出 |
| `hash` | CKB Blake2b-256（personalization `ckb-default-hash`）与各用途前缀；blake160 |
| `script` | Molecule `Script` 序列化与 script hash |
| `address` | RFC 0021 full bech32m 地址、EIP-55 地址 |
| `types` | manifest、rules_profile、auth_policy、auth_registry、ballot、control、key descriptor、process roles/record、各类 envelope 与载荷 |
| `text` | 四类签名文本（选票、授权、提案、流程记录）与首行摘要 |
| `adapter` | `ckb-secp256k1-message-v1`、`evm-personal-message-v1` 的验签与 owner/key 匹配；`webauthn-es256-v2` 留待独立 PoC |
| `carrier` | 78 字节载体头、payload hash、批次解码与上限检查 |
| `engine` | 回放状态机：DAO 存款状态、授权控制、选票出现、流程记录、提案登记 |
| `tally` | 每个提案的最终选择、`result_core` 与 `result_hash` |

关键性质用性质测试覆盖：
- 读取顺序无关（按规范位置处理）；
- 重复发布不改变结果；
- 收窄提案格式清单不会复活授权；
- 锚点更新的票不依赖中间版本是否发布；
- 撤销一经生效，不会被锚点更早的记录推翻；
- 本金守恒，每个 outpoint 至多计入一次。

## 4. 实现时补定的编码细节

规范未写死、实现必须确定的格式如下。它们是 V2 草案的一部分，冻结时并入 03。

1. **manifest** 增加 `"message_kind": "manifest"`；时间字段名为 `start_ms`、`end_ms`；`confirmation_policy` 为 `{"result_confirmations": "<n>", "review_window_ms": "<ms>"}`；`publication_policy` 固定为 `"full-onchain-v2"`；`content_locations` 为 URL 字符串数组；`forum_topic_id`、`forum_revision` 为十进制字符串；元规则提案的 `budget_ckb_shannon` 与 `quorum_base_shannon` 为 `"0"`、`recipient_lock_script` 为 null。manifest 内的 `rules_hash`、`auth_registry_hash`、`auth_policy_hash` 必须等于对应对象的哈希。
2. **rules_profile** 用下列键表达 03 §4：`profile`、`asset`、`amount`、`weight_time`、`withdraw_phase1`、`cast_eligibility`、`revote`、`authorization`、`cancel`、`choices`、`quorum_grant_multiplier`、`quorum_meta_rule_shannon`、`approval_grant`、`approval_meta_rule`（`{"numerator","denominator"}`）、`threshold_comparison`（`inclusive`/`strict`）、`precision`（首版只实现 `exact-shannon`）、`opening_confirmations`、`delegate_cutoff_ms`、`voting_period_ms`（`end_ms - start_ms` 必须等于它）。验证器只接受首版实现的取值，遇到未知值报告不支持。
3. **auth_policy** 为 `{"message_kind":"authorization_policy","protocol_version":"2","network_genesis_hash","dao_namespace","clock":"ckb-parent-mtp-v1","max_term_ms","max_control_publication_delay_ms","semantics":"omavote-authorization-semantics-v2"}`。
4. **auth_registry** 两个数组按字典序去重；`auth_registry_hash = H("OMAVOTE/AUTH-REGISTRY/V2\0" || JCS(auth_registry))`。
5. **proof**：两种消息签名 adapter 的 proof 都是 `{"signature": "0x<65 字节>"}`，即 `r || s || v`。CKB 格式的 `v` 为 0/1；EVM 格式接受 27/28 或 0/1，验签前归一化。签名字节不进入任何 ID。
6. **envelope**：选票和控制消息为 `{"body": …, "proof": …}`；流程记录为 `{"body": …, "proofs": [{"signer_key_id", "proof"}]}`；manifest 载荷按 03 §3.1。
7. **网络注册表**：按 genesis hash 固定地址前缀（主网 `ckb`，其余 `ckt`）、标准 secp256k1 lock、DAO type、Omnilock 与 PW Lock 的 code hash。开发链从自己节点的 genesis 读取，并写入验证报告。
8. **预算摘要**：预算不足 1 CKB 时，首行写 `0CKB`，全文 `Budget-CKB` 行仍写精确值。
9. **时钟**：`clock(b)` 为 `b` 的父块及其之前共 37 个区块时间戳的中位数（不足 37 个时取全部；排序后取下标 `len/2`），与 CKB 的 `get_block_median_time(parent)` 一致；实现时用节点 RPC 交叉核对（开发链全部区块已核对一致）。创世块没有父块，`clock(genesis)` 取其自身时间戳；创世块不含协议对象，该取值不影响任何结果。
10. **rules_profile 补充键**：`proposer_min_deposit_shannon`（候选 100,000 CKB，在 manifest 交易处理后检查提案人存款之和）。
11. **发布顺序与锚点**：
    - authorization_policy 必须在引用它的 manifest 和控制消息之前（规范位置严格更早）发布。
    - 锚点块必须是收录块之前的规范块（高度严格更小）。
    - 选票锚点高度不得低于 manifest 的登记高度。
    - `publication_deadline_ms` 必须恰好等于 `clock(anchor)` 加对应期限：控制消息 24 小时，流程记录为部署参数（候选 72 小时）。
12. **流程记录**：
    - **签署角色**：ADMISSION 由 coordinator 签署；NOTICE 可由任一角色签署；其余由 committee 签署。
    - **poll_id**：NOTICE 等记录必须带 poll_id；ROLES_UPDATE 的 poll_id 必须为 null。
    - **冲突**：同一类型在最高锚点上 detail 不同即为 RECORD_CONFLICT。
    - **初始角色生效**：带 `initial_roles_hash` 的角色对象上链时，初始角色即生效。
13. **载荷**：所有 witness 载荷必须是规范 JCS 字节。kind 3 结果记录是任意 JSON，不具权威。
14. **result_core 字段**：
    - 标识与边界：`protocol_version`、`network_genesis_hash`、`poll_id`、`rules_hash`、`auth_policy_hash`、`auth_registry_hash`、`start_boundary_block_hash`、`close_block_hash`、`close_block_number`。
    - 明细：`owners[]`，每行含 `owner_id`、`final_status`、`ballot_id`、`authorization_id`、`eligible_principal_shannon`、`counted_weight_shannon`；`counted_cells[]`，每项含 `tx_hash`、`index`、`owner_id`、`capacity_shannon`。
    - 汇总与结论：`yes_shannon`、`no_shannon`、`participation_shannon`、`quorum_required_shannon`、`approval_numerator`、`approval_denominator`、`threshold_comparison`、`outcome`。

    机器 schema 见 `schemas/omavote-v2.schema.json`。
15. **高 s 签名**：两种消息签名 adapter 都接受高 s 签名，等价于低 s 加翻转的恢复位，与链上 secp256k1 lock 的行为一致。注意 CCC 的 `verifyMessageCkbSecp256k1` 会拒绝高 s，第二实现不能直接依赖它。
16. **开发链网络参数**：
    - 标准 secp256k1 与 DAO 的 type hash 与主网相同，取自开发链 genesis tx0 的 output 1 和 2；secp 依赖组为 genesis tx1 的 output 0。
    - 只有开发链允许在配置中声明 Omnilock 与 PW Lock 身份。主网和测试网使用固定注册表，拒绝覆盖。
17. **中继交易布局**：
    - **载体输出**：使用中继的普通 lock，不带 type，容量 139 CKB，后续交易会回收。
    - **载荷 witness**：放在全部输入 witness 之后，由 sighash_all 一并签名。
    - **载体顺序**：同一交易内为 policy、roles、manifest、授权批次、流程批次、选票批次、结果记录。这样 grant 和 manifest 总排在依赖它们的消息之前。
18. **中继回执**：
    - **签名**：回执由独立的回执密钥签署，回执密钥不持有资金：`H("OMAVOTE/RELAY-RECEIPT/V2\0" || JCS(body))` 上的 secp256k1 可恢复签名。
    - **body 字段**：kind、对象 ID、`envelope_hash = ckbhash(JCS(envelope))`、接收时间、发布时限与中继公钥。
    - **性质**：回执是服务证据，不进入任何协议 ID。
19. **EVM 所有者 lock**：`evm-personal-message-v1` 接受 Omnilock auth flag `0x01` 与 `0x12`（flags 字节均为 `0x00`）以及 PW Lock，见 [03 §5.1](03-protocol.md)。接受 `0x12` 是本轮依据钱包源码研究作出的决定：CCC 的默认地址使用 0x12，否则这些 MetaMask 存款人无法直接投票。需在 M2 真机测试中确认。
20. **ZERO_FINAL_WEIGHT**：选中 YES 或 NO、但截止时本金为零的 owner，在截止块高度报告此附加诊断，按 owner_id 排序，不进入 result_core。
21. **解析上限（影响计数，两套实现已对齐）**：
    - **嵌套深度**：载荷 JSON 的顶层容器为第 1 层，对象和数组合计最多嵌套 32 层，标量不计层数；超过则整份 witness 载荷无效。
    - **整数范围**：所有协议十进制整数必须规范（无符号、无前导零），且在 u64 范围内。
    - **32 KiB**：按 witness 原始字节计量，超出则整个载体无效。
    - **8 KiB**：按信封的 JCS 字节计量，只拒绝该信封，同批其他信封照常处理。
    - **条数**：超过 128 条拒绝整批；空批次也无效。
22. **MetaMask 编码**：`personal_sign` 一律传 `0x` 加 UTF-8 字节的十六进制，不传原文。只含十六进制字符的原文会被当作字节；签名的 v 为 27/28。

## 5. 链同步与复算

**基准模式。** 从起始高度起逐块读取：维护 DAO 存款集合（`type` 精确匹配、data 恰为 8 个零字节），识别载体（数据为 78 字节且以 `OMAVOTE\0` 开头），解码 witness 载荷，按 `(height, tx_index, output_index, envelope_index)` 交给核心引擎。每个区块记录可回滚日志；发现父哈希不连续时回退到共同祖先，再重放新分支。

**加速模式（已实现）。** 载体只需从协议上线高度 `H0` 开始扫块（`[sync] start_height`、`omavote verify --from-height`）。`H0` 处的 DAO 存款集合按以下步骤取自自有节点的索引：

1. 取固定 tip 下仍存活、创建高度不超过 `H0` 的存款；
2. 列举完成后读取索引的新 tip，用 `get_transactions` 找出 `(H0, 新 tip]` 内被花费的 DAO 输入，从花费交易还原其中创建高度不超过 `H0` 的存款；
3. 检查两个 tip 仍在规范链上，否则重做。

另取 `H0` 之前的区块哈希与时钟供锚点查验，取 37 个时间戳作为中位时间窗口。`--compare` 会同时做基准回放，要求 `H0` 处存款集合相同、`H0` 之后登记的提案结果哈希相同。开发链上两项都已验证一致：`H0` = 2850 时 25 笔存款，其中包含之后才被提取的存款；`H0` = 2000 时 6 个提案。前提是 `H0` 及以下不存在任何协议对象。

**存储（SQLite）。** 表：区块与 MTP 时间戳、DAO 存款 cell、载体与载荷、各类出现记录及诊断、提案登记、结果缓存、中继队列与回执。凡是能从链上推导的表都可以删除后重建；中继队列与回执须备份。

**`omavote verify`。** 只连接自己的节点，从指定高度回放，输出指定提案的 `result_core`、`result_hash` 与证据包（JSON）。不读取服务端数据库。

## 6. 中继

1. `POST /envelopes` 先用核心逐条验签和检查格式，再入队；按 `(message_kind, id)` 幂等，并返回中继签名的回执。
2. 后台按 `kind/scope` 打包：每批最多 128 条，witness 不超过 32 KiB。
3. 用中继自有的普通 cell 构造交易：一个载体输出（数据为 78 字节头）、找零，载荷 witness 放在全部输入 witness 之后；用 secp256k1 sighash-all 签名后广播。
4. 状态按 RECEIVED → BROADCAST → INCLUDED → CONFIRMED 推进；交易被重组掉时回到待发布。
5. 回收已上链载体的容量；按 owner 与全局预算限流。

热钱包只放有限周转资金，由独立的 `relay` 进程和单独的配置文件持有私钥。

## 7. API 与订阅

按 03 §12 实现只读 API 与 `POST /envelopes`。所有响应带计算所依据的区块高度与哈希；列表使用稳定游标。Atom feed 分为全局与按 owner 两种。服务端同时托管前端静态文件，但前端也可独立部署到任意静态主机。

实现时 API 挂在 `/api` 前缀下，以免与前端路由冲突；完整清单见 [14：实施进度](14-implementation-status.md)。提案状态按 03 §10 计算：ANNOUNCED、OPEN、CLOSED_UNCONFIRMED、AUDITABLE、FINALIZED_BY_POLICY、EXECUTED、DISPUTED、LATE_MANIFEST。开放期间的即时统计标为 PROVISIONAL，只是诊断视图，不带 outcome 字段，不得显示为通过。签名锚点接口 `/api/anchor` 总是返回最新已索引块，不提供 tip 之前的块（[11 §2、§5](11-authorization.md)）。控制消息的锚点还须高于该 owner 已知的最高控制锚点，改票的锚点须高于上一张票，必要时由客户端等待新块。

## 8. 前端

- **页面**：提案列表与详情、投票（MetaMask 与 Neuron 两条路径）、我的地址与授权（GRANT、续期、GRANT+CANCEL、REVOKE）、回执与状态、结果与证据下载、提案创建（论坛导入）、流程记录签署。
- **WASM 核心**：签名文本、各类 ID 和本地验签都由它生成，网页不另写一份规则。
- **安全**：严格 CSP；不接入第三方统计；签名前展示与钱包一致的全文与首行摘要；签名前检查节点同步状态，提交后核对是否成为当前选择。
- **语言**：中英文界面。

## 9. 独立验证器

TypeScript 实现，由不看 Rust 代码的独立 agent 只依据 docs 与 `vectors/` 编写，并用 CCC 计算哈希、Molecule 与地址。CI 中与 Rust 实现做差分比对：相同输入必须得到相同的 ID、签名文本与 `result_hash`。规范要求“由另一个人编写”，这一点无法由单个实施者满足，上线前仍需人工审计。

## 10. 测试策略

| 层次 | 内容 |
|---|---|
| 单元与性质测试 | JSON/JCS、哈希、地址、文本、验签、状态机、计票；性质测试见 §3 |
| 场景测试 | [11 §8](11-authorization.md) 的 31 个场景，以及各轮评审反例 |
| 测试向量 | `vectors/` 下的 JSON：规范化、ID、签名文本、真实签名、载体编码、完整回放与 `result_hash` |
| 开发链集成 | 本地 `ckb` 开发链：真实交易上的存款、提款、中继发布、重组回放 |
| 差分 | Rust 与 TypeScript 两套实现对同一输入的结果比对 |
| 真机 | Neuron（含 Ledger 首行显示）、MetaMask 桌面与手机：需要真人和真设备，不在自动化范围内 |

## 11. 部署与运维

- **构建**：`cargo build --release --locked` 产出单个二进制，发布时公布 SHA-256。
- **服务**：`deploy/` 提供 systemd unit、Caddyfile 和配置样例（TOML）。
- **备份**：中继私钥、配置、中继队列与回执数据库。
- **监控**：`GET /status`（索引高度、链分歧、队列积压、热钱包余额）和结构化日志。

## 12. 里程碑

实施者为单人，按顺序推进；每个里程碑结束时本地提交一次。

| 里程碑 | 交付 | 完成标准 |
|---|---|---|
| M0 方案与仓库 | 本文件、仓库骨架、CI 脚本 | 工作区可构建 |
| M1 协议核心 | `omavote-core` 全部模块、31 个场景与反例、性质测试、JSON Schema、测试向量、WASM 构建 | 测试全部通过；向量可被外部实现读取 |
| M2 钱包 PoC | Neuron 与 MetaMask 的真实签名向量与显示记录 | 需要真机：实施者准备签名页面与验证工具，真人完成后冻结 V2 线格式 |
| M3 链同步与复算 | RPC 客户端、回放、重组回滚、SQLite、`omavote verify` | 开发链上的存取款与回放结果正确；重组测试通过 |
| M4 中继与 API | 交易构造与代付、回执、只读 API、feed、单二进制运行 | 开发链上授权、投票、改票、撤销全部免费发布，并能独立复算 |
| M5 前端 | §8 的页面与两条钱包路径 | 开发链上从创建提案到复算完整跑通（MetaMask 用模拟 provider 测试） |
| M6 独立验证器与演练 | TypeScript 验证器、差分测试；人工审计与 8–12 人体验测试需另行安排 | 两套实现对向量与开发链数据结果一致 |
| M7 影子运行与切换 | 影子投票、运维手册、切换提案 | 需要治理与运营方参与 |

当前进度与夜间完成情况见 [14：实施进度](14-implementation-status.md)。

## 13. 风险与未决

- **真实钱包行为**：Neuron 消息签名格式、Ledger 显示、MetaMask 手机连接需真机确认（M2）；在此之前实现以公开源码为准。
- **独立实现**：第二验证器由同一模型的独立 agent 编写，独立性有限，仍需人工审计。
- **主网首次同步成本**：基准模式逐块扫描很慢，主网上线前须完成 §5 的加速模式，并与基准结果比对。
- **待定参数**：流程记录发布期限（候选 72 小时）、`opening_confirmations`（候选 100）、流程角色成员与阈值、精度等规则确认，见 [09 §6、§10–11](09-design-update.md)。
