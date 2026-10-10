# 实施进度（2026-10-08 夜间；上午补充 §11；10-10 补充 §12 签名插件）

实施者：Claude 单人（另有两个子 agent 分别编写前端与独立 TypeScript 验证器）。依据：[13 技术方案](13-technical-plan.md)。代码只在本地 CKB 开发链上运行过，**没有部署到测试网或主网，没有接触任何真实资金**。全部提交都是本地 git 提交，未推送。

## 1. 结论

- **M0–M4 完成**：协议核心、WASM 绑定、链同步与复算（含主网所需的加速起点）、`omavote verify`、中继与 API 均已实现并通过测试。开发链端到端演示跑通了提案登记、准入、授权、直接与代理投票、改票、撤回屏障、提款、链重组恢复、委员会结果确认和独立复算，所有检查都通过（§4）。
- **M6 独立验证器**：完成，两套实现在全部向量和开发链 8 个提案上结果一致（§6）。
- **M5 前端**：完成。在开发链上用浏览器端到端投票成功（§5）。
- **M2 钱包实测、M6 人工审计、M7 影子运行**：都需要真人、真设备或治理参与。代码与工具已就绪，所需工作见 §8。

## 2. 里程碑

| 里程碑 | 状态 | 交付 |
|---|---|---|
| M0 方案与仓库 | 完成 | `docs/13`、Rust workspace、`.gitignore` |
| M1 协议核心 | 完成 | `crates/omavote-core`、`schemas/omavote-v2.schema.json`、`vectors/` |
| M2 钱包 PoC | 工具就绪，待真机 | 签名格式已与 Neuron/lumos、eth-sig-util 的输出逐字节比对（`vectors/external.json`）；前端「钱包检查」页用于真机记录 |
| M3 链同步与复算 | 完成 | `crates/omavote`：`sync`、`store`、`chain`、`verify` |
| M4 中继与 API | 完成 | `relay`、`txbuilder`、`api`、`deploy/`、`omavote demo` |
| M5 前端 | 完成（真机待测） | `web/`、`web/scripts/e2e-neuron-vote.mjs` |
| M6 独立验证器 | 完成（人工审计另需安排） | `verifier-ts/`、`scripts/diff-verifiers.sh` |
| M7 影子运行与切换 | 未开始 | 需要治理与运营方 |

## 3. 测试

| 部分 | 结果 |
|---|---|
| 核心单元测试 | 22 通过 |
| 11 §8 的 31 个场景与 12 个反例（`tests/scenarios.rs`） | 43 通过 |
| 性质测试：读取顺序无关、重复幂等、本金守恒（`tests/properties.rs`） | 3 通过 |
| 跨语言向量（`tests/vectors.rs`，含边界情形回放向量） | 7 通过 |
| 外部向量（`tests/external.rs`） | 5 通过：Neuron 签名与 lumos 逐字节相同；EIP-191 与 eth-sig-util 相同；高 s 签名等价；WitnessArgs 与 CCC 相同 |
| WASM 绑定 | 1 通过；`wasm32-unknown-unknown` release 构建成功 |
| 服务端（同步、重组回滚、重启恢复、交易布局、中继准入与回执、论坛链接解析、配置样例） | 8 通过 |
| JSON Schema（`schemas/`，ajv） | 向量与开发链证据包中的 27 个对象全部有效 |
| 独立 TypeScript 验证器（`verifier-ts/`） | 117 项测试通过；8 个向量文件的 125 项检查通过 |
| 前端（`web/`） | 53 项测试通过；构建通过 |
| 时钟交叉核对 | `omavote verify --check-clock` 对开发链每个区块比对 `get_block_median_time(parent)`，全部一致 |
| 浏览器端到端（开发链，`deploy/devnet/run-e2e.sh`） | 桌面与手机（Pixel 7）各 16 步全部通过，见 §11 |
| 格式与静态检查 | `cargo fmt --check` 与 `cargo clippy --workspace --all-targets -- -D warnings` 无警告 |
| 依赖漏洞 | `cargo audit`（RustSec）无已知漏洞；`npm audit --omit=dev` 无中危及以上 |

Rust 测试合计 89 项。一键运行全部（不需要节点）：`scripts/ci.sh`，GitHub Actions 另在开发链上跑演示与浏览器端到端（`.github/workflows/ci.yml`）。

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

脚本本身也在隔离目录和独立端口上从头跑通，结果 PASS，命令行 `omavote verify --check-clock` 复算一致。脚本测试暴露了一处竞态并已修复：服务端还没索引到存款块，提案就已提交给中继。

用户全程不付任何费用。全部链费与载体容量由中继热钱包承担，载体容量会被后续交易回收。证据保存在 `evidence/devnet-2026-10-08/`：

| 文件 | 内容 |
|---|---|
| `demo.log` | 演示日志 |
| `summary.json` | 汇总结果 |
| `bundle.json` | 证据包；与向量一起通过 schema 校验，共 27 个对象 |
| `verify-report.json` | 独立复算报告 |
| `blocks.json.gz` | 开发链精简区块，用于两套实现的差分 |
| `e2e/` | 浏览器端到端测试：两种模式的报告、两个复算器的输出、截图（§11） |

**两套实现差分。** 对同一份开发链数据（6 个提案），独立 TypeScript 验证器与 Rust 回放的 `result_hash`、准入与结果确认视图全部一致。唯一差异是 TS 额外报告了 ZERO_FINAL_WEIGHT。这是 03 §11 列出的附加诊断，Rust 现在也在证据包与 `verify` 输出中报告（13 §4 第 20 条）。比对脚本：`scripts/diff-verifiers.sh`。

**加速模式。** 在同一开发链上，`omavote verify --from-height 2850 --compare` 从索引推导的 25 笔存款与基准回放在 2850 处完全相同，其中包括之后才被提取、需从花费交易还原的存款。`--from-height 2000 --compare --check-clock` 下，6 个提案的 `result_hash` 全部一致。以 `start_height = 2000` 启动的第二个服务端实例给出相同结果，重启后复用已保存的起始状态。

**开发中修正的问题**（演示前几轮暴露）：

1. 测试所有者跨轮复用导致存款累加。改为每轮使用新密钥。
2. 演示的检查早于中继重新收录。
3. 开发链 `truncate` 只回退 tip，矿工会把原区块重新接上。改为截断后立即挖出更重的分支，并确认收录块的哈希确实改变。
4. `/api/anchor` 原先返回 tip 之前 4 块，违反 11 §2、§5 的锚点规则（锚点必须是已验证的最新块）。已改为总是返回最新已索引块，第 7 轮演示按新规则重跑通过。
5. 开放期间的 PROVISIONAL 统计原先带 outcome 字段。已删除，避免把部分统计显示为通过。
6. 独立验证器发现了两处会影响计数的解析差异：JSON 嵌套层数的计法差一层，部分金额 Rust 允许 u128 而 TS 只允许 u64。现已统一并写入 13 §4 第 21 条，开发链上 7 个提案的结果哈希不变。
7. EVM 所有者原先只接受 Omnilock auth flag 0x01。CCC 新地址默认用 0x12，现已接受（13 §4 第 19 条），并新增跨实现向量。
8. 演示中的竞态（在 GitHub CI 上发现）：中继报告“已收录”依据的是节点，不是服务端索引，而演示随后的检查读的是索引。在较慢的机器上，有两处会因此失败：
   - 重组测试截断链时，服务端可能还没索引到那一块，于是不记录回滚；
   - 委员会确认上链后，确认状态立即检查失败。

   现在每次等到中继收录后，演示还会等服务端索引追上收录块。

服务端回滚与中继恢复本身在这几轮中都表现正确。

## 5. 前端（M5）

前端由一个子 agent 在 `web/` 中编写：React 18、Vite、TypeScript 严格模式、HashRouter，运行时只依赖 react、react-dom、react-router。签名文本、各类 ID 与本地验签全部调用核心的 WASM，网页不另写规则。由 `omavote serve` 托管，也可部署到任意静态主机。

- **页面**：

  | 页面 | 内容 |
  |---|---|
  | 提案列表与详情 | 官方状态、提案事实、链时间日程、计数，开放期间标为“当前计数，不是结果” |
  | 投票 | MetaMask 所有者与授权密钥两种身份；Neuron 复制粘贴 |
  | 我的地址 | 本金、各提案选票；授权流的 GRANT、GRANT+CANCEL、REVOKE |
  | 其他 | 回执、创建提案、流程记录签署、状态、验证、钱包检查（供 M2 真机记录）、设置 |

  中英双语。
- **签名流程按规范执行**：
  - 签名前检查节点同步。
  - 展示全文与首行摘要，并可查看待签的确切字节。
  - 锚点取最新块，且须高于该 owner 已知的选票、控制消息与中继队列中的项。
  - 提交前先在本地验签。
  - 核对回执签名，并核对回执承诺的正是所发送的信封。
  - 跟踪状态到 INCLUDED/CONFIRMED，再确认选票为 SELECTED。
  - 锚点成为孤块或中继失败时提示重签。
- **测试**：53 项全部通过（vitest，在 Node 中加载真实 WASM），覆盖：
  - 模拟 EIP-1193 钱包与 Neuron 签名器；
  - 投票、授权与多成员流程记录；
  - 等待新块的锚点规则；
  - 回执签名校验；
  - 中英文案键一致性；
  - 签名前与独立来源比对 tip（§11）。
- **构建**：`npm run build` 通过，产物约 0.8 MB（JS 435 KB、WASM 348 KB，gzip 后合计约 260 KB），满足服务端的严格 CSP。
- **浏览器验证**：
  - 无头 Chromium 在真实 CSP 下加载全部路由，没有控制台错误或 CSP 违规，手机宽度下没有布局溢出。
  - **真实端到端投票**：对开发链服务端，经 Neuron 路径准备选票。读出页面所示的确切字节，用 `omavote sign` 按 Neuron 格式签名（与 lumos 输出逐字节相同的签名方式）后粘贴提交。页面验证了中继回执，交易在区块 6472 收录，页面显示“已选中（计入）”，全程无控制台错误。脚本为 `web/scripts/e2e-neuron-vote.mjs`，截图与结果在 `evidence/devnet-2026-10-08/ui/`。
  - **完整流程**（上午补充）：`deploy/devnet/run-e2e.sh` 在桌面与手机上用网页走完全部协议动作，见 §11。
- **未做或需要真人**（详见 `web/NOTES.md`）：
  - **真机**：MetaMask 桌面与手机的全文显示和账户切换；Neuron（含 Ledger）的菜单文案、换行是否保留、签名格式。用「钱包检查」页记录。
  - **其余未做**：用 Neuron 持有的授权密钥投票、passkey 与 EIP-712、WalletConnect、选票列表分页。论坛导入与签名前的独立 tip 比对已在上午补上（§11）。

## 6. 独立 TypeScript 验证器（M6）

`verifier-ts/` 由一个独立 agent 只依据 `docs/` 与 `vectors/` 编写（TypeScript + CCC + noble），没有读过 Rust 代码。它与 Rust 实现的唯一交流，是协调方转告的钱包源码研究结论：高 s 签名规则、Neuron 与 EIP-191 摘要格式、新向量。

- **测试**：`npm test` 117 项全部通过；`check-vectors` 对 8 个向量文件的 125 项检查全部通过，两个回放向量的 `result_hash` 都逐字节一致；3 万区块的合成数据回放约 0.3 秒。
- **开发链差分**：`scripts/diff-verifiers.sh` 对开发链全部 8 个提案的比对没有差异。
- **第二轮对齐**：按协调方转告的 13 §4 第 10–22 条更新了实现，包括 Omnilock 0x12、发布顺序、记录冲突判定、空批次与解析上限。
- **规范问题清单**：`verifier-ts/SPEC-NOTES.md` 逐条列出文档沉默、歧义或矛盾、需要查向量才能决定的地方，供人工审计。主要几条及处理：
  1. **result_core 的字段与边界块**：只在向量里定义。13 §4 第 14 条现已写明字段，边界块的选择仍需并入 03。
  2. **Omnilock 0x12**：已按 13 §4 第 19 条接受。
  3. **rules_profile 的取值**：取值字符串只在向量中出现，冻结时须写入 03。
  4. **影响计数的解析上限**：JSON 深度、超过 8 KiB 的信封只拒自身还是整批、32 KiB 的计量方式、整数位宽、空批次。现已写入 13 §4 第 21 条，两套实现已对齐。
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
- Omnilock auth flag 0x12 的 EVM 所有者；
- ZERO_FINAL_WEIGHT 附加诊断；
- 影响计数的解析上限；
- MetaMask 的十六进制编码。

其中 Omnilock 0x12 与解析上限是本轮根据钱包源码研究和第二实现的反馈作出的决定，冻结前请重点评审。

## 8. 需要人来完成的事

1. **真机签名（M2）**：在前端「钱包检查」页用以下钱包各签一次固定样票，下载记录后核对：
   - Neuron 软件钱包；
   - Neuron + Ledger：核对首行摘要的显示；
   - MetaMask 桌面版；
   - MetaMask 手机版（App 内浏览器；前端未接 WalletConnect，见 §5）。

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
7. **签名插件**：确定官方域名并写入 `extension/official.json`；在 Chrome、Brave、Edge、Arc 上逐个人工验收（安装提示、官方域名连接、非官方站点工具栏连接、确认窗口、锁定与解锁、浏览器重启、断开）；外部安全审查；上架（§12）。

以上各项的操作步骤与记录格式见 [17：外部验收记录模板](17-external-acceptance.md)；切换提案的草案见 [18](18-governance-switch-proposal.md)，请既有治理逐项确认规则并补齐附件。

## 9. 已知限制

- 中继每次只有一笔交易在途。高峰期吞吐量受出块间隔限制，需要多 UTXO 并发与限流政策。
- API 只服务已索引 tip 的视图。授权的历史视图需要客户端用 `history` 中的位置自行回溯。按区块哈希查询本金（`/api/owners/{id}/power?block_hash=`）可用。
- 开发链没有 Omnilock 与 PW Lock 二进制。演示用声明的 Omnilock 身份创建 EVM 所有者的存款，这类存款无法在开发链上提取。
- `webauthn-es256-v2` 仍为保留 adapter，未实现。
- 开发链 `truncate` 只回退 tip，被删区块仍在节点里，外部矿工可能把同一区块重新接上。演示因此在截断后立即用 `generate_block` 挖出更重的新分支，并确认收录块的哈希确实改变。

## 10. 文件地图

| 路径 | 内容 |
|---|---|
| `crates/omavote-core/` | 协议核心：JSON/JCS、哈希、Molecule、地址、消息与文本、adapter、载体、回放引擎、计票、测试工具 |
| `crates/omavote-wasm/` | 浏览器绑定：JSON 进出的 `call(method, params)` |
| `crates/omavote/` | 服务端二进制：`serve`、`relay`、`verify`、`verify-evidence`、`network`、`keygen`、`backup`、`rebuild-index`、`sign`、`demo`、`demo-roles`、`devnet`（命令说明见 [16 §5](16-api.md)） |
| `web/` | 前端（React + Vite + WASM） |
| `verifier-ts/` | 独立 TypeScript 验证器（CCC） |
| `extension/` | 可选的浏览器签名插件（Chrome MV3），见 §12 |
| `vectors/` | 跨语言测试向量；`external.json` 为外部钱包和 SDK 的输出 |
| `schemas/` | JSON Schema 与校验脚本 |
| `deploy/` | systemd、Caddyfile、配置样例、开发链脚本 |
| `scripts/` | `ci.sh`（不需要节点的全部检查）、`diff-verifiers.sh`（两套实现差分）、`package.sh`（带 SHA-256 的发布包） |
| `evidence/` | 开发链演示、复算与浏览器端到端投票的证据 |

## 11. 借鉴 Codex 工作树（2026-10-08 上午）

用户决定以本仓库为主线，并请我审阅另一份独立实现（Codex，分支 `implementation-codex`，只读）。审阅完成后，按用户要求删除了它的 worktree，分支仍留在本地。两边架构不同，所以没有复制代码。值得借鉴的做法都在本仓库的代码里重新实现，附带测试与文档。

| 项目 | 本仓库的实现 | 验证 |
|---|---|---|
| 影子模式 | `[protocol] governance_confirmed` 默认 `false`；`/api/status` 与 `/api/network` 返回 `shadow_mode`；页面顶部横幅 | 配置样例解析测试要求默认处于影子模式 |
| 签名前独立比对 tip（[11 §5](11-authorization.md)） | `web/src/lib/tipcheck.ts`：来源可以是另一家 Omavote 的 `/api/status` 或 CKB 节点 RPC，高度与哈希必须一致，短暂不一致时等待；主网与测试网必须配置；「设置」页可改，构建时可用 `VITE_TIP_SOURCE` 预置 | 5 项前端测试：两种来源、换网、等待后签名、持续分叉拒签、主网无来源拒签 |
| 论坛导入 | `GET /api/forum/import`：只连 talk.nervos.org，拒绝跳转，15 秒超时，最大 2 MB；创建页「从 Nervos Talk 导入」，修订号填入 manifest，页面比对正文哈希与导入原文，改动后提示，文中地址只作收款人候选 | 链接解析测试；对真实主题 10090 实测 |
| 服务端加固 | 数据库锁（`serve` 与发布者各一把）；`/api/anchor` 与节点实时核对，落后或分叉时返回 503；索引落后时拒收提交；请求体上限 64 KiB；他人已发布的信封标为 `ALREADY_ON_CHAIN`，被重组掉后自动接手；未知 API 路径返回 JSON 404；公开 GET 允许任意 origin | 第二个 `serve` 被拒；出块时连续请求锚点稳定；跨域 POST 预检只允许 GET |
| 运维与发布 | `omavote backup`（在线一致性复制，0600，完整性检查）；`omavote rebuild-index`（只清链索引，保留队列与回执，服务运行时拒绝）；`scripts/ci.sh` 加入 rustfmt、clippy `-D warnings`、RustSec 与 npm audit；GitHub Actions；`scripts/package.sh` 生成带 `SHA256SUMS` 与 `BUILD.txt` 的发布包 | 运行中备份成功；在备份副本上重建：清除 35,724 个区块，保留 110 条队列项；发布包校验通过 |
| 证据包带链历史 | `GET /api/results/{id}/bundle?history=true` 附上缩减区块（含时间戳）与加速起点种子；`omavote verify-evidence` 离线重放，加 `--rpc` 时与自己的节点逐块比对并重新缩减，证明证据包完整；TS 验证器可直接重放同一文件；验证页说明用法 | 35,910 块、9.5 MB 的证据包：离线通过；`--rpc` 约 5 秒比对全部区块；TS 复算得到相同的 `0xf4487a5e…`。篡改一张选票后，离线报告结果哈希不同，`--rpc` 指出第 33,870 块的数据被遗漏或改动 |
| 开发链辅助 | `omavote devnet identity/fund/deposit/balance`，拒绝在主网和测试网上运行 | 供浏览器端到端测试使用 |
| 浏览器全流程测试 | `web/e2e/devnet-e2e.mjs` 与 `deploy/devnet/run-e2e.sh`（Playwright）。每轮自起主、备两个服务器，各用新数据库、新密钥和各自的赞助账户。全部动作经网页完成：<br>• 创建提案、协调者准入；<br>• Neuron 授权与代理投票；<br>• MetaMask 所有者改票；<br>• GRANT+CANCEL 换钥、所有者直接撤回；<br>• 签名后停掉主服务器，在「回执」页把同一信封原样交给备用中继；<br>• 委员会 2/3 确认结果；<br>• 页面下载带链历史的证据包，交给两个复算器。<br>签名前与节点比对最新区块；有页面错误、CSP 违规或横向溢出即失败。测试中发现并修复了前端两个问题：回执页重新提交后不刷新状态、不核对新回执；手机上长地址撑宽页面。CI 的开发链任务也会运行这个测试 | 桌面 873 秒、手机 906 秒，各 16 步、12 次签名全部通过：<br>• 结果哈希在服务端、页面、`verify-evidence --rpc`、TypeScript 复算器四处一致；<br>• 4 个测试身份共 7 个地址，35 次余额检查普通余额都是 0。<br>MetaMask 由注入的 EIP-1193 provider 模拟，Neuron 签名由 `omavote sign` 生成，真钱包仍待实测。证据在 `evidence/devnet-2026-10-08/e2e/` |
| 文档 | [15 运维手册](15-operations.md)、[16 API 与命令行](16-api.md)、[17 外部验收模板](17-external-acceptance.md)、[18 切换提案草案](18-governance-switch-proposal.md) | 命令、字段与拒绝码逐项对照代码 |

**没有搬的部分**：

- **协议核心与单文件前端**：本仓库已有经向量、性质测试与两套实现差分验证的实现，替换会使现有证据失效。
- **许可证**：Codex 加了 MIT LICENSE。用户随后决定本项目同样采用 MIT，已加入根目录 `LICENSE`，并写入 `Cargo.toml` 与发布包。
- **投票进度曲线与选票列表分页**：体验改进，不是验收门槛，留作后续。

**两边都还没有的**：真机钱包、另一个人写的验证器、主网规模实测、治理确认。记录方式见 [17](17-external-acceptance.md)。

## 12. 签名插件（2026-10-10）

按 [19](19-signer-extension.md) 实现，设计先经过第三轮评审（结果异步送回、`activeTab`、注入由 service worker 完成、同锚点拦截、拒绝非活动文档、确认按钮延迟、具体字节上限；签名改用核心 WASM）。代码在 `extension/`，开发分支 `signer-extension`。

| 项目 | 实现 | 验证 |
|---|---|---|
| 签名 | WASM 新增 `secp256k1_public_key` 与 `ckb_sign_message`，只包装核心已有的 k256 函数，输出协议格式 `r \|\| s \|\| v`。服务端 `POST /api/core/{method}` 拒绝这两个需要私钥的方法 | Rust 测试：与 `vectors/signatures.json` 逐字节一致；非法私钥（0、n）被拒；远程调用被拒 |
| 密钥保管 | PBKDF2-HMAC-SHA256 600,000 次，派生 AES-256-GCM 密钥，AAD 绑定版本与公钥；解锁后私钥只在 `chrome.storage.session`；签名前按解锁截止时间判断，alarm 只做辅助 | 6 项测试：往返、每次新盐与 IV、错误口令、篡改密文、换公钥、版本与口令长度 |
| 请求校验 | 只接受 `{manifest, bodies}`；先按字节上限拒绝，再由核心重建全部票面；内置网络、代理票、本 key、CKB adapter、提案接受该 adapter、同一提案同一选择、owner 不重复、最多 20 张；同锚点不同票拒绝（`ANCHOR_REUSED`） | 9 项测试 |
| service worker | 页面请求与内部操作按 `sender.origin` 分开；拒绝 iframe、非活动文档与非 https 来源；请求绑定连接版本、key 与文档，确认后签名前再查一遍；结果经 `chrome.tabs.sendMessage` 指定 `documentId` 送回；`permissions.onAdded` 完成注入，只有弹窗发起的连接才记为已连接；重置 key 断开所有站点 | 16 项测试，覆盖 19 §12 的失败场景：伪造内部消息、断开后批准、重置后批准、解锁过期而 alarm 未触发、确认超时、页面已关闭、worker 被回收后结果仍送回、关窗即拒绝、权限撤销 |
| 界面 | 工具栏弹窗与确认窗口，原生 DOM，中英文；确认范围始终可见，确认按钮在窗口获得焦点 1 秒后才可点；所有页面数据经 `textContent` 显示 | 浏览器端到端 |
| 构建 | `scripts/build.mjs` 生成 manifest；发布版取 `official.json`（现为占位，`--strict` 拒绝构建），开发版读取本地服务的 `/api/network`；内容脚本单独打包为不含 `import` 的文件 | `scripts/ci.sh` 增加类型检查、单元测试与构建 |
| 前端 | 新增“Omavote 插件（投票 key）”页签；代理投票组件的 key descriptor 与 adapter 取自签名来源，提案不接受该 adapter 时不发起签名；按 20 张分批，每个签名本地验签后再提交；GRANT 表单可直接用插件 key，也可一步以 GRANT+CANCEL 换新 key；未检测到插件时提示如何连接 | 6 项前端测试；浏览器端到端 |
| 浏览器端到端 | `web/e2e/devnet-e2e.mjs` 的 `DEVICE=extension` 模式：Chromium 加载开发版插件，完成创建 key、连接、两个 owner 授权、一次确认签两张票、重置 key、GRANT+CANCEL 换 key 并改票。`deploy/devnet/run-e2e.sh` 默认包含这一模式，CI 的开发链任务也会运行 | 447 秒，12 步全部通过：旧 key 为 A 投的票被撤回屏障排除，新 key 的票与 C 的票计入；10 个地址 26 次余额检查普通余额都是 0；无页面错误与 CSP 违规。证据在 `evidence/devnet-2026-10-10/extension-e2e/` |

**实现后的安全审查**（独立 agent 只读审查）：没有发现让页面绕过确认取得签名、或签重建票面以外内容的途径。发现 1 个中危：确认窗口打开时的自动请求会续期解锁，站点可借此让 key 永不锁定。另有 5 个低危：同锚点记录按授权区分、过窄；连接未绑定主机权限；页面卡住主线程会拖住全部请求；拒绝后可立即再弹窗，键盘可绕过 1 秒延迟；通配授权被原样注册。均已修复，每项都有对应测试（插件单元测试共 40 项）。

**还没做的**：官方域名（占位）、上架、逐浏览器人工验收、外部安全审查，见 §8 第 7 项。端到端测试里的 Neuron 签名仍由 `omavote sign` 生成。
