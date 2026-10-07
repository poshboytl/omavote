# 实施进度（2026-10-08 夜间）

实施者：Claude 单人（另有两个子 agent 分别编写前端与独立 TypeScript 验证器）。依据：[13 技术方案](13-technical-plan.md)。代码只在本地 CKB 开发链上运行过，**没有部署到测试网或主网，没有接触任何真实资金**。全部提交都是本地 git 提交，未推送。

## 1. 结论

- **M0–M4 完成**：协议核心、WASM 绑定、链同步与复算、`omavote verify`、中继与 API 均已实现并通过测试。开发链端到端演示跑通了提案登记、准入、授权、直接与代理投票、改票、撤回屏障、提款、链重组恢复、委员会结果确认和独立复算，所有检查都通过（§4）。
- **M5 前端、M6 独立验证器**：已实现，状态与测试见 §5、§6。
- **M2 钱包实测、M6 人工审计、M7 影子运行**：都需要真人、真设备或治理参与。代码与工具已就绪，所需工作见 §8。

## 2. 里程碑

| 里程碑 | 状态 | 交付 |
|---|---|---|
| M0 方案与仓库 | 完成 | `docs/13`、Rust workspace、`.gitignore` |
| M1 协议核心 | 完成 | `crates/omavote-core`、`schemas/omavote-v2.schema.json`、`vectors/` |
| M2 钱包 PoC | 工具就绪，待真机 | 签名格式已与 Neuron/lumos、eth-sig-util 的输出逐字节比对（`vectors/external.json`）；前端「钱包检查」页用于真机记录 |
| M3 链同步与复算 | 完成 | `crates/omavote`：`sync`、`store`、`chain`、`verify` |
| M4 中继与 API | 完成 | `relay`、`txbuilder`、`api`、`deploy/`、`omavote demo` |
| M5 前端 | 见 §5 | `web/` |
| M6 独立验证器 | 见 §6 | `verifier-ts/` |
| M7 影子运行与切换 | 未开始 | 需要治理与运营方 |

## 3. 测试

| 部分 | 结果 |
|---|---|
| 核心单元测试 | 21 通过 |
| 11 §8 的 31 个场景与 12 个反例（`tests/scenarios.rs`） | 43 通过 |
| 性质测试：读取顺序无关、重复幂等、本金守恒（`tests/properties.rs`） | 3 通过 |
| 跨语言向量（`tests/vectors.rs`） | 6 通过 |
| 外部向量（`tests/external.rs`） | 5 通过：Neuron 签名与 lumos 逐字节相同；EIP-191 与 eth-sig-util 相同；高 s 签名等价；WitnessArgs 与 CCC 相同 |
| WASM 绑定 | 1 通过；`wasm32-unknown-unknown` release 构建成功 |
| 服务端（同步、重组回滚、重启恢复、交易布局、中继准入与回执） | 5 通过 |
| JSON Schema（`schemas/`，ajv） | 向量中 13 个对象全部有效 |
| 时钟交叉核对 | `omavote verify --check-clock` 对开发链每个区块比对 `get_block_median_time(parent)`，全部一致 |

运行方法：`cargo test --workspace`；`cd schemas && npm install && npm test`。

### V2 冻结条件对照（[05 §8](05-delivery.md)）

| 条件 | 证据 | 状态 |
|---|---|---|
| 1. 授权与选票状态机覆盖 11 §8 全部场景与评审反例 | `tests/scenarios.rs` s01–s31、e01–e12 | 已覆盖下列反例：收窄格式清单（s08）、只发布最新改票（s04）、被扣留的早签票（s05、s10）、同一块内两张不同票（s07、s24）、过旧锚点（s06）、节点落后时的恢复（s09）、撤销与新 GRANT 乱序（s11、s14）、GRANT+CANCEL（s12）、非规范锚点（s25）、流程记录的原样重发、扣留后发布与过期（e09）。锚点被重组移除：服务端回滚后弃用分支的区块被遗忘（`sync` 测试），开发链上做了真实重组 |
| 2. 乱序收录、重组与性质测试 | `tests/properties.rs`、`sync` 重组测试、开发链 `truncate` 重组 | 完成 |
| 3. schema、跨语言向量、真实签名向量 | `schemas/`、`vectors/`、`vectors/external.json` | schema 与向量完成；真实签名目前来自公开实现（lumos、eth-sig-util），**真机签名尚缺** |
| 4. 首版钱包 PoC（Neuron 含 Ledger、MetaMask 含手机） | 前端「钱包检查」页 | **需要真人与真设备** |

因此 V2 线格式尚未冻结：第 3 条的真机部分和第 4 条要等真机测试完成。

## 4. 开发链端到端演示

`deploy/devnet/run-demo.sh` 依次执行：启动开发链与服务端（中继嵌入），运行 `omavote demo --reorg-test`，再用 `omavote verify` 从节点独立复算。演示全部使用真实交易：

| 步骤 | 结果 |
|---|---|
| 存款 | 5 个所有者在一笔交易里存入 Nervos DAO，共 340,000 CKB：4 个标准 secp256k1 所有者，1 个 EVM（Omnilock）所有者 |
| 授权 policy 与流程角色 | 经中继发布；初始角色按配置的 `initial_roles_hash` 生效 |
| 提案 | 提案人签署的 manifest 由中继发布；coordinator 的 ADMISSION 在开启确认数之前收录，提案开启后为 OPEN、ADMITTED |
| 授权 | Carol（EVM）授权 K1（EVM 密钥），Erin 授权 K2（secp 密钥），都在开启前收录 |
| 第一轮投票 | Alice YES、Bob NO、Dave YES（直接）；K1 代 Carol 投 NO，K2 代 Erin 投 NO（代理）。中继在一笔交易内先放授权、后放选票 |
| 提款 | Dave 用真实的 phase-1 交易提取存款 |
| 第二轮 | Bob 改投 YES；Carol 直接投 YES（覆盖代理票）；Erin 发出 `REVOKE STOP_AND_CANCEL_OPEN` |
| 重组 | 用开发链 `truncate` 删掉收录第二轮的区块，并立即挖出更重的新分支。服务端回滚 1 个区块；中继发现交易离开规范链，在新分支重新收录；API 中第二轮选票恢复 |
| 截止与结果 | `result_hash = 0xe3e67442…c06bdb5`，PASS；YES 290,000 CKB，NO 0。Alice 150,000、Bob 60,000、Carol 80,000 全额计入；Dave 的 YES 保留，计入 0（已提款，附加诊断 ZERO_FINAL_WEIGHT）；Erin 为 CANCELLED_BY_CONTROL。选票状态依次为 SELECTED、SUPERSEDED、OVERRIDDEN_BY_OWNER、CANCELLED_BY_CONTROL |
| 结果确认 | committee 2/3 签署 RESULT_ATTESTATION，验证状态为 CONFIRMED |
| 独立复算 | 从节点完整回放，逐块核对时钟，`result_hash` 与服务端一致 |

用户全程不付任何费用。全部链费与载体容量由中继热钱包承担，载体容量会被后续交易回收。证据保存在 `evidence/devnet-2026-10-08/`：

| 文件 | 内容 |
|---|---|
| `demo.log` | 演示日志 |
| `summary.json` | 汇总结果 |
| `bundle.json` | 证据包；与向量一起通过 schema 校验，共 27 个对象 |
| `verify-report.json` | 独立复算报告 |
| `blocks.json.gz` | 开发链精简区块，用于两套实现的差分 |

**两套实现差分。** 对同一份开发链数据（6 个提案），独立 TypeScript 验证器与 Rust 回放的 `result_hash`、准入与结果确认视图全部一致。唯一差异是 TS 额外报告了 ZERO_FINAL_WEIGHT。这是 03 §11 列出的附加诊断，Rust 现在也在证据包与 `verify` 输出中报告（13 §4 第 20 条）。比对脚本：`scripts/diff-verifiers.sh`。

**加速模式。** 在同一开发链上，`omavote verify --from-height 2850 --compare` 从索引推导的 25 笔存款与基准回放在 2850 处完全相同，其中包括之后才被提取、需从花费交易还原的存款。`--from-height 2000 --compare --check-clock` 下，6 个提案的 `result_hash` 全部一致。以 `start_height = 2000` 启动的第二个服务端实例给出相同结果，重启后复用已保存的起始状态。

**开发中修正的问题**（演示前几轮暴露）：

1. 测试所有者跨轮复用导致存款累加。改为每轮使用新密钥。
2. 演示的检查早于中继重新收录。
3. 开发链 `truncate` 只回退 tip，矿工会把原区块重新接上。改为截断后立即挖出更重的分支，并确认收录块的哈希确实改变。
4. `/api/anchor` 原先返回 tip 之前 4 块，违反 11 §2、§5 的锚点规则（锚点必须是已验证的最新块）。已改为总是返回最新已索引块，第 7 轮演示按新规则重跑通过。
5. 开放期间的 PROVISIONAL 统计原先带 outcome 字段。已删除，避免把部分统计显示为通过。

服务端回滚与中继恢复本身在这几轮中都表现正确。

## 5. 前端（M5）

FRONTEND_RESULTS

## 6. 独立 TypeScript 验证器（M6）

`verifier-ts/` 由一个独立 agent 只依据 `docs/` 与 `vectors/` 编写（TypeScript + CCC + noble），没有读过 Rust 代码。它与 Rust 实现的唯一交流，是协调方转告的钱包源码研究结论：高 s 签名规则、Neuron 与 EIP-191 摘要格式、新向量。

- **测试**：`npm test` 107 项全部通过；`check-vectors` 对 7 个向量文件的 119 项检查全部通过，回放向量的 `result_hash` 逐字节一致；3 万区块的合成数据回放约 0.3 秒。
- **开发链差分**：见 §4，6 个提案全部一致。
- **规范问题清单**：`verifier-ts/SPEC-NOTES.md` 逐条列出文档沉默、歧义或矛盾、需要查向量才能决定的地方，供人工审计。主要几条及处理：
  1. **result_core 的字段与边界块**：只在向量里定义。13 §4 第 14 条现已写明字段，边界块的选择仍需并入 03。
  2. **Omnilock 0x12**：已按 13 §4 第 19 条接受。
  3. **rules_profile 的取值**：取值字符串只在向量中出现，冻结时须写入 03。
  4. **影响计数的解析上限未写死**：JSON 深度、超过 8 KiB 的信封只拒自身还是整批、32 KiB 的计量方式、整数位宽，冻结前必须统一。
  5. **诊断码与检查顺序**：大多由实现自定，不影响 result_core，但影响证据包。
- **补充向量**：根据验证器的建议新增 `vectors/replay-edge.json`，覆盖选中的 CANCEL、同锚点 CONFLICT、CANCELLED_BY_CONTROL、0x12 Omnilock 所有者兼提案人，以及提款后的 YES（ZERO_FINAL_WEIGHT）。

独立性有限：两套实现出自同一个模型。规范要求的“另一个人编写”仍需人工完成（§8）。

## 7. 实现中补定的规则

已写入 [13 §4](13-technical-plan.md) 第 9–22 条，V2 冻结时须并入 03。主要内容：

- `clock(genesis)` 取创世块自身时间戳；
- 发布顺序、锚点与期限的精确检查；
- 流程记录的签署角色；
- result_core 字段；
- 高 s 签名等价处理；
- 开发链网络参数；
- 中继交易布局；
- 回执签名；
- MetaMask 的十六进制编码。

## 8. 需要人来完成的事

1. **真机签名（M2）**：在前端「钱包检查」页用以下钱包各签一次固定样票，下载记录后核对：
   - Neuron 软件钱包；
   - Neuron + Ledger：核对首行摘要的显示；
   - MetaMask 桌面版；
   - MetaMask 手机版（含 WalletConnect）。

   完成后冻结 V2 线格式。
2. **治理参数**：
   - 流程记录发布期限（候选 72 小时）；
   - `opening_confirmations`（候选 100）；
   - 结果确认数与复核窗口；
   - 流程角色成员与阈值（决定 `initial_roles_hash`）；
   - 提案人最低存款（候选 100,000 CKB）。

   这些参数都需要社区和委员会确认（[09 §6、§10–11](09-design-update.md)）。
3. **人工审计与独立实现**：第二实现由同一模型的独立 agent 编写，独立性有限。规范要求另一个人（团队）实现并审计。
4. **主网加速同步**：[13 §5](13-technical-plan.md) 的加速模式已实现，并在开发链上与基准回放比对一致。主网上线前仍需在主网节点上实测：一次从创世块的完整回放，以及在上线高度用 `omavote verify --from-height <H0> --compare` 比对。
5. **体验测试**：8–12 人的实际使用测试；授权、投票、改票、撤回、恢复的免费路径演练。
6. **影子运行（M7）**：在测试网或主网上与现行投票并行，比对结果后再提交切换提案。

## 9. 已知限制

- 中继每次只有一笔交易在途。高峰期吞吐量受出块间隔限制，需要多 UTXO 并发与限流政策。
- API 只服务已索引 tip 的视图。授权的历史视图需要客户端用 `history` 中的位置自行回溯。按区块哈希查询本金（`/api/owners/{id}/power?block_hash=`）可用。
- 开发链没有 Omnilock 与 PW Lock 二进制。演示用声明的 Omnilock 身份创建 EVM 所有者的存款，这类存款无法在开发链上提取。
- `webauthn-es256-v2` 仍为保留 adapter，未实现。
- 开发链 `truncate` 有两个特性：可能与在途区块竞争而不生效；矿工可能把同一个区块原样重新提交。演示因此会重试，并截断到收录块之下两块。

## 10. 文件地图

| 路径 | 内容 |
|---|---|
| `crates/omavote-core/` | 协议核心：JSON/JCS、哈希、Molecule、地址、消息与文本、adapter、载体、回放引擎、计票、测试工具 |
| `crates/omavote-wasm/` | 浏览器绑定：JSON 进出的 `call(method, params)` |
| `crates/omavote/` | 服务端二进制：`serve`、`relay`、`verify`、`network`、`keygen`、`demo`、`demo-roles` |
| `web/` | 前端（React + Vite + WASM） |
| `verifier-ts/` | 独立 TypeScript 验证器（CCC） |
| `vectors/` | 跨语言测试向量；`external.json` 为外部钱包和 SDK 的输出 |
| `schemas/` | JSON Schema 与校验脚本 |
| `deploy/` | systemd、Caddyfile、配置样例、开发链脚本 |
