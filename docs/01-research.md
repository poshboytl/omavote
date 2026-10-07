# 规则与研究发现

研究基准日：2026-10-07。本文件用于说明设计依据，不是对任何现存平台的完整安全审计。v0.2 在原研究基础上吸收 Fable 草稿的补充材料；该草稿已于 2026-10-08 删除，当时引用的内容摘要和独立复核边界见 §8。

## 1. 范围与证据等级

本项目是 **CKB Community Fund DAO 的投票工具**，不是 Nervos DAO 存款合约、CKB 共识治理或二级发行金库激活。三者关系密切，但资产、权限和上线条件不同。

用户提供的 DAO category 链接可用；另一 category URL 混入了 GitHub 地址；标作 CKB 代码的 URL 实际仍指向论坛。本研究使用 [nervosnetwork/ckb](https://github.com/nervosnetwork/ckb) 作为节点实现、[nervosnetwork/rfcs](https://github.com/nervosnetwork/rfcs) 作为协议资料，并核对 system scripts。

证据分为四类：

| 标记 | 含义 | 使用方法 |
|---|---|---|
| 规则 | 正式规则仓库、已公开的修正或委员会说明 | 决定产品需要遵守什么；有冲突则列出，不能自行挑选 |
| 源码 | 固定 commit 上直接读到的行为 | 能说明该版本的实现；不自动证明线上运行同版本 |
| 社区意见 | 讨论、评测、方案作者的陈述 | 提供需求和攻击假设；不能当作共识或已证实漏洞 |
| 本设计推导 | 从规则和技术约束得出的选择 | 要用模型、集成测试或独立审计继续验证 |

检索覆盖 category 返回的 126 个主题条目，并进一步读取 category 外的技术讨论。收集 28 个主题、637 条帖子，重点阅读规则、事故、v1.1 审查、审计工具、原生投票与隐私讨论。14 个仓库的 SHA、时间和论坛来源见 [sources.json](../research/sources.json)。没有执行现有平台的端到端主网投票，不能据此宣称重现了其所有历史漏洞。

## 2. 能确认的基础规则

现有中文规则的核心是：讨论一周、30 个赞；发起者至少持有 100,000 CKB 的 Nervos DAO 存款；公开投票七天；预算提案参与权重至少为申请预算三倍、赞成比例至少 51%；元规则提案参与权重至少 185,000,000 CKB、中文写至少 67%；公开结果与投票者。禁止向投票者空投资产；另有大额预算分期支付要求。英文元规则通过条件却写成“超过 67%”，与中文及设置指引存在边界差异。[中文规则](https://github.com/CKB-Community-Fund-DAO/rules/blob/d7e5157c1345e157bf154ea52d4142bcc464769e/rules-cn.md)、[英文规则](https://github.com/CKB-Community-Fund-DAO/rules/blob/d7e5157c1345e157bf154ea52d4142bcc464769e/rules-en.md)

2023 年修正已把票权基础从历史累计存款改为当前持有的 Nervos DAO 存款，并排除已解锁或已提现的 CKB。原提案讨论也揭示了循环存取累加历史票数的问题。[计算方式修正](https://talk.nervos.org/t/dis-changing-how-votes-are-calculated/7120)、[规则更新记录](https://talk.nervos.org/t/ckb-community-fund-dao/6873/4)

**因此本项目不主动引入**持有时间乘数、利息乘数、平方根权重、每人一票、流通 CKB 权重、投票代币或治理代表制度。这些都不是换工具的必要条件。

## 3. 规则文案、实际实现与新设计之间的缺口

| 问题 | 研究发现 | 本设计处理 |
|---|---|---|
| “当前”是哪一刻？ | 正式规则没有完整指定；历史 Metaforo 报告描述投票请求时查询；v1.1 文档及计票代码按结束高度查询 | 不宣称现状已经统一。推荐结束状态统一结算，必须在切换说明中确认 |
| 提款第一阶段是否计票？ | DAO 有 deposit、withdrawing 两种不同状态；历史事故报告描述只取“存款中” | 建议只纳入真正 deposit，启动提款即移除；显式列为兼容性确认点 |
| 是否计利息？ | 历史报告按 deposit capacity 累计，没有采用 DAO 最大可提现额公式 | 保留本金 capacity 线性权重，不自动加利息 |
| 小数怎么处理？ | 2025 调查说明 Metaforo 忽略小数；未得到足以证明所有路径的完整后端源码 | 精确整数保存 shannon；最终量化策略在规则 profile 中固定，不能偷偷改精度 |
| 67% 的相等边界？ | 中英文文本有差异 | 测试同时覆盖 `>=` 和 `>`；正式 profile 必须择一 |
| 是否有弃权？ | v1.1 文档包含 Abstain，基础规则没有完整定义分母处理 | v1 首选 Yes/No/撤回；如需 Abstain，先明确其是否计入 quorum、比例分母 |
| 七天是什么时间？ | 规则写七天，v1.1 源码采用 42 epochs | 不把 epochs、固定区块数当成精确七天；将 clock 与边界写入 profile |
| 多地址绑定 | 旧平台绑定到账号；后续方案还包含 DID、解绑和直接投票覆盖 | 新工具以完整 lock script 为票权主体，地址集合只是界面汇总 |

依据：[2025 调查](https://talk.nervos.org/t/dis-community-fund-dao-v1-1-web5-community-fund-dao-v1-1-web5-optimization-proposal/8973/70)、[v1.1 审计性说明](https://github.com/CCF-DAO1-1/ccfdao-v1.1-docs/blob/12a6e8e15c0ebfdfbe42215cae40badde6b1e5c7/content/docs/en/developer-docs/architecture/decentralization.mdx)、[v1.1 计票实现](https://github.com/CCF-DAO1-1/app_view/blob/7c6705975dfd787654961d75930d5a3b484068b3/src/scheduler/check_vote_finished.rs)。

这里的“保持计算方式”应首先落实为：同一笔实际有效本金只贡献一次线性票权。对以上未定义边界，必须公开解释并按 DAO 流程确认；不能为了逐行模仿旧 bug 再造漏洞，也不能把不同政策包装成无差别技术升级。

美元等值预算也不能临时换算后直接带入三倍 quorum。2026 年委员会说明允许提案明确约定特殊支付条款；本工具应固定本次投票的 CKB quorum 基数，并另存支付币种、换算时间与条款。[支付条款说明](https://talk.nervos.org/t/dis-fiber-desktop-v1-ground-up-rebuild-and-launch-fnn-desktop-app/10317/9)

## 4. 从真实事件提取需求

### 4.1 2025 年重复投票

委员会公开调查确认：同一 Nervos DAO 地址解绑后绑定另一个 Metaforo 账号，能再次贡献票权；报告剔除了 71,247,257 的重复权重。调查还指出缺少完整绑定历史，最后依靠额外日志还原。这是同一资产重复归属问题，不是简单的“机器人账号太多”。[委员会报告](https://talk.nervos.org/t/dis-community-fund-dao-v1-1-web5-community-fund-dao-v1-1-web5-optimization-proposal/8973/70)

设计要求：计票主键不能是网站账号；资产身份用 outpoint，所有者身份用完整 lock script；任何 UI 的绑定、解绑都不能复制票权；证据须在投票发生时就可导出，事后不能依赖管理员调数据库。

### 4.2 2026 年过渡措施与 Watchdog

公开说明采用临时禁止解绑和投票后检查资金流的办法。Watchdog 则将 Metaforo 展示数据与链上查询对照。这改善了可观察性，但不能单靠“今天的余额一致”证明截止时余额、账户绑定历史和所有选票的完整性。[过渡措施](https://talk.nervos.org/t/dis-ckb-integration-for-rosen-bridge/9756/96)、[Watchdog 源码](https://github.com/CKBFansDAO/ckb-dao-watchdog/tree/ed39312f7e8a959571ea6c759522edec98498c62)

设计要求：审计应能回答“在已确定的那条链、那个截止状态下，这笔本金最终属于哪张有效票”，而不只是给出偏差百分比。

### 4.3 DAO v1.1

v1.1 把投票与绑定信息放到链上，尝试使结果可复算，方向有价值。与此同时，其公开设计把 DID、投票者集合、SMT proof、多个 indexer 和计票服务连接起来。投票合约验证集合成员资格、输入 lock 关联和选项等条件，计票与时间仍有链下解释。它不是一个由合约独立完成全部结果判定的系统。[文档](https://github.com/CCF-DAO1-1/ccfdao-v1.1-docs/blob/12a6e8e15c0ebfdfbe42215cae40badde6b1e5c7/content/docs/en/developer-docs/architecture/decentralization.mdx)、[合约](https://github.com/CCF-DAO1-1/ckb-dao-vote/blob/d7d85f0b0beb8b2fd53c7d7f0902f5414622680b/contracts/ckb-dao-vote/src/entry.rs)

社区提出选择性不给 proof、集合遗漏、重复绑定、截止解释和浏览器身份密钥管理等问题。开发团队公开修复表回应了其中一些问题。应区分已修复 bug、架构取舍和治理争议，不能把旧评测直接当成当前版本漏洞清单。[代码审查讨论](https://talk.nervos.org/t/dao-v1-1-whitelist-and-beyond-community-led-code-review/10091)、[测试报告及回应](https://talk.nervos.org/t/dao-v1-1-public-testing-report/10182)

后续确实公开了参考审计工具。其研究快照 README 仍要求 DID、地址绑定、DAO 三个索引服务；这与“下载一个 CLI，仅连自己的节点就可独立完成审计”有区别。独立评测亦指出这一边界；本研究没有对它做完整重审。[参考审计器](https://github.com/CCF-DAO1-1/ccfdao-vote-auditor-rfc/tree/efe59d77f4f1f00d050fe5f2006b5aad753d2491)、[独立评测](https://talk.nervos.org/t/dao-v1-1-reference-auditor-an-independent-assessment/10201)

本项目吸取的教训不是“后台必须消失”，而是：**后台可以帮助用户，不能成为产生有效选票所必需的授权者；独立路径必须随产品交付。** 一棵任何人可从相同数据重建的树不是天然不安全；问题在于根是否正确、全集是否公开、是否排除了合资格者、遗漏是否能纠正。若投票数据本来就要链下复算，额外增加一个不必要的上链前准入树，可能只扩大失败面。

## 5. CKB 技术约束：直接核对过什么

### 5.1 Nervos DAO 是 type script，资金控制来自 lock

deposit cell 使用 Nervos DAO type script，data 必须恰为八个零字节。第一阶段提款消费 deposit，按相同位置和相同 capacity 产生 withdrawing cell，其 data 为原存款区块号；第二阶段才取出本金与补偿。180 epochs 是提款规则的一部分，不是投票工具额外锁仓。[RFC 23](https://github.com/nervosnetwork/rfcs/blob/62a6e08e16a995ab94562581978ceac3726c31e6/rfcs/0023-dao-deposit-withdraw/0023-dao-deposit-withdraw.md)、[dao.c](https://github.com/nervosnetwork/ckb-system-scripts/blob/72eb92fca090700dcb398cd8cad8fbd8bad40355/c/dao.c)

推论：不能把既有 deposit 当作普通零钱消费后“原样存回、顺便换一个投票 lock”，并声称其存款历史不变。需要协议级托管/配对的新方案应从新存款开始，或说明提款再存入的迁移成本。投票时原则上根本不应把用户 DAO cell 放进 inputs。

### 5.2 inclusion 不等于历史 liveness

当前 RawHeader 有 transactions_root、dao 等字段，没有可用于查询任意历史 live-cell 集合的状态根。交易 inclusion proof 证明某笔创建交易存在，不能独自证明某个 outpoint 在 H 之前未被花费。[区块结构源码](https://github.com/nervosnetwork/ckb/blob/2592ddf0502cd4adfe886db893cccc866db3c60f/util/gen-types/schemas/blockchain.mol)、[RFC 27](https://github.com/nervosnetwork/rfcs/blob/62a6e08e16a995ab94562581978ceac3726c31e6/rfcs/0027-block-structure/0027-block-structure.md)

推论：历史快照需要完整重放、经验证的索引、可信快照或证明覆盖完整历史区间的 zkVM。把第三方快照 Merkle root 写上链不会使原始快照自动正确。

### 5.3 cell_deps 不是永久证明

引用 deposit 为 cell_dep，可借交易验证确认其在该交易执行时可被解析为 live cell；这不等于它在截止时仍然 live。结算时才引用它，又可能因为已被花费而失败。节点解析代码显式拒绝 dead outpoint。[cell resolver](https://github.com/nervosnetwork/ckb/blob/2592ddf0502cd4adfe886db893cccc866db3c60f/util/types/src/core/cell.rs)

`get_cells` 返回的是 live cells；给它附加创建高度过滤，不能获得已经花掉的历史 live 集合。RPC 支持交易及 witness proof，但仍需核验历史完整性。[CKB RPC](https://github.com/nervosnetwork/ckb/blob/2592ddf0502cd4adfe886db893cccc866db3c60f/rpc/README.md)

### 5.4 签名有效不等于拥有被声明的地址

CCC 已实现多种消息签名验证，但它验证的是消息与 identity 的关系。应用还必须把 identity 按对应 lock 的真实规则映射到完整 script。尤其不能让用户提交自己的公钥签名，再附上别人的 CKB 地址。[CCC 验证分发](https://github.com/ckb-devrel/ccc/blob/722cfe28bb184145e14887d54162d55fbe3dcadb/packages/core/src/signer/signer/index.ts)

同样，某地址的普通 cell 成为交易 input，不对所有 lock 都等于主人授权投票。ACP 可有免签收款路径；Omnilock 还包含可选管理、时间和其他模式。因此“链上交易成功 + input lock 相同”不是通用投票权授权证明。[ACP RFC](https://github.com/nervosnetwork/rfcs/blob/62a6e08e16a995ab94562581978ceac3726c31e6/rfcs/0026-anyone-can-pay/0026-anyone-can-pay.md)、[Omnilock RFC](https://github.com/nervosnetwork/rfcs/blob/62a6e08e16a995ab94562581978ceac3726c31e6/rfcs/0042-omnilock/0042-omnilock.md)

### 5.5 时间与原生状态并发

`since` 提供交易不得早于某时点的约束，不能简单写一个 `since` 来证明投票不得晚于截止。合约也不能把调用者任意提供的旧 header 当成当前时间。采用历史重放计票则可以从实际收录区块判断边界，但必须约定时间函数与重组政策。[Since RFC](https://github.com/nervosnetwork/rfcs/blob/62a6e08e16a995ab94562581978ceac3726c31e6/rfcs/0017-tx-valid-since/0017-tx-valid-since.md)、[节点时间验证](https://github.com/nervosnetwork/ckb/blob/2592ddf0502cd4adfe886db893cccc866db3c60f/verification/src/transaction_verifier.rs)

共享一个计票 cell 会产生消费竞争，独立选票可避免投票阶段争抢。分片能降低竞争，但不能自行证明所有票都已被纳入结算。

## 6. 其他方案值得借鉴，但不能直接套用

| 方案 | 值得采用的部分 | 不可忽略的差异 |
|---|---|---|
| Deposit-Paired Voting | 将资产、控制权、状态转换显式绑定；讨论计票完备性 | 文中方案涉及存款配对托管、串行状态和不同的派生权重，不符合本任务直接保留原本金票权的基线 |
| CKB Governance testnet | 独立 intent、分片 tally、权限与退款所有权分离 | 研究快照只允许新建等权 poll，不能保留本任务的本金票权；文档明确承认已关闭分片可能遗漏未聚合的有效 intent，退款不补计票 |
| ckb-vote-poc / zkVM | 证明区块连续性及交易根，公开值绑定起止区块，可压缩历史复算 | 本次快照的规范仍有特定投票语义，例如 NO 与撤回的处理；不是现有 51%/67% 模式的即插即用实现 |
| Snapshot | 签名投票、可扩展策略、成熟产品交互 | 自定义 API 能返回权重，不意味着 CKB 历史票权已经可独立验证；仍需解决 CKB lock 适配和最终快照 |
| DAO v2 代表制提案 | 从治理参与率出发讨论授权与职责 | 是治理制度分支；不应趁换工具引入 |

来源：[Deposit-Paired](https://talk.nervos.org/t/on-chain-tally-dao-v1-1-limits-and-a-deposit-paired-voting-proposal/10171/1)、[原生投票测试网](https://talk.nervos.org/t/ckb-governance-cell-native-dao-voting-protocol-on-testnet-create-poll-question-vote-delegate-aggregate-close/10584/1)、[zkVM 规范](https://github.com/XuJiandong/ckb-vote-poc/blob/c70421b45b930325a4dda558de12fcad5f8b7918/docs/spec.md)、[Snapshot 策略](https://docs.snapshot.box/space-handbook/custom-calculations)、[DAO v2](https://github.com/CKBDAO/ckb-dao-v2)。

上述原生投票项目在合约中拒绝 `token_weighted`，其分片说明还将结果正确性限定为“实际聚合的 intents”，并承认完备性依赖协调者/索引。这是该固定研究版本自己声明的边界，不是对所有链上计票方案的否定。[合约约束](https://github.com/anihdev/ckb-voting-dapp/blob/2af7bafb9e579de56b0103bad2dc1eab7eee4662/backend/contracts-rust/contracts/governance/src/entry.rs#L1035)、[分片设计的限制](https://github.com/anihdev/ckb-voting-dapp/blob/2af7bafb9e579de56b0103bad2dc1eab7eee4662/SHARDED_AGGREGATION_EXPLAINED.md#what-this-does-not-solve)

zkVM 能证明程序被正确执行，仍需审计程序表达的是不是正确规则、输入是否完整、区块终点是否锚定正确链。其性能文档中的费用是当时条件下的估算，不应作为今天的预算承诺。已有 `count_vote` 微基准也不能代表首次同步、交易根计算、完整证明生成或实际 RPC 下载成本。[微基准范围](https://github.com/XuJiandong/ckb-vote-poc/blob/c70421b45b930325a4dda558de12fcad5f8b7918/docs/native-count-vote-benchmark.md)

## 7. 对社区意见的独立判断

| 社区诉求或主张 | 本设计判断 |
|---|---|
| 社区拥有和维护代码 | 必须；还要开放协议、数据导出、构建和完整恢复路径，否则只是更换运营者 |
| 必须全部链上计票才安全 | 过强。结果可复算且金库仍人工多签时，公开可审计的链下计票可接受；要自动释放金库则另当别论 |
| 合约无法联网，所以必须白名单 | 不是必然。可后验验证资格，或使用当前资产依赖、状态协议、历史证明；每条路线各有代价 |
| 有审计工具就没有审查风险 | 错。证明算错与证明有人被阻止提交是不同问题；必须有实际可用的旁路 |
| 多几个 RPC 就等于去信任 | 错。只能发现部分不一致，多个接口也可能共用数据源；需自己的验证节点或证明 |
| 每个账号只能绑定一个地址即可防作弊 | 错。授权和去重必须落实到资产，账号规则只改变 UI |
| 公开投票一定没有隐私问题 | 错。公开选择符合现规则，但社交身份与持仓关联仍有风险；昵称应完全可选 |
| 为防巨鲸改成平方根/一人一票 | 超出本任务且需要可靠身份；多地址可拆分，技术不会自动提供“一人” |
| 简单比完美更重要 | 同意范围控制；不同意把已知可重复计票、无证据恢复或任意资格删除作为简化 |

背景：[v1 反思](https://talk.nervos.org/t/my-reflection-on-ckb-community-dao-v1/8750)、[公开投票与隐私](https://talk.nervos.org/t/general-discussion-public-voting-in-metaforo/7001)、[讨论阶段的 Sybil 问题](https://talk.nervos.org/t/governance-security-flaw/7210)。

新的投票器不能解决项目优劣、利益冲突或参与意愿。它应该使真实的投票意图按公开规则计入，并使错误可被发现、复现和纠正。

## 8. v0.2 吸收的补充研究

本轮阅读 Fable（Claude）设计及补充调研，把它们作为已有研究之外的输入；没有把其统计自动改称为本方独立实测，也没有重跑整个主网普查。该草稿及其研究目录已于 2026-10-08 按用户要求删除，下表只保留当时采纳的内容摘要。表中数字没有经过本方独立复核，需要时须在 P0 从原始来源重新采集。

| 当时的材料 | 对设计有用的部分 | 证据边界与后续动作 |
|---|---|---|
| 主网 DAO 分布及采集脚本 | 记录 2026-10-07、tip 20,664,801 附近的 deposit 类型与本金分布；支持优先验证标准单签和旧 PW-lock 路径 | 报告中约 95% 是本金按脚本分类，不能推断同样比例的人使用 Neuron 或冷钱包；上线前固定 block hash、处理分页变化并重新普查 |
| Metaforo 调研 | 32 次历史投票记录、绑定教程、参数填写与故障案例；帮助组织迁移样本和复核界面 | 旧平台后端没有完整公开；记录与推断需回到原始 API/委员会说明交叉核对；历史签名缺失不能补造 |
| 钱包代码研究与代码事实核验 | 消息前缀、签名类型、地址推导、硬件和子密钥路径 | 有 SDK 路径不等于本产品真机支持；逐网络、钱包版本、完整 lock 模式验收 |
| 可读票面、产品设计与体验走查 | 钱包中显示标题/预算、提案导入、通知、公共 API、多地址痛点 | 已写入本套正文；主干用全文上链与签名排序，v0.3 纳入期限型 key 授权，多规则开关不并入 |

Metaforo 绑定需要区分三层：本次挑战签名证明地址签名能力，链上存款查询给出金额，平台保存“账号—地址”关系并在以后投票时使用。它没有自动提供以后每一票的地址签名；一次绑定也没有永久冻结票权。按地址绑定而非按 deposit 笔数绑定，同地址多笔存款可汇总，不同 HD 地址仍需分别证明控制权。[委员会对计权逻辑的说明](https://talk.nervos.org/t/dis-community-fund-dao-v1-1-web5-community-fund-dao-v1-1-web5-optimization-proposal/8973/70)

v0.3 延续一次设置的使用习惯，以有期限、可验证的 key 授权替代永久网站账号关系；每个提案仍有独立签名票。默认一年（365 链日）、最长 365 天，详见 [授权规范](11-authorization.md)。首次多地址授权、密钥保管与恢复仍有成本，不能单凭本金集中度代替参与者体验。
