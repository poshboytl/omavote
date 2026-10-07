# 期限型投票授权：协议与恢复草案 v0.3

本文件与 [03：主协议](03-protocol.md) 共同构成当前评审规范。用户已确定首版支持一次授权、多次投票；默认一年（365 链日）、最长一年。下面把此前只在对话中的选择落实为可审查的状态机；尚未实现或通过密码学、钱包及链上互操作测试。第二轮评审及两次同事复核后的修订（[09 §9–11](09-design-update.md)）把授权控制与选票都改为只按签入的锚点排序、选票不设序号，把 adapter 移出 policy、控制消息改按全局控制格式集合处理，允许 GRANT 一步撤回旧代理票，并为签名文本加入首行摘要与目标钱包地址。

## 1. 范围与身份

授权仅允许为指定 DAO 的提案签署 YES/NO/CANCEL，不允许转账、发起提案、签发治理声明、修改授权或转授权。不产生票权；权重仍来自 owner 的 Nervos DAO 存款。协议无法判断密钥是否由“本人”保管，不以这个称呼消除实际委托能力。

* `owner_id`：完整存款 lock 的 script hash，是计权主体。
* `key_id`：`H("OMAVOTE/KEY/V2\0" || JCS(key_descriptor))`，是投票签名密钥标识，不强行映射成 CKB lock。
* `authorization_id`：`H("OMAVOTE/AUTHORIZATION/V2\0" || JCS(control_body))`，不包含 proof。
* `auth_policy_hash`：`H("OMAVOTE/AUTH-POLICY/V2\0" || JCS(auth_policy))`，只承诺授权语义：时钟、期限上限、发布期限、排序/冲突/撤销规则版本；不包含 adapter 列表或 UI 默认值。
* 授权控制流：每个 `(genesis, dao_namespace, auth_policy_hash, owner_id)` 一条。控制消息按其签入的锚点块高度排序（§5），没有由签名者填写、可被一次签满的控制序号。新增或停用 adapter 不改变 policy hash，已有授权继续有效；只有授权语义本身改变时才不继承旧授权，须明确迁移与重新授权。

一份控制消息只对应一个 owner；A、B 可分别授权同一在线钱包保管的 key。日常界面为 A、B 分别准备选票，由该钱包签署并一起提交，不要求用户反复打开 Neuron。钱包 adapter 是否能减少弹窗另行验收，不把一个私钥推断成它未明确获授权的所有地址。

每个 owner 同时只有一个当前可用于新投票的 grant。不同 owner 的期限、撤销和最终选择分别处理。key 自己有 DAO 存款时，也必须为自己的 owner 生成独立选票，不能隐式累加。

## 2. Policy 与链时间期限

完整 `auth_policy` 必须在控制消息之前的位置通过普通载体公开，不能只存 hash；manifest 同时包含已完整发布的相同对象。其固定字段只有：协议版本、完整 genesis、DAO、`clock=ckb-parent-mtp-v1`、最大期限、控制消息发布期限、本文件定义的排序/冲突/撤销语义版本。相同 policy 重复发布不赋予任何人额外权限。

owner adapter 与 key adapter 不进入 policy。它们是 [03 §5.1](03-protocol.md) 逐版本冻结的 adapter ID：一个 ID 发布后语义不可修改，修复或新增只能使用新 ID。授权控制消息按全局、只增不减的控制格式集合验证（§5）；每个提案的 `auth_registry` 只决定本提案接受哪些选票（§6），不能临时扩大解释，也不能改变控制历史。接入新钱包只需让后续提案列入新 ID，不要求任何 owner 重新授权。UI 默认值不允许服务器改变已签有效期。

首版界面预设为下列三个选项；默认值与预设不属于 auth_policy 或 rules_profile，不参与这两个对象的 hash。用户实际选择的绝对 expires_at_ms 仍必须签入控制消息，改变界面默认不能延长任何已有授权：

```text
ui_default_term_days = 365
ui_presets_days = 30 / 90 / 365
```

协议上限与发布期限为：

```text
max_term_ms = 365 * 24 * 60 * 60 * 1000
max_control_publication_delay_ms = 24 * 60 * 60 * 1000
```

“一年”在协议中固定为 365 个链时间日，不按闰年或客户端时区改变。一天为 86,400,000 ms；使用主协议的父块 MTP，不把 180 epochs 宣称为精确 30 个自然日。页面显示期限和预计 UTC 日期，并说明停链等情况会使真实日期漂移。

每份控制消息签入一个已知规范链祖先 `anchor_block_hash`。令 `T_anchor=clock(anchor_block)`，`anchor_height` 为该块在规范链上的高度；`anchor_height` 同时决定控制消息的先后（§5）：

* `GRANT` 包含 `expires_at_ms`；要求 `0 < expires_at_ms - T_anchor <= max_term_ms`。默认由该锚点加 365 链日生成，可选 30 或 90 链日；有效区间上界不含等号。
* `publication_deadline_ms = T_anchor + max_control_publication_delay_ms`，该值也签入；首次有效收录必须位于锚点之后，且 `T_anchor <= clock(inclusion) < publication_deadline_ms`。
* GRANT 还要求收录时 `clock(inclusion) < expires_at_ms`。有效期从锚点计算，实际可行权只能从有效收录之后开始；延迟发布不会把期限向后延长。
* REVOKE 使用相同的锚点/发布期限要求，`expires_at_ms=null`。过期未发布需重新准备控制消息，不能只改收到时间。锚点被重组移出规范链时重新校验；原消息不满足条件即不参与排序。
* 客户端签任何控制消息时，锚点一律取签名时已验证的最新块，并须高于它已知的该 owner 任何控制消息（必要时等待下一个块）。不允许为减少孤块而取 tip 之前的块：那样后签的消息可能输给被扣住的早签消息。锚点偶尔因孤块失效，由客户端检测后重签；同步检查与收录后核对见 §5。

不使用签名者自报的 Issued 推断链上 epoch。用户签名、网站接收、磁盘缓存都不能代替控制消息收录。

## 3. 控制消息、权限与文本

`control_body` 的必需字段如下；具体值遵守主协议的 JCS、整数字符串和大小写规则。

| 字段 | 语义 |
|---|---|
| `protocol_version`, `message_kind` | 固定 `"2"`, `"authorization_control"` |
| `network_genesis_hash`, `dao_namespace`, `auth_policy_hash` | 完整域隔离 |
| `owner_lock`, `owner_auth_adapter` | 谁管理哪份存款授权；adapter 为 03 §5.1 的 owner adapter ID |
| `action` | `GRANT` 或 `REVOKE` |
| `key_descriptor` | GRANT 必填；REVOKE 为 null |
| `expires_at_ms` | GRANT 的绝对链时间阈值；REVOKE 为 null |
| `revoke_mode` | GRANT 为 null（保留旧 key 已投的票）或 `STOP_AND_CANCEL_OPEN`（换 key 的同时撤回旧代理票）；REVOKE 为 `STOP_ONLY` 或 `STOP_AND_CANCEL_OPEN` |
| `anchor_block_hash`, `publication_deadline_ms` | 签名绑定的锚点（同时决定排序）和首次发布期限 |
| `nonce` | 32 字节随机值；重试保留原值，不能对同一锚点重建另一份 body |
| `signature_format` | 固定 `omavote-authorization-v2` |

控制消息只能由 owner 的完整 lock adapter 授权，不接受投票 key 的控制签名。GRANT/REVOKE 不要求此刻有正余额，以便预先设置与在提款后撤销；免费赞助政策另定义，不能改变协议效力。控制消息直接签名通道先覆盖已验收的 owner 消息 adapters。C 交易控制通道只有独立完成授权用途、全文承诺及签名覆盖验收后才开放；不把未知 lock 交给通用 BIND 自动放行。

钱包签署下面的确定性文本，不签裸摘要。第一行是摘要，第二行是固定标题，其后恰一空行；字段行必须全部出现，null 渲染为 `none`。通用字节规则沿用主协议 §5；UTC 字段以该协议的固定毫秒格式渲染，key 描述用 JCS 单行原文，哈希为完整小写十六进制。Owner 为完整 bech32m 地址，Key-Address 为 §4.1 定义的钱包可见地址，Action 与 Revoke-Mode 用上述固定大写枚举。

```text
<首行摘要>
OMAVOTE V2 - VOTING AUTHORIZATION ONLY, NO ASSET TRANSFER

Format: omavote-authorization-v2
DAO: <dao_namespace>
Network-Genesis: <network_genesis_hash>
Owner: <full owner address>
Action: <GRANT | REVOKE>
Key-Address: <key_display or none>
Key-Descriptor: <JCS(key_descriptor) or none>
Key-ID: <key_id or none>
Expires-Chain-Time-UTC: <expires_at_ms rendered as UTC or none>
Revoke-Mode: <STOP_ONLY | STOP_AND_CANCEL_OPEN | none>
Anchor-Block: <anchor_block_hash>
Publish-Before-Chain-Time-UTC: <publication_deadline_ms rendered as UTC>
Policy-Hash: <auth_policy_hash>
Authorization-Hash: <authorization_id>
```

首行摘要只用可打印 ASCII（0x20–0x7E），不超过 60 字节，由 body 确定性生成，验证器逐字节重建：

```text
GRANT:  OMAVOTE GRANT <short(key_display)> TO <expires_at_ms 的 UTC 日期 YYYY-MM-DD>
        OMAVOTE GRANT+CANCEL <short(key_display)> TO <expires_at_ms 的 UTC 日期 YYYY-MM-DD>
REVOKE: OMAVOTE REVOKE STOP-ONLY
        OMAVOTE REVOKE STOP+CANCEL-OPEN
```

GRANT 的第二种写法用于 `revoke_mode = STOP_AND_CANCEL_OPEN`。`TO` 后是到期日；最长一种（目标为 passkey 且带撤回）为 59 字节。`short()` 见 §4.1。研究固定版本的 Ledger Nervos app 签消息时只显示前 61 字节（之后为 `...`），换行和非 ASCII 字符都显示为 `*`。因此摘要必须单独承载 owner 需要核对的动作、目标钱包地址和到期日。

UI 另用中文解释：授权哪个地址、给哪把密钥、何时到期、能做什么、撤销是否同时撤回代理票，并提示用户把首行的地址缩写与在线钱包显示的地址对照。真人验收必须能在可信签名界面核对目标地址和到期日。Ledger 等短屏设备只能看到首行摘要，Owner、网络、policy、锚点和发布期限仍依赖电脑端核对全文；地址缩写只是辅助标识，不等同完整地址比对。真机验收必须完成。设备不满足显示要求时明确列为未验收路径，不声称“设备能签就已安全支持”。

## 4. Key descriptors 与保管

### 4.1 密钥描述和验签

descriptor 与其 adapter 配套固定，不能临时把同一 key_id 解释成不同算法。首版主流程是 Neuron 授权第二个在线钱包保管的投票 key，由已验收的 key adapter 验证该钱包的具体签名。网页生成本机 secp256k1 密钥为可选候选，不是首版必做项；通用 passkey 是独立 PoC 路径，不阻塞已验收的在线钱包授权路径。选某个在线钱包不等于自动接受它的所有密钥、签名格式或资产 lock。

首个在线钱包 PoC 目标为 MetaMask 类 EVM EOA（`evm-personal-message-v1`）：descriptor 已定义，`personal_sign` 会显示全文，地址可在钱包里直接核对。PoC 重点验证手机连接、全文显示与多地址签票体验；最终支持范围以 PoC 结果为准。JoyID 的签名包装不同于通用 passkey，须先定义独立的 key adapter ID 才能进入 PoC（[09 §10](09-design-update.md)）。

| `kind` | descriptor 必需数据 | 限定验签 | `key_display` 与 `short()` |
|---|---|---|---|
| `secp256k1` | `public_key`（33 字节压缩点）、`adapter=ckb-secp256k1-message-v1` | 对完整可读票面按 Nervos Message 消息域验签，公钥必须匹配 descriptor；无须该 key 有 CKB 地址或资金 | 该公钥对应标准 secp256k1_blake160 lock 的 full 地址；缩写为前 4 字符 + `..` + 末 16 字符 |
| `evm_eoa` | `address`（20 字节小写十六进制）、`adapter=evm-personal-message-v1` | EIP-191 personal_sign 恢复精确 EOA；不泛化 EIP-1271 或合约钱包 | EIP-55 大小写校验地址；缩写为前 10 字符 + `..` + 末 8 字符 |
| `webauthn_es256` | `cose_key`（规范确定性 CBOR 的 COSE EC2/P-256 公钥，base64url 无填充）、`credential_id`、`rp_id`、按字典序去重的完整 HTTPS `allowed_origins`、`adapter=webauthn-es256-v2` | 仅在下述验证及实际浏览器路径验收后开放 | `passkey ` + key_id；缩写为 `PASSKEY ` + key_id 去掉 `0x` 后的前 16 位 |

`key_display` 只是显示与核对辅助，由 descriptor 确定性导出，验签仍以 descriptor 为准。三种缩写都保留约 64 位内容：伪造同缩写的 key 约需 2^64 次运算，代价很高，但只是辅助核对，不等同完整地址比对。passkey 没有钱包可见地址，用户无法据此区分凭证，这是该可选路径的限制。钱包实际显示的地址形式与此不一致时（例如只显示 Omnilock 地址），该钱包的 adapter 验收不通过，或须另定义显示规则。

WebAuthn 必须验证 COSE `kty=EC2`、`alg=ES256`、`crv=P-256` 与合法 x/y；保存完整原始 clientDataJSON、authenticatorData、DER signature 和 credential ID。该 ballot 的 signature_format 固定为 `omavote-webauthn-v2`。challenge 固定为 `base64url(H("OMAVOTE/WEBAUTHN/BALLOT/V2\0" || JCS(ballot_body)))`，body 的随机 nonce 提供每次新签的随机输入；不把 JoyID 的包装格式直接当作通用 passkey 格式。客户端必须重建、展示并要求确认提案与选择，认证器弹窗本身不保证展示这些内容。

验证 `type=webauthn.get`、challenge、origin 精确属于签入的列表、rpIdHash、UP/UV 标志和签名（authenticatorData || SHA256(clientDataJSON)）。本路径拒绝 crossOrigin=true；该字段缺省或 false 可接受，topOrigin 不应出现。proof 原始 clientDataJSON 按 WebAuthn 解码与验签，不能重新 JCS 后代替原始签名字节；拒绝重复键、未认可扩展/格式。注册时验证证明持有相应密钥的流程。签名计数器用于设备克隆诊断，不能用当前服务器计数器裁掉已公开的历史有效票；支持同步凭证时也不能把计数为零当作必然伪造。精确编码与正负向量为 PoC 门槛。[WebAuthn 断言核验](https://www.w3.org/TR/2026/REC-webauthn-3-20260825/#sctn-verifying-assertion)

### 4.2 在线钱包主流程与恢复

首次连接在线钱包时，通过 key adapter 取得与核验 descriptor，并证明控制相应 key；owner 在 Neuron 签 GRANT，把该 descriptor 和期限写入公开授权。授权期内每次连接同一 key，为每个 owner 的具体提案签票。连接、网站会话和钱包解锁都不是选票，也不能让服务器替用户签署选择。

在线钱包保管其私钥，投票站不生成、接收、存储或导出这把私钥及钱包助记词。不要求导入 Neuron 助记词，也不要求在线钱包有 CKB。钱包负责自身的备份与设备恢复；已签授权和选票由免费中继发布，投票站不能以恢复账号为由收取密钥秘密。

清理网站缓存或切换设备后，连接保管同一 key 的钱包，可从公开历史找回授权；换成不同 key 时由 owner 重新授权。镜像站重连是否能保持同一 key、账户切换时如何提示、钱包显示哪些签名字段，都属于 adapter 的实际验收要求。原钱包丢失或疑似泄露时，使用 owner 的 Neuron 签名安全撤销并授权新 key，不能由后台重置。

钱包保管使网页不必持有投票私钥，但不保证签名请求正确：被植入脚本的网页仍可诱导错误提案或选择，钱包也未必显示全部字段。须实测其可信签名界面和确认内容，不能把“连接钱包”或钱包自身的登录确认当作具体选票可读性的证明。

通用在线钱包还有一层额外暴露：它连接过的任何网站都能请求签任意文本，消息签名本身不绑定网站来源（为了镜像站可用，本协议有意不绑定）。票面写着“不转移资产”，反而可能让人放松警惕；而 GRANT 是公开的，任何人都能列出哪个地址代表哪些 owner、多少票权、有效到何时，便于定向钓鱼。产品须做到：

1. 引导用户在在线钱包里为投票单独建立一个账户，不使用日常交易账户。
2. 每张代理票收录后，在该 owner 的公开 feed（[03 §12](03-protocol.md)）和页面中提示，owner 发现异常可直投覆盖或安全撤销。
3. 钱包 adapter 验收确认签名弹窗显示请求来源网站。
4. B 的尾盘代理截止（`rules_profile.delegate_cutoff_ms`）能为 owner 留出发现与覆盖的时间；首版不启用，以后启用须经规则确认（[09 §6](09-design-update.md)）。

### 4.3 本机密钥与通用 passkey：可选候选

如果后续提供本机候选，在设备上生成专用随机 secp256k1 私钥，不导入 Neuron 助记词，不交给中继，不写入 URL、遥测或公开日志。会话内存持有解锁密钥；持久保存用经过审查的加密密钥库，用户设置本地解锁口令。加密备份为可选恢复方式，未备份则说明丢 key 后需要 owner 重新授权；具体密钥库编码/KDF 参数属于需冻结和审查的客户端实现，不参与票权共识。不能自行发明密码算法，也不能把“浏览器存储已加密”当成能抵抗正在运行的恶意脚本。网页自身签票没有独立的钱包显示保证；恶意脚本在解锁期间可能代签或导出密钥，风险持续到授权失效或安全撤销。

本机候选每次投票仍要求明确确认提案与选择，不能自动在后台投票。页面重载/新会话解锁一次不等于重新用 Neuron 授权。若实现该候选，必须单独完成存储留存、安全、备份及 owner 恢复验收，不以减少钱包安装步骤为由绕过这些门槛。

丢失本机缓存：从加密备份恢复相同 key，原授权继续有效；丢失备份或怀疑泄露：通过 Neuron 的 owner 签名撤销/换 key。网站账号找回不能恢复私钥。恢复码若被采用，只在用户设备上派生签名，不发送给后台作登录密码；持有秘密的人拥有该 key 的全部未过期投票能力。

Passkey 通常绑定 RP ID，平台同步不等于任意镜像都能调用。必须实测官方域名不可用时的相关域配置或 owner 重新授权路径；不得强制把官方网页嵌进镜像冒充独立恢复。不能跨站调用时，应清楚显示需要 owner 恢复，而不是保证无感切站。[跨相关域规则](https://www.w3.org/TR/webauthn-3/#sctn-related-origins)

## 5. 控制状态机

按主协议位置 `(height, tx_index, output_index, envelope_index)` 逐条处理完整控制历史。先验格式、owner 权限、policy、锚点/发布时限，再去重和更新状态。无效 proof、过期记录不参与排序；同一 authorization_id 仅首次有效出现产生作用。

**控制格式与选票格式分开。** GRANT/REVOKE 按 [03 §5.1](03-protocol.md) 的全局控制格式集合验证：该集合只增不减，新增格式写明开始生效的区块高度。每个提案都处理该 owner 的完整控制历史，不按提案的 `auth_registry` 过滤；提案清单只决定本提案接受哪些选票（§6）。由此保证一条不变量：**改变或收窄提案接受的格式清单，只会让部分选票不被计入，永远不会让已被撤销或被取代的授权重新有效。**

验证器必须实现截至被评估位置已生效的全部控制格式。遇到无法识别格式 ID 的控制消息时不得跳过，应把该 owner 的授权状态报告为不完整，结果按 `DATA_INCOMPLETE` 处理并提示升级验证器；实现了最新规范的验证器把规范从未定义的 ID 视为无效，因此编造的格式 ID 不能让结果一直处于不完整。某个控制格式被攻破时，伪造的控制消息可能使受影响地址的代理投票失效。只有提案的 `auth_registry` 已排除该格式时，以它签署的 grant 为依据的代理票（以及用它签的直接票）才不会被计入（§6）；仍接受它的提案，包括发现漏洞前已开票的，可能计入伪造票，委员会应发布 HOLD_EXECUTION 并按治理流程处置。被攻破格式的停用规则另行设计。

记当前生效控制消息的锚点高度为 `A_max`：

| 有效控制记录 | 对状态的影响 |
|---|---|
| `anchor_height < A_max` | `STALE_AUTHORIZATION`，不恢复旧 grant、不形成新撤销屏障 |
| `anchor_height = A_max`，且 body 与该锚点此前某份有效记录相同 | 重复，不产生作用 |
| `anchor_height = A_max`，且 body 与该锚点此前的有效记录都不同 | `AUTH_CONFLICT`，停止代理新票，并在该位置建立安全撤回屏障；锚点更高的控制消息才能恢复 |
| `anchor_height > A_max` 的 GRANT，`revoke_mode` 为 null | 新 grant 成为唯一可签新票的授权；旧 grant 不能再产生新有效代理票，此前有效代理票保留 |
| `anchor_height > A_max` 的 GRANT，`revoke_mode` 为 STOP_AND_CANCEL_OPEN | 同上，并在该位置建立安全撤回屏障，撤回旧代理票；新 grant 之后的票不受影响 |
| `anchor_height > A_max` 的 REVOKE / STOP_ONLY | 停止代理新票；此前有效代理票保留 |
| `anchor_height > A_max` 的 REVOKE / STOP_AND_CANCEL_OPEN | 停止代理新票，并建立安全撤回屏障 |

“续期”和“换密钥”都是 owner 签一份锚点更新的 GRANT，不修改原记录。普通 GRANT 不使旧有效票消失，新 key 必须对具体提案签新票才改变选择；怀疑旧 key 泄露时，用带 `STOP_AND_CANCEL_OPEN` 的 GRANT 一步完成换 key 与撤回，不存在撤销与新授权的先后问题。到期自动停止新票，不回退到更早 grant。控制冲突后的新 grant 不复活被屏障撤回的旧票。

排序只看锚点：只有**锚点更高、有效并及时收录**的控制消息才会取代当前记录。锚点不能晚于签名时已经存在的区块，且须在 24 小时内收录，因此被钓鱼或被扣留的控制消息只能压过锚点更早的记录；owner 之后签出、锚点更高的控制消息收录后即可使其失效。不存在“签一次就再也无法撤销”的序号耗尽，也不会因发布顺序不同而复活旧授权。

但“后签”不等于“锚点更高”。恢复页面若因节点落后、使用旧缓存或新设备尚未同步而选了更低的锚点，后签的撤销仍会输给攻击者扣留的、锚点更高的 GRANT。签署撤销与恢复类控制消息的客户端必须做到：

1. 签名前确认节点已同步：与至少一个独立来源比对 tip 高度与 hash，落后时拒绝生成恢复消息并说明原因。
2. 锚点取已验证的最新块，不取 tip 之前若干块，并须高于链上和已知中继队列中该 owner 任何控制消息的锚点。
3. 新设备或清除缓存后，先从链上读取该 owner 的完整控制历史再签名。
4. 收录后按本状态机核对撤销确已生效；被锚点更高的记录压过时，提示用更新的锚点重签。
5. 锚点所在块被重组移除时原消息失效，客户端提示重签。
6. 已单独发出安全撤销、之后要授权新 key 的，须在第 4 步确认撤销及屏障生效后，才允许生成新 GRANT。否则新 GRANT 若先上链，撤销会因锚点更早被判过时，不建立屏障，旧代理票得以保留。

页面在第 4 步核对通过之前不显示“已撤销”。

**安全撤回屏障**：对在该位置链时钟仍位于 `[start_ms,end_ms)` 的提案，排除这个 owner 在屏障及之前收录的全部代理票，不排除 owner 直接票，不改变已经结束的提案。之后更高授权产生的有效新票可以重新参与；仅续期没有新票时仍不参与。屏障按链位置和提案固定窗口计算，无须信任后台列出的“进行中提案清单”，也不会退回更老的赞成票。不同 owner 的屏障互不影响。

界面“密钥丢失/被盗”的默认动作：已准备好新 key 时，每个地址签一份带 STOP_AND_CANCEL_OPEN 的 GRANT，一步完成换 key 与撤回；暂不换 key 时，签 STOP_AND_CANCEL_OPEN 的 REVOKE。STOP_ONLY 是明确解释“保留此前代理票”的高级操作。多地址恢复需要逐 owner 签控制消息，页面逐地址显示收录进度；未收录者仍未恢复，不能把一次点击显示成全部已撤销。没有管理员重置。

## 6. 选票排序与最终归属

一张 ballot 仍只代表一个 owner，新增 `authority`、`authorization_id`、`signer_key_id`。直接票这两个 ID 为 null；代理票必须引用确切 grant，验签 key 必须等于 grant descriptor。代理签名不能凭 key 当前控制哪些地址，扩展到票面未写出的 owner。

选票分为两条序列，不让被盗投票 key 占用 owner 的恢复能力：

* 直接票：`(poll_id, owner_id, authority=owner)` 序列。消息和经审查的直接交易共用这个序列。
* 代理票：`(poll_id, owner_id, authorization_id)` 序列。跨 grant 的新旧关系由 grant 的锚点高度决定。

每张选票都签入一个已知规范链祖先 `anchor_block_hash`；收录时该块必须仍在规范链上且是收录块的祖先，否则为 `ANCHOR_INVALID`。同一序列内只按选票锚点高度比较新旧，锚点相同而内容不同的票互为冲突。选票不设序号：若在同一锚点内用签名者填写的数字决胜，被扣住的早签票就能靠一个大数字反超。

选票客户端沿用 §5 的锚点要求：签名前确认节点已同步；锚点一律取已验证的最新块；同一序列两次签名之间等出新块（约 8–10 秒）；收录后核对该票确已成为当前选择，锚点块成为孤块或被压过时提示重签。在这些前提下：

* 签名所在块高于被扣票锚点的改票必然胜出，最新改票或撤回可以单独交给任何发布者，不需要先发布已放弃的中间版本；
* 同一块内签出的两张不同票为冲突，该 owner 暂不计票，可重签恢复，不会被静默覆盖；
* 节点落后时这一保证不成立。恶意页面若让用户在之后的块里签下攻击者的选择，后签的票仍会生效，只能靠核对签名内容和代理票提醒防范。

代理票在其**收录位置**必须满足：提案完整窗口，且链时钟早于 `end_ms − rules_profile.delegate_cutoff_ms`（首版为 0，即与完整窗口相同）；owner 正存款资格（CANCEL 例外）；当前控制状态是该唯一 grant；grant 未到期；grant 位置严格早于票位置；网络/DAO/policy/key 匹配；grant 的 owner adapter 与 key adapter 都列在本提案 `auth_registry` 中，否则为 `ADAPTER_NOT_ACCEPTED`。先完成这些检查，才允许占据去重位置并参与排序。到期或撤销后才收录的代理票无效，不能挤掉此前的有效票。

对每个 owner，计算截至 H_close 的最终选择：

1. 从完整历史取得所有逐出现验证成功的直接票与代理票，同 ballot_id 取首次有效出现。
2. 如果有任何有效直接票，取锚点最高的直接票：最高锚点上有不同 body 为 CONFLICT；否则采用其 action。直接 CANCEL/CONFLICT 也不回退到代理票。该提案一旦用 owner 直接接管，首版不提供“交回代理”动作；后续仍用 owner 改票，其他提案不受影响。
3. 没有直接票时，先排除本提案安全撤回屏障覆盖的代理票；对剩余票按 `(grant 锚点高度, 选票锚点高度)` 取最大。这里只比较已对该 owner 验证成功的票，而不是 key 的全局最新票。
4. 最大组合有不同 body 时为 CONFLICT；其余采用 action。CANCEL 排除双方和 quorum；没有候选票为未参与。
5. 对该 owner 截止状态的 active deposit 求和，每个 outpoint 最多归入一个最终选择。

自然到期、STOP_ONLY、普通换 key 都保留此前有效票；安全撤回和授权冲突使用上述屏障。这些行为是本版明确选择，不混用“按当前授权重新判断所有历史票”的另一种语义。

## 7. 存储、恢复与服务

完整 policy、GRANT、REVOKE 与原始 owner proof 通过主协议的授权载体上链。授权历史早于提案也必须读取，不能只扫描投票七天；可从自己的已验证 checkpoint 恢复。截止后控制记录不追溯影响该提案；重组重算使用相同规范链视图，不使用“今天的授权状态”替代。

中继验代理票时查的是 owner 的资格，不能要求 key 自己有 DAO 存款或普通 CKB。撤销、已有参与者的零余额 CANCEL 和恢复消息应有单独赞助通道/预算，不能被“余额必须正”统一过滤；任何符合协议、由外部发布者自愿出资的发布仍须接受，但产品不能要求选民自费。合资格用户的授权、续期、投票、改票、撤销与恢复由中继/运营方/帮助者承担费用与容量，并提供免费备用入口。可按已认证 owner、控制更新频率和实际成本限流，不能按选择区别对待。

公开查询增加授权列表、历史与有效位置、到期状态、冲突、恢复进度，以及按 key_id 查询它代表哪些 owner（在线钱包重连后据此找回授权）；这些 API 仍是缓存，不能作为 grant 的唯一证据。所有服务关闭后的演练必须包含从历史找回 grant、重新连接或恢复在线钱包的相同 key、owner 换 key，以及免费发布撤销；只重建选票列表不算通过。若开放本机候选，还须演练其缓存清除与备份丢失恢复。

## 8. 评审与未来测试用例

以下是规范规定的预期结果，**不是已经执行通过的测试**；旧研究模型没有授权状态机。

| 场景 | 预期结果 |
|---|---|
| A 有两笔 deposit，B 有一笔，两地址授权同一 K | 两份 owner 授权、两张代理 ballot；本金各一次，日常可合并界面引导，钱包签名确认次数按 adapter 验收 |
| A 授权至第 10 天，B 至第 30 天；K 第 5 天 Yes、第 12 天 No | A 保留第 5 天 Yes；B 采用第 12 天 No；A 的过期新票无效，不影响排序 |
| K 对 A 连续签多张代理票；A 用直接票投 No | A 的直接 No 优先；选票没有序号，K 无法用任何数字锁死该序列 |
| 第 1 张 YES 已上链；第 2 张 NO 已签但原中继未发布；用户再签第 3 张 CANCEL，交备用中继及时上链 | 采用 CANCEL，不需要先发布第 2 张；第 2 张日后上链也因锚点更早而不生效 |
| 在线钱包被其他网站诱导签了一张代理票，攻击者扣住，截止前才发布；owner 在之后的块里又改过票 | 被扣住的票锚点更早，不能压过之后的改票 |
| 早签票锚点 100 被扣住；用户节点已同步到 101 后签改票 | 改票锚点取最新块 101，扣住的票即使最后发布也不能胜出；客户端若改取 tip 之前的块（如 99），扣住的票会赢，测试须覆盖并拒绝这种锚点选择 |
| 恶意页面在同一块内让用户先后签两张不同的票，并扣住其中一张 | 两张锚点相同，判为冲突，该 owner 暂不计票；提醒出现后重签即可恢复，不会被静默翻票 |
| 后续提案的 `auth_registry` 不列 owner 撤销时所用的控制格式 | 撤销仍然有效；提案清单只影响选票，不能复活被撤销的授权 |
| 恢复页面节点落后，生成的 REVOKE 锚点低于攻击者扣住的 GRANT | 签名前的同步检查应拒绝生成；若已收录却未生效，提示用更新的锚点重签 |
| 被钓鱼签下并扣住的普通 GRANT（攻击者 key，锚点 100）；owner 之后签正常 GRANT（锚点 101） | owner 的 GRANT 锚点更高，扣住的 GRANT 即使后发布也是 STALE_AUTHORIZATION |
| owner 先签安全撤销（锚点 200），再签新 GRANT（锚点 205），新 GRANT 先上链 | 撤销被判过时，不建立屏障，旧 key 已投的票保留；客户端须先确认撤销生效再生成 GRANT，或改用一步完成的 GRANT+CANCEL |
| owner 签带 STOP_AND_CANCEL_OPEN 的 GRANT 换新 key | 新 grant 生效，同时撤回该 owner 在未结束提案中的旧代理票；新 key 之后投的票不受影响 |
| K1 已投 Yes；owner 换 K2，但 K2 尚未投 | 旧 Yes 保留；K2 新投 No 后采用 No（新 grant 锚点更高） |
| 锚点较早的 GRANT 在锚点较新的 REVOKE 之后才上链 | 不恢复授权；发布顺序不能反转签名先后 |
| 钓鱼页面让 owner 签了给攻击者 key 的 GRANT，且已上链 | owner 签一份锚点更新的 STOP_AND_CANCEL_OPEN，收录后即生效，撤回未结束提案中的攻击者代理票；不存在无法撤销的状态 |
| 攻击者扣留一份更早签的 GRANT，在 owner 撤销后 24 小时内发布 | 锚点早于撤销，为 STALE_AUTHORIZATION，无作用 |
| 自然到期或 STOP_ONLY 后已有有效 Yes | 保留 Yes；此后新票无效 |
| 安全撤销在提案窗口内及时收录 | 撤回该 owner 此前全部代理票；不回退旧票、不撤直接票 |
| 安全撤销在窗口结束后才收录 | 不追溯更改该提案；后续提案不能再用旧 key 新投 |
| 同一锚点高度的不同控制 body | 停止代理并建立屏障；锚点更新的 grant + 新 ballot 恢复 |
| 同一个 grant 下锚点相同、body 不同 | 只使该 owner 在该 poll 冲突；锚点更新的新票恢复 |
| 代理 CANCEL 是最大有效票 | 不计双方/quorum，不回退此前 Yes |
| 直接 CANCEL/CONFLICT 与代理票并存 | 直接层接管，不因代理新票而复活 |
| 授权与票在同一交易不同输出 | 按固定 output_index 排序，grant 必须在 ballot 之前；反序不占首次有效出现 |
| 控制超发布期限、控制或选票的锚点不在规范链、代理票过早/过晚 | 拒绝该出现，不参与排序；需要新的有效控制、重签或及时重发 |
| 投票 key 零余额，owner 有合资格 deposit | 代理票可计；费用由中继/帮助者承担 |
| key 试图授权另一个 key、改变 owner 或改变 policy | 拒绝，不接受二级委托或跨域重放 |
| 载体已回收、官方服务全失、数据库全删 | 从完整历史重建公开状态；用户重连保管同一 key 的钱包，或用 owner 重新授权；不能从链恢复用户私钥。本机候选另测可选备份恢复 |
| 原站域名失效，passkey 不能在镜像调用 | 显示限制并用已验收的恢复路径；不得虚报“已成功切换” |
| 后续提案新增一种 key adapter | 已有 GRANT 与 auth_policy_hash 不变，无需重新授权；未列入该 adapter 的提案中，用它签的代理票为 ADAPTER_NOT_ACCEPTED |
| owner 用 Ledger 签 GRANT | 屏幕首行显示 `OMAVOTE GRANT <地址缩写> TO <日期>`，带撤回时为 `OMAVOTE GRANT+CANCEL …`，可与在线钱包地址对照；其余字段依赖电脑端核对，仍须真机验收 |

评审还应检查控制冲突与安全撤回的组合、锚点所在块或屏障被重组移除、同块存取款、超过批次大小时部分地址先收录、恶意前端诱导授权、在线钱包换账号与 key 丢失；本机候选若开放，另测浏览器清理及可选备份遗失。上限一年降低不了这些检查的重要性。
