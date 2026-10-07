# Omavote 协议草案 v0.3

本文把推荐方案写到可以开始实现与审查的粒度。它尚未经过钱包互操作测试或安全审计，不是主网标准。`rules_profile` 中涉及现规则歧义的项目须在正式切换前确认；以下默认值是设计建议。

2026-10-08 修订：首版加入默认一年（365 链日）、最长 365 天的期限型投票授权；[11：授权规范](11-authorization.md) 是本文的组成部分。v0.3 是文档版本；因选票字段、授权状态与载体种类变化，线协议标为**未部署的 V2 草案**。旧 V1 示例不自动兼容，生产实现不得宽松混用。字段与算法供同事评审，真实编码向量、设备验收和安全审计仍未完成。第二轮评审及两次同事复核后的修订见 [09 §9–11](09-design-update.md)：提案签名、流程角色与按锚点排序的流程记录（§3.1）、确定性开票与准入确认（§3）、adapter ID、全局控制格式集合与提案级选票清单（§5.1）、签名文本首行摘要（§5）、选票只按锚点排序且不设序号（§6）。

## 1. 不变量

1. 同一提案中，一笔有效 DAO deposit 本金最多计入一次。
2. 只有按其 lock 授权语义证明控制权的主体，或其按固定规则公开授权的投票密钥，才能改变该主体的选票；owner 保有直接接管权。
3. 提案内容、预算、接收脚本、规则、支持的签名解释和时间窗口在启用后不变。
4. 运营者返回什么余额、排序或结果，不影响从相同规范和链历史独立计算的结果。
5. 输入不足或验证失败必须输出失败/不完整，不能把 RPC 错误当成零余额并发布确定结果。
6. 纯投票路径不消费用户 DAO deposit，不向中继授予花费权。

## 2. 规范化与标识

`H` 为标准 CKB Blake2b-256，使用 CKB personalization。每种用途加固定、不混淆的前缀。原生 script hash 使用 Molecule Script 序列化和标准 CKB hash，不能用 JSON 字符串替代。

协议 JSON 使用 UTF-8、RFC 8785 JCS；重复 key、非法 Unicode、未知关键字段、非规范整数全部拒绝。金额、高度、毫秒时间等整数均用十进制字符串，禁止符号、前导零（零本身除外）、指数与小数；实现中使用 BigInt/u128 或足够宽的整数。哈希和 script args 使用小写 `0x` 十六进制，长度严格校验。显示标题不参与标识推测，签名后不进行 Unicode 归一化。[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)

```text
owner_id = CKB_script_hash(full_lock_script)
rules_hash = H("OMAVOTE/RULES/V2\0" || JCS(rules_profile))
poll_id = H("OMAVOTE/POLL/V2\0" || JCS(manifest_without_signatures))
ballot_id = H("OMAVOTE/BALLOT/V2\0" || JCS(ballot_body))
```

`ballot_id` 不包含签名字节，避免同一意思的不同签名编码、可塑性或再次签名制造新的改票事件。验签仍须对每份 proof 独立完成；无效 proof 不能占据一个 ID 从而阻止后来的有效 proof。

## 3. 不可变提案 Manifest

至少包含：

| 字段 | 说明 |
|---|---|
| `protocol_version`、`network_genesis_hash`、`dao_namespace` | 防跨协议、跨网络、跨 DAO 重放 |
| `nonce` | 32 字节提案随机标识；重开投票使用新值 |
| `proposal_type` | `grant` / `meta_rule`；不让前端任意调通过门槛 |
| `title`、`signing_title`、`content_hash`、`content_locations` | 完整标题、钱包签名用短标题、固定正文及附件 hash；可列多个镜像 |
| `forum_topic_id`、`forum_revision`、`discussion_evidence_hash` | 讨论来源和准入审查材料 |
| `budget_ckb_shannon`、`quorum_base_shannon` | 投票时确定的整数预算和 quorum 基数 |
| `payment_terms_hash`、`recipient_lock_script` | 支付条款与实际接收脚本；地址文字只是展示 |
| `proposer_owner_locks` | 发起者控制的完整 lock，去重并按 owner_id 排序；每个 lock 的签名在 manifest 之外，见 §3.1 |
| `rules_profile`、`rules_hash` | 完整规则及其 hash |
| `auth_registry`、`auth_registry_hash` | `{"owner_adapters":[…],"key_adapters":[…]}`：本提案接受哪些格式签署的直接票、提案签名，以及代理票所依据 grant 的 owner/key 格式，语义由 §5.1 冻结；授权控制消息按 §5.1 的全局控制格式集合处理，不受本清单影响 |
| `authorization_policy`、`auth_policy_hash` | 完整授权语义 policy 与 hash（11 §2），不含 adapter 列表 |
| `signature_formats` | 冻结支持的票面格式列表；默认只有 `omavote-readable-v2`。可选 WebAuthn 验收后才可明确加入 `omavote-webauthn-v2`，不能开票后添加或自动降级 |
| `clock`、`start`、`end`、`confirmation_policy` | 截止与重组规则 |
| `publication_policy` | 本提案是否要求链上完整选票；禁止临时改变 |

正式提案还需 proposer 签名和既有 DAO 流程要求的准入记录，格式见 §3.1。讨论点赞不是链上事实；协调者对审查材料签名，但不能把其判断冒充密码学证明。所有人都能创建带相同标题的测试 poll，因此前端必须区分“密码学结构有效”和“已被 DAO 正式接纳”。官方目录与论坛交叉链接用于辨认真正提案，选择性不列出合格提案的问题仍由现有治理处理。

发起者的 100,000 CKB 要求须有可复算的检查时点。候选是 manifest 发布交易后的状态：对已签名、去重后的 `proposer_owner_locks` 汇总 active deposit，并记录检查区块；若现有流程要求开票时再次满足，则另在开票状态复查。这属于准入规则的时点澄清，不得把发起者资格与所有投票者资格混为一谈。没有规则依据时，不要求发起者一直锁仓到付款。

CKB 计价的普通预算提案中，`quorum_base_shannon` 必须等于本次整体申请预算；分期支付不能自行把三倍 quorum 降为第一期金额。非 CKB 计价或附特殊条款的提案，需要在正式准入时固定经授权的 CKB 基数与依据。前端必须显示基数与支付预算的关系，禁止 coordinator 通过自由填写该字段改变门槛。

开票确认是链上可判定的规则：令 `b_m` 为 manifest（含全部有效 proposer 签名）首次有效收录的区块，`b_s` 为第一个 `clock(b) >= start_ms` 的区块，要求 `height(b_s) - height(b_m) >= rules_profile.opening_confirmations`。不满足即为 `LATE_MANIFEST`，该 poll 不产生投票结果，须用新 nonce 重新创建。正式开票另需 §3.1 的准入记录同样至少早于 `b_s` `opening_confirmations` 个块收录，避免临近开票的准入被重组移除后正式状态翻转；资格校验失败或正文不可得的 manifest 不进入正式投票状态。题目、预算、接收方、规则任何实质变动均创建新 poll_id 并重走对应流程；补充评论不改 hash。

长正文与附件可在公开镜像保存并做链上 hash 承诺。B 的短 manifest、rules_profile、adapter 注册表声明与 authorization_policy 本身必须完整进入历史载荷，确保包括可读签名渲染所需字段在内的协议输入可从链重建。正文缺失时能验证选票属于哪个 hash，却无法确认投票内容，状态应为 `CONTENT_UNAVAILABLE`，不能只显示一个绿色“已验证”。

提案创建页自动读取论坛 category、topic/post/revision、完整正文、创建时间、可取得的点赞数及原帖收款地址。自动读取不证明“一周内获得 30 个赞”，缺少历史证据时按既有流程留存人工核对说明。预算、整体 quorum 基数与收款 script 必须由提案人确认后签入 manifest，不能由服务器在签后重新解析并覆盖。币价和美元条款记录来源及时间，不在投票中自动重算预算。

协调者的准入核对、论坛改帖提醒、委员会的争议标记作为 §3.1 定义的流程记录公开：绑定网络、poll_id、用途、证据 hash、签发角色与签名。它们不修改原 manifest、原票或数学计票结果。现有治理可以决定暂停执行或重开提案，但前端必须把“按固定规则计算的结果”和“治理处置状态”分开显示。声称来自某主体的记录必须验证其真实签名及权限；收款输出使用该主体的 lock 不构成其签名证明。

### 3.1 提案签名、流程角色与流程记录

**提案签名。** manifest 本身不含签名，`poll_id` 也不覆盖签名。`proposer_owner_locks` 中的每个 lock 都须用本提案 `auth_registry.owner_adapters` 中的 adapter 签一份 `omavote-proposal-v2` 文本；缺任何一份有效签名，manifest 都无效。代理投票 key 不能签提案。

```text
OMAVOTE PROPOSE #<poll_id 去掉 0x 后的前 16 位> <预算摘要>
OMAVOTE V2 - PROPOSAL SUBMISSION, NO ASSET TRANSFER

Format: omavote-proposal-v2
DAO: <dao_namespace>
Network-Genesis: <network_genesis_hash>
Proposal: <poll_id>
Type: <FUNDING | META-RULE>
Title: <manifest.signing_title>
Budget-CKB: <exact decimal CKB or none>
Recipient: <full CKB address or none>
Start-Chain-Time-UTC: <start_ms rendered as UTC>
End-Chain-Time-UTC: <end_ms rendered as UTC>
Proposer: <该 proposer lock 的完整地址>
Rules-Hash: <rules_hash>
```

渲染规则与 §5 的选票文本相同，`proposal_type` 的 `grant`/`meta_rule` 分别渲染为 `FUNDING`/`META-RULE`。manifest 载荷为 `{"protocol_version":"2","manifest":{…},"proposer_proofs":[{"owner_lock":…,"auth_adapter":…,"proof":…},…]}`，proof 按 owner_id 排序，每个 proposer lock 恰一份。

**流程角色。** 委员会与协调者用独立的流程密钥签署流程记录，不复用金库多签密钥、存款密钥或投票授权 key；流程密钥没有任何资产权限。角色配置是完整公开的对象，成员为 [11 §4.1](11-authorization.md) 的 key descriptor：

```json
{
  "message_kind": "process_roles",
  "protocol_version": "2",
  "network_genesis_hash": "0x<32-byte genesis hash>",
  "dao_namespace": "ckb-community-fund-dao",
  "previous_roles_hash": null,
  "roles": {
    "committee": {"threshold": "<existing governance threshold>", "members": ["<key_descriptor>"]},
    "coordinator": {"threshold": "1", "members": ["<key_descriptor>"]}
  },
  "nonce": "0x<32-byte random nonce>"
}
```

`roles_hash = H("OMAVOTE/ROLES/V2\0" || JCS(process_roles))`。成员按 key_id 排序去重，阈值为十进制字符串，且 `1 <= threshold <= 成员数`。

* **初始配置**不能在链上自举。成员名单与委员会阈值沿用既有治理确定的结果；完整对象与 `roles_hash` 写入用户发起的工具切换元规则提案（[09 §6](09-design-update.md) E），通过后作为 V2 部署参数固定在前端与 verifier 配置中，对象本身用载体完整公开。验证报告和结果证据包须写明所用的初始 `roles_hash`。
* **变更**只能通过 `ROLES_UPDATE` 记录：由当前生效配置的委员会达到阈值签名，指定新配置的 hash；新对象的 `previous_roles_hash` 必须等于当前值，且已在该记录之前完整公开。新配置从记录的收录位置起生效；同一个 `previous_roles_hash` 只接受第一份有效更新。该记录同样受下文的锚点与发布期限约束，签好后被扣住的旧更新过期即不能再发布生效。成员换届按既有治理结果执行，本协议只核验签名链，不判断换届程序是否合法。

**流程记录。**

```json
{
  "message_kind": "process_record",
  "protocol_version": "2",
  "network_genesis_hash": "0x<32-byte genesis hash>",
  "dao_namespace": "ckb-community-fund-dao",
  "roles_hash": "0x<roles_hash in effect when signing>",
  "role": "coordinator",
  "record_type": "ADMISSION",
  "poll_id": "0x<32 bytes>",
  "detail": {"decision": "ADMITTED"},
  "evidence_hash": "0x<32 bytes>",
  "anchor_block_hash": "0x<32 bytes>",
  "publication_deadline_ms": "<decimal ms>",
  "nonce": "0x<32-byte random nonce>"
}
```

`record_id = H("OMAVOTE/PROCESS/V2\0" || JCS(process_record))`。

**排序、去重与发布期限。** 流程记录与授权控制一样，签入一个已知规范链祖先 `anchor_block_hash`，并签入 `publication_deadline_ms = clock(anchor) + max_process_publication_delay_ms`。后者是协议常数，候选 72 小时，给委员会收集阈值签名留出时间。首次有效收录必须位于锚点之后，且收录时链时钟早于该期限；过期未发布须重新签署。

* 同一 `record_id` 只认首次有效出现，原样重发不产生新效果。
* 同一 poll 的同类记录（ADMISSION、GOVERNANCE_STATUS、RESULT_ATTESTATION）按锚点高度比较，锚点最高者生效，而不是最后收录者；锚点相同、内容不同为 `RECORD_CONFLICT`。
* EXECUTION 与 NOTICE 只作展示，不参与排序。

因此，原样重发或首次发布一份被扣住的旧声明，都不能覆盖锚点更新的记录。签名客户端同样取已验证的最新块作锚点。

| `record_type` | 签署角色 | `detail` | 作用 |
|---|---|---|---|
| `ADMISSION` | coordinator | `decision`：`ADMITTED` / `REJECTED` | 在至少早于 `b_s` `opening_confirmations` 个块收录的有效 ADMISSION 中取锚点最高者；为 ADMITTED 时该 poll 显示为正式开票。迟到、缺失或冲突时显示未正式准入，数学结果仍可复算 |
| `NOTICE` | coordinator 或 committee | `code`：1–16 个大写字母、数字或下划线，例如 `FORUM_EDITED` | 只作公开提示，不改变任何状态 |
| `GOVERNANCE_STATUS` | committee | `status`：`HOLD_EXECUTION` / `CLEARED` / `VOIDED` | 锚点最高的有效记录决定治理处置的显示；冲突时按 HOLD_EXECUTION 显示；不改 result_core |
| `RESULT_ATTESTATION` | committee | `result_hash`；`outcome`：`PASS` / `FAIL` | 锚点最高的有效记录为委员会确认；`outcome` 必须与 `result_hash` 所指 result_core 的结论一致。result_hash 与独立复算不同、outcome 与结论不符或记录冲突，均显示争议，不作为委员会确认 |
| `EXECUTION` | committee | `tx_hash` | 记录金库付款交易，仅供查阅 |
| `ROLES_UPDATE` | committee | `new_roles_hash` | 见上文；`poll_id` 为 null；同样受发布期限约束 |

每名签署成员用其 key adapter 签 `omavote-process-v2` 文本，渲染规则同 §5：

```text
OMAVOTE <ADMIT | NOTICE | STATUS | RESULT | EXECUTION | ROLES-UPDATE> #<poll_id 或 new_roles_hash 去掉 0x 后的前 16 位>[ <摘要值>]
OMAVOTE V2 - PROCESS RECORD, NO ASSET TRANSFER

Format: omavote-process-v2
DAO: <dao_namespace>
Network-Genesis: <network_genesis_hash>
Record-Type: <record_type>
Role: <COORDINATOR | COMMITTEE>
Proposal: <poll_id or none>
Detail: <JCS(detail) 单行原文>
Evidence-Hash: <evidence_hash or none>
Anchor-Block: <anchor_block_hash>
Publish-Before-Chain-Time-UTC: <publication_deadline_ms rendered as UTC>
Roles-Hash: <roles_hash>
Record-Hash: <record_id>
```

摘要值依次为 decision、code、status、outcome；EXECUTION 与 ROLES-UPDATE 没有摘要值。首行同样只用可打印 ASCII，不超过 60 字节。

记录信封为 `{"body": process_record, "proofs": [{"signer_key_id": …, "proof": …}, …]}`。有效条件：锚点与发布期限有效；`roles_hash` 是该收录位置的生效配置；签名者是该配置中 `role` 的不同成员；有效签名数达到阈值。非成员签名或重复签名被忽略，不足阈值则整份记录无效。流程记录只影响正式/治理状态的显示和后续角色配置；任何角色都不能修改 manifest、选票、授权、窗口、权重或 result_core。

## 4. 规则 Profile

首版只实现一个小范围 profile，拒绝任意用户上传 JavaScript 权重函数：

```text
asset                = Nervos DAO deposit cell
amount                = raw capacity principal
weight_time           = final accepted block state
withdraw_phase1       = excluded
cast_eligibility      = positive deposit weight at valid inclusion
revote                = per-owner direct priority; latest valid anchor within authority stream
authorization         = term-limited, maximum 365 chain days
cancel                = exclude from both sides and quorum
choices               = YES / NO / CANCEL
quorum(grant)         = 3 * fixed quorum_base_shannon
quorum(meta_rule)     = 185000000 * 100000000
approval(grant)       = 51 / 100
approval(meta_rule)   = 67 / 100
threshold_comparison = governance-confirmed inclusive or strict
precision             = governance-confirmed quantization
opening_confirmations = governance-confirmed block count (test candidate 100)
delegate_cutoff_ms    = 0 (first release: no delegate-only final window)
```

`opening_confirmations` 是 manifest 和准入记录收录到开票之间至少相隔的区块数（§3），由规则固定，不让提案人自选。候选值 100 只用于测试，不代表已证明足够安全。`delegate_cutoff_ms` 为评审问题 B 预留：截止前这段链时间只收 owner 直接票，此前有效的代理票保留，授权撤销照常。首版取 0，即不启用；以后启用须经规则确认，形成新的已确认 profile，不改线格式。

`CANCEL` 是撤回参与，**不是反对票，也不是计入 quorum 的弃权票**。如果社区需要 Abstain，要发布包含清楚分母语义的新 profile。

这里故意没有为 precision 指定伪装成历史事实的默认值：

* 精确本金模式：全部 shannon 直接进入统计，显示 CKB 小数；数学上最一致。
* 旧平台截断模式：只有查清截断发生在 cell、地址还是账号汇总之后，才能宣称兼容。取消账号作为共识身份后，更不能凭直觉把“按账号截断”改成“按 lock 截断”。

研究模型使用精确本金模式检验守恒与攻击，不证明它与所有旧平台边界逐票相同。正式切换说明须把精度与快照语义列明。未确认的 profile 不能用于有约束力的投票。

令 YES 总权重 Y、NO 总权重 N、Q=Y+N。默认的包含边界版本使用：

```text
grant_pass = Q > 0 AND Q >= 3*B AND 100*Y >= 51*Q
meta_pass  = Q > 0 AND Q >= 185000000*10^8 AND 100*Y >= 67*Q
```

严格大于版本只改变最后的比较符号，不改变显示四舍五入。67% 不等于 2/3，51% 不等于严格超过 50%。禁止先格式化百分比再判断。

## 5. 选票与签名

一份 `ballot_body` 对应一个存款 owner lock。直接票或代理票都采用这个粒度；网页可一次操作为多个 owner 生成多份明确选票。直接票示例：

```json
{
  "message_kind": "ballot",
  "action": "YES",
  "authority": "owner",
  "authorization_id": null,
  "signer_key_id": null,
  "nonce": "0x<32-byte random nonce>",
  "anchor_block_hash": "0x<32 bytes>",
  "auth_adapter": "ckb-secp256k1-message-v1",
  "dao_namespace": "ckb-community-fund-dao",
  "network_genesis_hash": "0x<32-byte genesis hash>",
  "owner_lock": {"code_hash": "0x<32 bytes>", "hash_type": "type", "args": "0x<args>"},
  "poll_id": "0x<32 bytes>",
  "protocol_version": "2",
  "rules_hash": "0x<32 bytes>",
  "signature_format": "omavote-readable-v2"
}
```

代理票使用 `authority="delegate"`，填写确切 GRANT 的 authorization_id 与其 descriptor 的 signer_key_id；auth_adapter 改为该 key 的已认可验签 adapter。owner_lock 始终是存款主体，不能换成热密钥地址。直接票要求两个 ID 均为 null。nonce 为新签时生成的 32 字节随机值，重试原票不得改变 nonce。`anchor_block_hash` 是签名时选定的已知规范链祖先，决定改票先后（§6）；重试原票同样不得改变它。

以上是字段示意，不是可直接签名的有效 JSON 向量。`message_kind` 固定为 `ballot`，必须与载体 kind 和 API 分流一致。`ballot_body` 继续用 JCS 编码和计算 ballot_id；**默认消息签名路径实际签署下面的可读文本**。全文由已验证 manifest 与 body 确定性生成。标题、金额和收款方进入实际签名原文，不能只由网页显示。可选 WebAuthn 路径的区别见下文及 11。

```text
<首行摘要>
OMAVOTE V2 - VOTE ONLY, NO ASSET TRANSFER

Format: omavote-readable-v2
DAO: <dao_namespace>
Network-Genesis: <network_genesis_hash>
Proposal: <poll_id>
Title: <manifest.signing_title>
Budget-CKB: <exact decimal CKB or none>
Recipient: <full CKB address or none>
Choice: <YES (Approve) | NO (Reject) | CANCEL (Withdraw vote)>
Owner: <full CKB address for owner_lock>
Authority: <OWNER (Direct) | DELEGATE (Voting key)>
Authorization: <authorization_id or none>
Signer-Key: <signer_key_id or none>
Anchor-Block: <anchor_block_hash>
Clock: ckb-parent-mtp-v1
End-Chain-Time-UTC: <YYYY-MM-DDTHH:mm:ss.SSSZ>
Rules-Hash: <rules_hash>
Ballot-Hash: <ballot_id>
```

这是带占位符的布局，不能直接签名。`Ballot-Hash` 承诺完整 body（包括 auth_adapter 与完整 owner_lock），不存在循环：ballot_id 只由 body 计算，body 不含签名或挑战文本。这样可读字段与完整机器字段同时被签名绑定。

`omavote-readable-v2` 的编码规则如下：

1. UTF-8，无 BOM；行序与大小写固定，字段名后恰为 `: `；第一行为摘要（规则 7），第二行为固定标题，其后恰一空行，其余无空行；行尾只用 LF，最后一行末尾无换行。不接受 CRLF、额外字段、前后空白或签后自动归一化。钱包加上的原生消息域由 adapter 处理，不属于这里的原文。
2. `signing_title` 在提案创建时由提案人确认，1–80 个 Unicode 标量值，无首尾空白；禁止 U+0000–001F、U+007F–009F、U+2028/U+2029、U+061C、U+200E/U+200F、U+202A–202E、U+2066–2069。完整标题太长时明确确认短标题，同时展示完整标题；签名时不能临时截断、翻译或替换字符。`dao_namespace` 首版固定为 `ckb-community-fund-dao`。
3. Budget 从 manifest 的 shannon 整数精确除以 10^8：整数部分无前导零，小数最多八位、去尾零，不用千分位、指数或本地化格式。例如 `100000000000000` 渲染为 `1000000`；`100000001` 为 `1.00000001`。元规则提案的 Budget 与 Recipient 固定为 `none`，预算字段为零、recipient 为 null；其余提案使用冻结预算和收款 script。
4. 地址按固定网络注册表，从完整 script 生成 RFC 0021 full bech32m 小写地址，不使用短地址或页面省略显示。网络注册表随协议版本固定；链标识仍用完整 genesis hash。Choice 按上面三个固定字面量映射；authority 的 owner/delegate 分别渲染为 `OWNER (Direct)` / `DELEGATE (Voting key)`，null ID 为 `none`；哈希（含 Anchor-Block）用规范小写十六进制。
5. Clock 首版只接受 `ckb-parent-mtp-v1`。End 从 manifest 的 end_ms 以 UTC 毫秒精度渲染，固定四位年（范围 0001–9999）、三位小数和 Z。它表示链时钟阈值，**不是对真实 UTC 截止时刻的保证**。网页另显示随链况更新的预计时间；预估票权与变化中的倒计时不进入签名。
6. 前端和每套 verifier 独立验证 manifest 的 poll_id、body 的网络/规则/格式匹配，重新生成完整挑战，再对这些确切字节验签。envelope 包含 body、签名和 adapter 需要的 proof；如携带原文，必须与重建文本逐字节相同。不得验一份 JSON、却信任另一份未经绑定的可读说明。
7. 首行摘要只用可打印 ASCII（0x20–0x7E），不超过 60 字节：`OMAVOTE VOTE <YES|NO|CANCEL> #<poll_id 去掉 0x 后的前 16 位> <预算摘要>`。预算摘要为 Budget 的整数部分加 `CKB`（例如 `1000000CKB`），元规则提案为 `META-RULE`。研究固定版本的 Ledger Nervos app 签消息时只显示前 61 字节（之后为 `...`），换行和非 ASCII 字符都显示为 `*`；摘要因此必须单独承载选项、提案编号和预算。前端在提案页显著显示同一个 `#` 编号。16 位十六进制（64 位）只是辅助标识：伪造同前缀的提案约需 2^64 次哈希运算，代价很高，但不等同完整哈希核对。设备上看不到 Owner、网络、标题、收款地址、规则 hash、授权与签名 key 和锚点，这些只能在电脑端核对全文；真机验收仍须完成。

默认消息签名适配器使用上述可读挑战，包装到各自已审查的消息签名域。旧稿 V1 的 JSON 或可读票面格式均不得作为兼容分支自动通过。钱包应能核对标题、预算、收款地址与选择，不能为绕过设备长度限制而删掉字段或改签裸摘要。可选 `webauthn-es256-v2` 则使用 11 规定的 body 承诺作为 WebAuthn challenge，ballot 的 signature_format 固定为 `omavote-webauthn-v2`；前端必须重建并展示同等内容，但不能声称认证器弹窗展示了提案和选择。这是需单独验收的客户端信任边界，不是消息钱包的静默降级路径。跨语言渲染向量、真实钱包显示和长度上限列为 P1 退出门槛；本次文档修订未实现这些编码器。

同地址多个 deposit 自动汇总；不同 owner 分别签授权或直接票。授权有效时，主流程由已连接的在线钱包为多个已授权 owner 各签一张具体提案的票，无需每个提案重复打开 Neuron。网页可以合并引导，实际钱包弹窗次数按 adapter 验收公布。代理票须先按各 owner 验证历史授权；详见 [授权规范](11-authorization.md)。本地地址清单依然不构成授权，旧 Metaforo 绑定也不能直接导入为 grant。若实测多地址弹窗负担过重，“同一 key 一次签名覆盖多个 owner”可作为将来新增的 signature_format，由提案的冻结格式列表启用，不改变本格式。

### 5.1 首选授权 Adapter

**CKB secp256k1 单签**：按当前 Neuron 消息方案对 `Nervos Message:` 前缀后的原文哈希验签，从可恢复签名恢复公钥，压缩公钥经 CKB blake160 后必须精确匹配已认可单签 script 的 args。还要检查 `code_hash` 和 `hash_type`，不能只比 args。对大小写、恢复位、签名长度、low-s 规范和异常输入提供跨语言向量。[Neuron 实现](https://github.com/nervosnetwork/neuron/blob/a926e3383d3a3e305b3bde7d233474515ef01a2e/packages/neuron-wallet/src/services/sign-message.ts)

Neuron 代码仍包含旧签名兼容验证路径；新投票协议不自动接纳这些旧格式。历史 Metaforo 地址绑定签名无本提案域、无选项、无修订先后，绝不能被转换成一张新选票。

**EVM 消息签名**：使用确定版本的 `personal_sign`/EIP-191，对完全相同的 UTF-8 挑战恢复 EOA；再按本网络指定的 Omnilock 普通 EVM 模式或 PW Lock 规则匹配完整 script。Omnilock 普通 EVM 模式指 args 恰为 22 字节 `auth_flag ‖ eth_address ‖ 0x00`：auth flag 取 `0x01`（Ethereum）或 `0x12`（Ethereum-displaying），flags 字节必须为 `0x00`。两种 auth flag 由同一个以太坊私钥控制，差别只在 lock 验交易时显示的消息；CCC 的 EVM 签名器给新地址默认使用 `0x12`。PW Lock 的 args 恰为 20 字节地址。合约账户、EIP-1271、带 admin list、ACP、time-lock 或 supply 模式的 Omnilock，不因返回一个 EVM 地址就自动支持。将来采用 EIP-712 必须是独立 adapter，固定 domain 与字段，不能静默切换验签模式。[EIP-191](https://eips.ethereum.org/EIPS/eip-191)、[EIP-712](https://eips.ethereum.org/EIPS/eip-712)

**JoyID**：消息签名验真之外，还需验证公钥、key type、主/子密钥、授权状态与 CKB lock 的对应关系；WebAuthn challenge、origin/RP 约束不可省略。需要外部授权状态的模式须固定到收录时的历史状态，不能审计时查询今天的远程接口。未完成者标明未支持，而非“CCC 能连接就算可投”。[CCC JoyID 验签入口](https://github.com/ckb-devrel/ccc/blob/722cfe28bb184145e14887d54162d55fbe3dcadb/packages/core/src/signer/ckb/verifyJoyId.ts)

**多签与其他锁**：按原始多签配置、阈值、必签成员、锁定条件核对。单个成员的签名不代表该多签主体。任意 lock 的通用离线消息授权不是首版承诺的能力。

**Adapter ID、控制格式集合与提案选票清单。** V2 的 adapter 以版本化 ID 标识。一个 ID 发布后，其签名域、恢复与匹配规则、网络参数都不可修改；修复或新增只能使用新 ID。owner adapter 用于直接票、提案签名与授权控制；key adapter 用于代理票和流程密钥。首版冻结的 ID：

| Adapter ID | 角色 | 规则 | 首版状态 |
|---|---|---|---|
| `ckb-secp256k1-message-v1` | owner、key | 上文 CKB secp256k1 单签规则；owner 角色匹配标准 secp256k1_blake160 lock 的完整 script，key 角色匹配 descriptor 公钥 | owner：首版必需（Neuron）；key：可选 |
| `evm-personal-message-v1` | owner、key | 上文 EIP-191 规则；owner 角色匹配本网络 Omnilock 普通 EVM 模式或 PW Lock 的完整 script，key 角色匹配 descriptor 地址 | key：首个在线钱包 PoC 目标（MetaMask 类 EOA）；owner：优先 |
| `webauthn-es256-v2` | key | [11 §4.1](11-authorization.md) | 独立 PoC |

JoyID、多签和其他 lock 须各自定义新 ID 并通过验收，才能列入提案。

**控制格式集合**是可签授权控制消息（GRANT/REVOKE）的 owner adapter，全局适用、只增不减。首版为 `ckb-secp256k1-message-v1` 与 `evm-personal-message-v1`。新增格式属于规范升级，须写明开始生效的区块高度，且该高度晚于规范发布时的链高度，不能追溯改变已有结果。授权控制一律按此集合处理，不受各提案清单影响（[11 §5](11-authorization.md)）。

每个提案的 `auth_registry` 从已定义的 ID 中列出本提案接受的选票格式，并被 poll_id 固定：不得中途撤掉某一方正在使用的 adapter，也不得上线一个新解释让旧票产生不同归属。接入新钱包（新的 key adapter）只需让后续提案列入新 ID，已有授权不受影响。发现某 adapter 可被伪造时，后续提案不再列入，即可排除用它签署的选票，以及以它签署的 grant 为依据的代理票；收窄清单只会少计票，不会让已撤销的授权复活。仍接受该 adapter 的提案（包括发现漏洞前已开票的）可能计入伪造票，委员会应发布 HOLD_EXECUTION 并按治理流程处置；控制格式本身被攻破时的停用规则另行设计。列表只描述密码学/脚本能力，不列允许投票的人；技术不支持某 lock 仍然会影响持有人准入，必须披露覆盖范围与替代入口，不能用“不是人员白名单”掩盖影响。

### 5.2 可选的交易授权通道

用户签署一笔含规范 ballot body 承诺的普通 CKB 交易；审计器检查该交易 input 的脚本确实以认可的 owner 授权路径认证了该承诺。仅对经过逐个审查的 locks 开启；ACP、管理员模式、委托执行、宽松 sighash 等必须分别分析。应将 body 或其 hash 放入被签名覆盖的 outputs_data，不能假设所有锁都认证相同 witness 范围。

C 的 proof 是交易中的真实授权，不冒充 §5 的消息签名；使用单独的交易 auth_adapter，沿用同一规范 body 和展示语义。完整 body 必须可从该交易历史载荷取得，不能只放 hash 而把 body 留在后台。交易钱包对用途和选择的显示能力须另行验收。

交易只能选普通资金 cell，不选择 DAO、xUDT、Spore、通道资产或其他有 type 的资产。找零回用户原脚本；费率与总费用上限在用户签名前核对。C 直接票使用 authority=owner，与 B 直接消息票共用 owner_id、直接票的锚点排序、ballot_id 与去重规则；它不从 input 推导代理 key 的授权。交易型 GRANT/REVOKE 需独立审查 adapter 后开放，不能套用投票模板自动接受。

C 的首版候选交易模板进一步限定：全部输入为同一个 owner_lock 控制的普通 cell；投票载体和全部找零也回该 lock；只有一个选票承诺。此自付模板仅作研究和高级手动发布候选，不满足用户免费产品要求，不能作为首版已支持钱包入口。C 进入产品支持范围前必须单独完成费用与容量赞助方案的安全验收，不能签后补入 fee input。需要复杂共同出资时另设计 adapter；B 的“任何人代发已签 envelope”不受此限制，因为它不从付款输入推断选民。单 lock 模板只是减少误操作与混合输入风险，不能代替逐 lock 的授权与承诺覆盖验证。

## 6. 修改、撤回与重放

[授权规范 §5–6](11-authorization.md) 定义完整选择算法。本节给出共同约束：

1. 对每次出现先核验消息、proof、owner/key 关联、完整 `[start_ms,end_ms)` 时窗、收录时资格与历史授权，再去重。YES/NO 要求存款 owner 在该交易处理后的状态具有正 active deposit；不要求代理 key 有资产。CANCEL 可在零余额提交。无效出现不能占据 ballot_id，也不参与排序。
2. 相同 ballot_id 的重复有效出现取最早有效位置；重试重发原 body，不因签名编码或发布者改变产生新修订。
3. 直接票序列为 `(poll_id,owner_id,owner)`；代理票序列为 `(poll_id,owner_id,authorization_id)`。每张票签入一个已知规范链祖先 `anchor_block_hash`，收录时它必须仍在规范链上且是收录块的祖先，否则为 `ANCHOR_INVALID`。同一序列内只按选票锚点高度比较新旧，选票不设序号；锚点相同而内容不同的票互为冲突。授权控制同样按锚点排序（[11 §5](11-authorization.md)），与选票序列相互独立。
4. 有有效直接票时，选直接层锚点最高者；最高锚点上有不同 body 为 CONFLICT。直接票、直接 CANCEL 或直接冲突均阻止回退到代理层；该提案由 owner 接管，其他提案不受影响。
5. 没有直接票时，按各 owner 保留收录时具有效授权的代理票，应用安全撤回屏障，再按 `(grant 锚点高度, 选票锚点高度)` 取最大；最大组合上有不同 body 为 CONFLICT。不能先挑 key 的全局最新票，再检查它能代表哪些 owner。
6. CANCEL 不计双方与 quorum。自然到期和仅停止新票的撤销保留此前有效票；安全撤销清除尚未结束提案中该 owner 的先前代理票，且不复活更老票。截止后撤销不追溯更改该提案。

CONFLICT 暂不计该 owner，用户签一张锚点更新的新票即可恢复；直接接管还能绕过恶意 key 的代理序列。相同选择但不同 body 仍冲突，避免未经定义的等价合并。客户端保存待发 body，跨设备提示已收录/待发差别。

锚点一律取签名时已验证的最新块，同一序列两次签名之间须等出新块。由此：签名所在块高于被扣票锚点的改票必然胜出，最新改票或撤回可以单独交给任何发布者，不需要先发布已放弃的中间版本；同一块内签出的两张不同票为冲突，不会被静默覆盖。选票不设序号，正是为了不让被扣住的早签票靠签名者填写的大数字反超。节点落后时上述保证不成立，客户端须做同步检查并在收录后核对（[11 §5–6](11-authorization.md)）。没有后台重置。

只在零余额时发布过 YES，后来才存款，不会使那次无效出现自动变有效；可在满足资格且仍在窗口内重发原票或签新票。已具有有效票的同一 owner 后续增加存款则影响截止权重，不需要因增加金额重签。

## 7. 链上载体与数据可用性

建议 `CarrierHeader` 使用固定二进制格式：

```text
magic[8]       = "OMAVOTE\0"
kind[u8]       = 1 manifest | 2 ballot_batch | 3 result_record | 4 authorization_policy | 5 authorization_batch | 6 process_roles | 7 process_batch
version[u8]    = 2
scope_id[32]
payload_hash[32]
witness_index[u32 little endian]
```

共 78 字节，放在普通 cell 的 data 中。kind 1–3 的 scope_id 为 poll_id；授权两种 kind 的 scope_id 为 auth_policy_hash；kind 6 为该角色配置的 roles_hash；kind 7 为记录的 poll_id，ROLES_UPDATE 则为其 new_roles_hash。授权批次只含相同 policy 的完整控制信封，不能用 poll_id=0 混淆解析；policy 载荷包含完整 policy 对象。`payload_bytes` 是完整 JCS 对象的 UTF-8 字节；`payload_hash = H("OMAVOTE/PAYLOAD/V2\0" || kind[u8] || payload_bytes)`，承诺指定 witness 的全部内容。ballot_batch 与 authorization_batch 均为 `{"protocol_version":"2","envelopes":[{"body":...,"proof":...},...]}`，process_batch 的信封为 §3.1 的 `{"body":...,"proofs":[...]}`；条数由数组长度确定，不另存可矛盾的 count。ballot_batch 全部属于同一 poll，authorization_batch 全部属于同一 policy，process_batch 全部属于同一 scope；body 的 message_kind 必须匹配。manifest 载荷见 §3.1；其余 kind 分别承载完整 result record、policy 或角色配置对象，按各自 schema 解码。kind 3 的结果记录任何人都可发布，不具权威；委员会确认用 kind 7 的 RESULT_ATTESTATION。不得只放 IPFS CID、签名 hash 或 Merkle root，而把原始选票留在运营者数据库。

验证器先校验 frame 长度、版本、hash、重复字段，再逐票验签。无法解析的整批明确记为拒绝；一张可独立定位的无效票不拖累同批其他有效票。任何人可创建载体，载体的 lock、付款者和官方服务签名均不赋予它额外投票权威。官方结果声明是 §3.1 的 RESULT_ATTESTATION 记录，须达到委员会阈值；付到官方地址不是认证。结果记录不决定有效票集合。

Witness 不占用后续 live-cell 的存储容量，但占交易字节、网络带宽、历史存储且产生手续费。78 字节头若使用标准 20 字节 args 单签 lock、无 type，理论 occupied capacity 为 `61 + 78 = 139 CKB`。这是中继可回收的周转容量示意，不是每张票烧掉 139 CKB；实际以生成交易的 capacity 校验和费率为准。多批次可以重复使用周转资金，多组 UTXO 避免所有中继争抢同一输入。[容量字段与交易格式](https://github.com/nervosnetwork/rfcs/blob/62a6e08e16a995ab94562581978ceac3726c31e6/rfcs/0022-transaction-structure/0022-transaction-structure.md)

初始建议单个载荷 witness 的完整序列化字节数最大 32 KiB（包含批次 framing）、单 envelope 最大 8 KiB、条数最大 128，同时满足才可发布。研究版本的标准 secp lock 对其处理的每份 witness 有 32,768 字节上限，因此不能先装满 32 KiB 选票再加封装。短 manifest 也遵守这个载荷上限；过大的正文与附件使用已承诺的镜像，不能临时发明未定义的分片解码。参数仍需钱包、节点策略与费用实测；投票开始后不能调整解析上限。[标准 lock 的 witness 限制](https://github.com/nervosnetwork/ckb-system-scripts/blob/72eb92fca090700dcb398cd8cad8fbd8bad40355/c/secp256k1_blake160_sighash_all.c#L60)

引用的 payload witness 建议放在全部 input 对应 witnesses 之后，和赞助者的 lock witness 分开。所有使用的资金 lock 均需确认对额外 witness 的处理和大小限制，不能以标准 secp 的结论推断其他 lock。拒绝解压炸弹、递归 JSON、超长签名和无限嵌套；首版不做可任意扩展的压缩格式。

中继可在 payload 上链后回收载体 cell。审计器必须读取历史交易，不能只搜索当前 live carriers。服务端只公布“链上 root”而不提供其对应 bytes，不达到本方案要求。

首版默认 carrier 不增加 type script。格式 marker 有利于按脚本索引，保留为 P1 可测的替代布局，见 [分支 §3.4](06-alternatives.md)。若采用，必须先冻结 code hash、依赖可用性、索引范围与 carrier 版本并审计；marker 仍不判定资格、结果或控制金库。不能把“付到官方地址的载体”当作官方认证，也不能用只查 live markers 的方式遗漏已回收载体。

## 8. 截止时间

签名时间、HTTP 请求时间和中继 receipt 时间不能证明选票已经及时公开。B 路线以**有效载荷在规范链中的实际收录位置**为准。用户在开票前或截止后收录的票均不能作为有效出现；在截止前签名、截止后才上链的票无效；receipt 是服务责任证据，不是改写截止的权限。

建议采用 manifest 固定的 `ckb-parent-mtp-v1`，定义：

```text
clock(b) = CKB 共识参数定义的 parent(b) 的 median block time
eligible_block(b) = start_ms <= clock(b) < end_ms
end_ms = start_ms + 7*24*60*60*1000
H_close = 第一个 clock(b) >= end_ms 的区块的前一区块
```

研究快照的 median window 为 37 个区块；实现读取并固定对应网络与共识版本，不凭猜测硬编码“CKB 永远如此”。此 clock 使用链上历史，可重复计算且不依赖单个运营者时钟。**它是链时间的七天，会与墙上 UTC 时间存在偏差；停链时偏差可能变大。** 显示预计 UTC 截止和链时间状态，不能承诺到某一真实秒绝对结束。[共识参数](https://github.com/nervosnetwork/ckb/blob/2592ddf0502cd4adfe886db893cccc866db3c60f/spec/src/consensus.rs)、[header 时间验证](https://github.com/nervosnetwork/ckb/blob/2592ddf0502cd4adfe886db893cccc866db3c60f/verification/src/header_verifier.rs)

这是正式切换前需要确认的时间政策，不是对既有七天规则的隐含改写。其他可选政策：42 epochs（已有实现可对齐但只是约七天）、预先确定的高度（最简单但真实时长漂移）、可信时间见证的严格 UTC 接收（回到 A 的部分信任）。不能后台视结果选择有利的截止区块。

同一块内按 `(height, tx_index, output_index, envelope_index)` 给出位置。DAO 资格在承载交易处理完成后的状态检查；同一交易的多个载体按 output_index、envelope_index 处理授权与选票，grant 必须先于它授权的票。截止票权采用 H_close 的整块结束状态。因此同一笔交易/区块中新建的 deposit 可按定义参与，同块较晚的提款也会在最终状态排除。有效性检查与所有者签名无关的数据次序不得由 API 返回顺序代替。

## 9. 历史票权重建

严谨模式从可信验证链的 genesis 重放，或从本地先前自行验证过的 checkpoint 继续。checkpoint 同时包含各 owner 当前生效控制的锚点、有效 grant、冲突/撤回屏障、选票状态和流程角色配置；授权可早于开票，不能只扫投票窗口。只索引 DAO type 交易也找不到普通投票/授权载体，必须独立扫描完整载体历史。只为票权保留 DAO 相关状态，也必须扫描全部交易 inputs 才能发现它们被花费：

```text
for block in canonical_chain:
    check parent continuity; use own node's validated canonical view
    for tx in block order:
        for input in tx.inputs:
            remove spent outpoint from tracked DAO cells
        for output in tx.outputs:
            if exact accepted DAO type and exactly 8 zero bytes:
                add (outpoint, full_lock, capacity, creation_position)
        process carriers in (output_index, envelope_index) order
        update valid authorization controls; evaluate owner-specific ballots against that historical state
    freeze or checkpoint state as required
```

需要区分：原始块缺失、读取出错是审计失败；一份已完整解析但验签失败的票是可诊断拒绝。不能因数据服务 500 就把某地址权重设零。

发布的 `dao-snapshot.json` 可以加速，但单凭其 Merkle root 不能验证完整性。轻量用户可以验证自己的入选记录、支持的证明与多个独立结果一致性；这不等于全量审计。完整审计者自行重放，或使用经过审查且公开值绑定充分的历史证明。

只从投票开始扫到结束、却接受后台提供的开票余额，仍信任这个初始余额。若试图只核验声称有权重的地址，也要证明没有漏掉这些地址的 deposit、提款和更晚的选票，不能把“返回列表都有合法 proof”当作“列表完整”。

允许两种经过校验的加速实现：使用自己已验证节点的完整 DAO 历史索引回放；或在已固定的 tip 快照上，逆序撤销 `(H_close, tip]` 的创建与花费。必须覆盖全部相关历史、恢复被花费 cell 的原始内容，并与基准重放交叉比较。分页读取期间 tip/hash 改变、索引未追上该 tip 或发生重组时重试，不能把多页混合状态称为某一高度的快照。第三方公共 indexer 可以加速取数，不能独自证明没有漏项。

## 10. 重组、确认与结果状态

CKB 是 PoW；确认深度降低风险，不提供绝对不可逆保证。规则中固定 `k` 个确认、结果复核窗口和深重组处置，数值应结合链况、金额与节点运维评估。可从 `k=100`、至少 24 小时复核开始压测，但这些是候选运营参数，不能声称已证明足够安全。

推荐状态：

```text
DRAFT → ANNOUNCED → OPEN → CLOSED_UNCONFIRMED
      → AUDITABLE → FINALIZED_BY_POLICY → EXECUTED
                       ↘ DISPUTED / DATA_INCOMPLETE
```

所有索引变更带 block hash 与可回滚 journal；先确认共同祖先，再撤销孤块选票、存款和花费，重新计算 H_close 与结果。receipt 所指交易被重组掉时变回待收录，不能维持“成功”。两台 RPC 对 tip 不一致时显示分歧，不能静默选有利的一台。

结果复核期不允许补投、改票或追溯延长截止。它用于发现漏读、错误验签、错误快照和重组。若已执行之后发生重大重组，无法靠投票软件追回付款；必须由既定治理流程处理。因而执行层应等确认和复核完成。

没有独立可信的完整结果时，停留在 `DATA_INCOMPLETE` 或 `DISPUTED`，不得把上一日锚定、某台服务器最后缓存或部分可得选票作为正常最终结果。B 不以运营者“收尾锚定是否按时发布”决定有效选票集合；该集合由截止前的规范链历史确定。诊断性部分统计必须标明范围，并禁止显示正式通过或作为付款依据。

## 11. 可导出的结果证据

结果包至少包含：

* manifest、正文/附件 hash、rules_profile、adapter registry 和所有版本 hash。
* genesis、开始和截止边界区块 hash、确认 tip、取数范围、完整/增量重放模式。
* 每张原始 signed envelope、链上位置、ballot_id、验签与有效性状态、具体拒绝理由。
* 完整授权 policy、控制消息和 owner proof、每份票引用的 grant、控制与票的有效位置、过期/冲突/撤回屏障。
* 每个 owner 的最终选择、authority、grant（authorization_id 与锚点高度）、选票锚点高度、冲突/撤回情况。
* 验证时所用的初始 `roles_hash` 与角色更新链，以及所依据的规范修订（含控制格式集合）。
* 与该 poll 相关的流程记录及其验证状态：准入、提示、治理处置、结果确认与执行。
* 每份纳入本金的 DAO outpoint、capacity、lock、创建位置与截止状态证据。
* YES、NO、quorum、整数阈值比较、最终判定及规范化结果 hash。
* 验证器版本、构建 hash、执行参数、数据缺失和重组记录。

“自己的票在某个批次里”的 proof 仅证明 inclusion；“本提案所有票按规则都算了”需要全量重放。UI 分开显示这两种验证。推荐标准化 `INVALID_SIGNATURE`、`WRONG_OWNER`、`OUT_OF_WINDOW`、`ANCHOR_INVALID`、`ADAPTER_NOT_ACCEPTED`、`LATE_MANIFEST`、`RECORD_CONFLICT`、`NO_DEPOSIT_AT_CAST`、`SUPERSEDED`、`DUPLICATE`、`CANCELLED`、`CONFLICT`、`ZERO_FINAL_WEIGHT` 等诊断码。

定义 `result_core` 为规范对象：协议/网络/poll/rules/auth_policy/auth_registry 标识、开始与截止边界 block hash、按 owner_id 排序的 owner 行、按 outpoint 排序的计权明细，以及 YES/NO/quorum 的整数数值、阈值比较与计算结论。owner 集合恰为该提案中至少有一次有效选票出现的主体，包括后来撤回、冲突或最终零权重者；仅授权未投票者不加入，未知身份也不能产生 owner 行。

每个 owner 行包含最终状态、有效 ballot_id 或 null、authorization_id 或 null、`eligible_principal_shannon` 与 `counted_weight_shannon`。两种金额分开，避免把冲突或撤回者仍存在的本金误当成参与权重。冲突为 CONFLICT、两种 ID 均为 null；选中的 CANCEL 保留该票 ID，计入权重为零；全部代理票被屏障排除时为 CANCELLED_BY_CONTROL、两种 ID 均为 null。其余选中的 YES/NO 保留 action 和 ID，即使最终本金为零也不丢失选择；ZERO_FINAL_WEIGHT 是附加诊断。仅实际计入 YES/NO 的 outpoint 进入计权明细，按 tx_hash 原始字节、index 数值依次排序，不能重复。`result_hash = H("OMAVOTE/RESULT/V2\0" || JCS(result_core))`。

result_core 不包含运行时间、确认 tip、验证器版本、镜像 URL、服务回执、额外诊断或治理标记；这些留在完整证据包。相同截止链历史和规范须得到相同 result_core，不要求不同语言/构建生成逐字节相同的证据包。当前草案仍需实现机器 schema 和跨语言向量，不能仅靠描述声称实现一致。

浏览器可以检查自身票的收录、下载材料和支持的验签/重算，但必须标明是否验证了完整历史。服务端提供的列表全部验真不证明没有漏项；两个 RPC 一致、N 个确认地址或上链结果 hash 都不替代完整性和独立实现。前端代码本身是用户必须核对的信任边界。治理状态单列，管理员 invalid 标记不覆盖 result_core 的数学结论。

任何人可以发布结果记录，多个结果不一致时用户可逐票 diff。投票工具的“正式结果”只接受规则规定的复核流程；运营者不能删去冲突记录，然后只保留自己喜欢的那个数字。

## 12. 中继协议与独立出口

首版公开只读 API：`GET /proposals`、`GET /proposals/{id}`、`GET /owners/{owner_id}/power?block_hash=`、`GET /ballots?...`、`GET /receipts/{id}`、`GET /results/{id}/bundle`、`GET /status` 和 `GET /feed.atom`；写入选票/授权控制用 `POST /envelopes`，按 message_kind 分流。增加 `GET /owners/{owner_id}/authorizations?policy_hash=&at_block_hash=` 与按 ID 获取完整控制历史的接口；返回有效位置、期限、冲突、撤销和恢复进度。增加 `GET /keys/{key_id}/authorizations?policy_hash=&at_block_hash=`，供在线钱包重连后找回它代表的 owner；`GET /owners/{owner_id}/feed.atom`，公开提示该 owner 的新选票与授权变化（11 §4.2）；`GET /proposals/{id}/records`，返回流程记录及其验证状态。提案创建页面生成、检查并发布签名 manifest，不给后台编辑已开票 manifest 的接口。所有余额响应带计算高度与 hash，所有分页使用稳定 cursor 并承诺范围，所有响应是缓存视图而非协议事实。

列表与导出包含被覆盖、撤回、冲突及被拒绝的记录和原因；分页固定查询范围、快照锚点和排序规则。status 提供索引 tip/hash、中继队列及可用性；feed 只提供公开提案与公开链上记录的通知，不需要订阅者身份。第三方仪表盘无需特权 token 读取公开数据，可作资源限流，但不能替代独立链扫描。通知、论坛回帖与 API 暂时不可用均不改变投票窗口和资格。

`POST /envelopes` 以 `(message_kind, ballot_id 或 authorization_id)` 幂等；收到的 proof 须独立校验，无效提交不能占据 ID 阻止后来的有效提交。receipt 由中继签名，包含消息 kind/ID、收到的 payload hash、接受时间、中继身份、计划发布时限与状态。状态至少区分 `RECEIVED`、`BROADCAST`、`INCLUDED`、`CONFIRMED`，未上链时不显示“投票完成”或“授权已生效”。

任何 helper 都可发布相同 envelope；不绑定指定中继、其 IP、其 fee payer 或其载体 lock。客户端允许下载 envelope、切换中继、自建 relay，或交给帮助者用其自身普通 CKB 代付承载。已支持用户的授权、投票、改票、撤回和恢复必须免费，费用与 carrier 容量由发布方承担，不能要求存款 owner 或投票 key 准备零钱。协议仍不限制外部发布者自愿用自己的资金发交易；这项开放能力不是要求投票用户付费的产品入口。

中继对代理票核对被代表 owner 的资格，不以 key 自己的余额作资格；对 GRANT/REVOKE、恢复消息和零余额撤回分类处理。最新改票可以单独提交，中继不得以缺少中间版本为由拒收或延后。默认中继可按单个 owner 的有效更新频率、总批次成本和全局预算限流，但限流是赞助服务政策，不是剥夺投票资格。合资格用户应通过免费队列和备用赞助入口提交；预算不足时明确显示待发布/服务不可用，不以收费替代免费路径。遇到流量攻击不能临时更改共识有效票的定义。匿名免费提交的成本难以完全防 Sybil，需要公开的补贴上限和运营应急预算。

零余额 CANCEL 的协议许可不意味着无条件赞助任意新 key。中继可只免费处理已有有效票主体的撤回，或合资格主体的常规更新；对同一 envelope 合并请求，对每个 owner 公平排队。该政策不能按 YES/NO、昵称或政治观点区别对待。验证器仍必须接受所有符合协议且及时上链的票，不按付款者或赞助额度改变票效力。运营方须为合资格用户配置免费正常与恢复预算，不能把公开协议允许自愿出资理解成产品可以向选民收费。

若所有中继都停机，没有流动 CKB、没有帮助者且只能手工签消息的用户确实仍可能无法及时提交。文档应承认这一边界，并在上线前提供可用的社区镜像和真实恢复演练。命令行理论上能做到而产品未交付，不算已完成旁路。
