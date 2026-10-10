# 浏览器签名插件（设计草案）

状态：设计草案，**尚未实现**。已吸收两轮同事意见：第一轮（结构化选票、恢复须停用旧 key、口令方案、逐浏览器验收），第二轮（解锁截止时间、请求绑定与失效、确认范围可见、密钥表述、锚点影响、前端代理投票组件、页面与插件内部消息分离），第三轮（签名改用核心 WASM、结果异步送回、`activeTab`、注入由 service worker 完成、同锚点冲突拦截、拒绝非活动文档、确认按钮延迟、具体字节上限）。官方域名待定，见 §8。

## 1. 目的与边界

Neuron 用户目前的日常路径是：用 Neuron 为每个存款地址签 GRANT，授权 MetaMask 里的一个账户作为投票 key，之后在浏览器里用 MetaMask 签票（[10 §3](10-user-journey.md)）。对只用 CKB 的人来说，为投票装一个以太坊钱包并不自然。

本插件是一个**可选的桌面签名器**：只保管一把专用投票 key，只签 Omavote 代理选票。

- MetaMask 路径保持完整支持；手机用户继续走 MetaMask。
- 插件不是钱包：不导入助记词，不接触存款私钥，不持有资产，不签交易。
- 插件与 Neuron 的关系：Neuron 控制的存款地址用 GRANT 授权插件的 key 投票；插件日常签票不调用、也不依赖 Neuron。
- GRANT、REVOKE、提案和流程记录（委员会、协调人等）仍由各自的 owner 或角色 key 签署，插件不签。
- 协议、服务端和两个验证器不改。改动只有：新增 `extension/` 目录、前端的插件连接与代理投票逻辑（§10，现有代理投票组件按 EVM key 写死，需要一并修改）、WASM 新增两个方法（§2.3）。

## 2. 与现有协议的对应

### 2.1 key 类型

插件的 key 使用已冻结的 `secp256k1` descriptor 与 `ckb-secp256k1-message-v1` adapter（[11 §4.1](11-authorization.md)）：

| 项目 | 内容 |
|---|---|
| descriptor | `{kind: "secp256k1", public_key, adapter: "ckb-secp256k1-message-v1"}`，33 字节压缩公钥 |
| 显示 | 该公钥对应标准 secp256k1_blake160 lock 的完整 CKB 地址；缩写为前 4 字符 + `..` + 末 16 字符。这个地址不需要有 CKB 或资金 |
| 验签 | 对完整可读票面按 Nervos Message 消息域验签，公钥必须匹配 descriptor |

已有支持：核心验签与显示（`crates/omavote-core/src/adapter.rs`、`messages.rs`），服务端默认清单把它列为可接受的 key adapter（`crates/omavote/src/api.rs` 的 `default_registry`），TypeScript 验证器（`verifier-ts/src/adapter.ts`），前端 GRANT 表单已接受压缩公钥作为目标 key（`web/src/lib/flow.ts` 的 `parseKeyInput`）。

不选 `evm_eoa`：插件不走通用的 `personal_sign`（§4），兼容 EIP-1193 已经没有好处；显示为 CKB 地址也更符合 Neuron 用户的习惯。GRANT 首行写的就是这个地址的缩写，用户把它和插件里显示的地址对照。两者用的是同一条 secp256k1 曲线，改变的只是 descriptor、消息摘要规则和身份显示方式，安全性没有因此提高。

### 2.2 一个 owner 同时只授权一把 key

新的 GRANT 收录后成为该 owner 唯一可签新票的授权（[11 §5](11-authorization.md)）。第一版插件不提供 key 导出，因此一个存款地址只能在一台电脑的插件上日常投票。换电脑等同于换 key，走 §3.7 的恢复流程。

### 2.3 签名

签名使用核心已有的 `adapter::ckb_sign_message`：对 `Nervos Message:` 前缀加完整票面取 CKB 哈希，再用 k256 做 secp256k1 可恢复签名（RFC 6979 确定性随机数、low-s），直接输出协议格式 `r || s || v`（65 字节）。服务端中继和 `vectors/signatures.json` 用的是同一个函数。`crates/omavote-wasm` 新增两个方法：`ckb_sign_message`（私钥与文本，返回签名）和 `secp256k1_public_key`（私钥，返回压缩公钥，同时检查私钥合法）。插件因此不需要额外的 JavaScript 加密库（WebCrypto 不支持 secp256k1），也不必处理第三方库的预哈希和签名字节顺序。每次签完先调用 WASM 的 `verify_key` 自检，通过后才返回给页面。

签名与库无关：协议固定了摘要和格式，任何 RFC 6979 加 low-s 的实现对同一私钥、同一票面给出相同的字节，以后更换实现不影响已签的票。

## 3. 用户流程

### 3.1 安装与创建 key

安装后打开插件，设置本地口令，插件生成 key 并显示其 CKB 地址。同时明确告知：

- 本插件只提供投票签名，不提供转账功能；这个地址用于核对投票身份，请勿转入资产；
- 第一版没有备份，丢失或忘记口令时须用 Neuron 重新授权新 key（§3.7）。

注意措辞：这是一把普通的 secp256k1 私钥，对应的标准 CKB 地址照样能收到资产，私钥泄露后也不存在密码学上的“只能投票”。插件拒绝签交易是插件的功能限制，不是密钥的限制。重置会删除旧密文，误转入该地址的资产将很难取回，所以提示必须说清楚。

### 3.2 连接（登录）

在 Omavote 里，登录就是连接：用户同意后，插件把 key 的 descriptor 交给网站。不签任何登录消息。系统没有账号和会话，每个动作都是单独签名的票面，登录签名不增加安全性，还会让用户习惯签无实际内容的文本。

- **官方域名**：插件自动在页面注入接口（§8）。用户点页面里的“连接”，插件弹出确认窗口，显示请求来源和 key 地址；同意后连接完成。
- **其他站点（自托管、镜像）**：授权前插件和页面之间没有通道。用户点浏览器工具栏的插件图标，弹窗显示当前站点的来源，点“连接这个网站”，再在 Chrome 的权限框里同意。插件随即在当前页面注入接口，无须刷新；以后打开该站点自动可用。这一步同时完成注入权限和连接确认。弹窗若在权限框出现时被关闭，注入照常完成（§8），连接确认则改在页面调用 `connect()` 时弹出。

连接后页面用 `GET /api/keys/{key_id}/authorizations` 查出这把 key 代表哪些 owner，列出地址和预计权重，Neuron 用户不必再手动填写地址。

以后如果确实需要登录签名（例如不公开的功能），使用以 `OMAVOTE LOGIN` 开头、包含来源、随机数和过期时间的可读文本，作为单独的方法和单独的校验规则。不在第一版范围内。

### 3.3 首次授权

连接后若该 key 还没有授权，页面用插件 key 的 descriptor 生成 GRANT 文本（沿用现有流程，表单新增“使用已连接插件的 key”）。用户在 Neuron 中逐地址签名并粘回，由中继发布；页面等授权收录后显示可投票。

### 3.4 投票

页面为这把 key 代表的每个 owner 各生成一张代理选票：同一提案、同一选择。然后一次调用 `signBallots`；超过单次上限（§13）时分批调用，每批单独确认。插件确认窗口**默认直接显示**确认范围，不能折叠：

- 请求来源；
- 使用哪把 key（CKB 地址）；
- 提案 `#` 编号、标题与选择；
- 为几个地址投票，以及每个 owner 的完整地址。

每张票的完整票面（纯文本）可以展开查看。确认范围必须一眼可见，因为恶意页面可以提交一组完全合法的票，只是多夹带几个用户这次并不想代表的地址；这种请求能通过结构校验，签名也有效。

用户确认一次，插件为列出的全部选票签名。页面照常提交，中继照常发布。确认窗口关闭即视为拒绝。

确认按钮在窗口获得焦点约 1 秒后才可点击，窗口失去焦点后重新计时。确认窗口是页面一个动作触发弹出的，页面可以诱导用户连点，让第二下正好落在新窗口的确认按钮上。

### 3.5 锁定

插件空闲超过设定时间自动锁定，也可手动锁定；浏览器重启、插件更新或重载后都处于锁定状态。锁定时 `getKey` 和连接仍可用（公钥不加密保存），签名前确认窗口会先要求解锁。

“空闲”只按用户在插件自身界面（工具栏弹窗、确认窗口）里的操作计算。网页调用 `getKey()`、发送请求都不能续期。锁定的实现见 §7：以截止时间为准，定时器只做辅助清理。

### 3.6 断开与请求失效

插件弹窗列出已连接的站点，每个都可以断开。非官方站点断开时撤销该站点的主机权限并注销注入；官方域名只撤销连接确认（主机权限是安装时的必需权限）。

注销内容脚本不会移除已经注入当前页面的脚本，所以页面里的 `window.omavote` 可能还在。是否允许请求一律由 service worker 按当前连接状态判断，不依赖页面里有没有接口。

以下任一情况发生时，相关的待确认请求立即失效；即使旧确认窗口还开着，点击确认也不能签名：

- 用户断开该站点；
- 浏览器撤销了该站点的权限（`chrome.permissions.onRemoved`）；
- 重置 key；
- 发起请求的页面已导航或关闭；
- 请求超过确认时限。

请求的绑定与签名前检查见 §5.3。

### 3.7 恢复：key 丢失、忘记口令或怀疑泄露

忘记口令没有找回方式，与丢失 key 走同一流程：

1. 在插件里重置，生成新 key（旧 key 的密文随之删除）；
2. 连接页面，选择“换新 key 并撤回旧票”；
3. 每个存款地址在 Neuron 签一份带 `STOP_AND_CANCEL_OPEN` 的 GRANT，一步完成授权新 key 与撤回旧 key 在未结束提案中的代理票（[11 §5](11-authorization.md)）；
4. 页面逐地址显示收录进度。授权有效收录并核对生效后，才显示“已恢复”；未收录的地址仍未恢复。

界面必须说明：撤回会同时去掉自己此前在未结束提案中正常投出的代理票，需要用新 key 重新投。确定旧 key 没有泄露、想保留旧票的用户，可以选高级选项，签不带撤回的普通 GRANT，旧 key 此前的有效代理票保留。

## 4. 签名请求的校验

插件只接受结构化的代理选票请求，由插件用现有核心重建标准票面，再显示和签名。所有来自页面和内容脚本的消息都视为不可信输入（[Chrome：消息传递](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)）。

请求为 `{manifest, bodies}`。**网络参数不接受页面传入**，只用插件内置的网络（§6）。service worker 在显示任何内容前依次检查：

1. **网络**：每张票的 `genesis` 等于内置网络的创世区块 hash。
2. **提案**：manifest 由 WASM 解析；票面生成时核心会检查 `poll_id` 是这份 manifest 的 hash，`rules_hash` 和 `genesis` 一致（`text::ballot_text`）。页面因此无法给真实的提案编号配上假标题。
3. **选票字段**：`action` 只能是 YES、NO 或 CANCEL；`authority` 必须是 DELEGATE；`authorization_id` 不能为空；`signer_key_id` 等于插件 key 的 key_id；`auth_adapter` 为 `ckb-secp256k1-message-v1`。
4. **一次请求**：所有票属于同一提案、同一选择，owner 互不相同，数量不超过上限（§13）。字节数按 `crates/omavote-core/src/carrier.rs` 的载体上限：manifest 不超过 32 KiB（manifest 单独占一个 witness），每张票 body 不超过 8 KiB（单个信封上限），整个请求不超过 192 KiB（一份 manifest 加 20 张票）。service worker 先按 JSON 字节数检查，超出直接拒绝，不交给 WASM 解析。
5. **重建票面**：用 WASM 的 `ballot`（与服务端、验证器同一份代码）生成 `omavote-readable-v2` 全文。显示的和签名的都是这份重建结果，页面提供的任何显示文本都不使用。
6. **同锚点冲突**：插件在本地记录自己签过的每张票的（`poll_id`，`owner_id`，`authorization_id`，`anchor_block_hash`）与 `ballot_id`。请求中有任何一张票与已签记录的前四项相同而 `ballot_id` 不同，整个请求拒绝（`ANCHOR_REUSED`）。同一授权序列在同一锚点上出现两张不同的票即为 `CONFLICT`，选择相同也一样，因为 nonce 不同（见本节末段）。选票锚点是公开的，恶意页面可以照抄用户上一张票的锚点，请用户签一张看起来完全正常的票，结果该 owner 的票不计，用户却看不出来。同一高度只有一个规范块，所以比较 hash 就能发现同一位置；`ballot_id` 相同（同一张票重签）照常允许，签名是确定性的，结果不变。记录随 key 重置一起删除。

一律拒绝：任意文本、任意哈希、GRANT/REVOKE、提案与流程记录、交易，以及任何其他方法。

**签名的效力**：签名只对用户确认的那张具体选票有效。插件不能阻止恶意网站诱导用户签一张合法但选择错误的票；签好的票任何人都可以转发，这正是允许更换中继的设计。缓解手段是醒目显示请求来源，以及用户对照论坛核对 `#` 编号。

**插件的保证范围**：插件保证签名对应它所展示的票面；不保证授权有效、提案获准入、锚点新鲜，也不保证最终计票结果。插件不连节点，以下内容它检查不了，作为已知限制：

- 授权是否存在、是否有效；
- 提案是否已登记、是否获官方准入；
- 锚点区块是否最新。

锚点的影响不只是“票无效”。核心接受不早于提案登记高度的任何规范祖先区块作为锚点，并不要求它是最新区块（`crates/omavote-core/src/engine.rs` 的选票检查）；计票时同一 owner 按（授权锚点高度，选票锚点高度）取最高排序位置，同一最高位置上出现不同选票即判为 `CONFLICT`（`crates/omavote-core/src/tally.rs` 的 `pick`）。因此页面若给出旧锚点，用户的改票可能不生效，甚至让已有的有效票进入冲突状态。插件能拦住的只有与它自己签过的票锚点相同的情况（第 6 项）；插件拿不到锚点高度，判断不了锚点是否比上一张更旧。

所以页面按 [11 §5](11-authorization.md) 做的独立 tip 检查，以及发布后在页面上核对选票状态，仍然必要。选择、owner 和提案都写在用户看到的全文里，不能在用户不知情时被改掉。

## 5. 页面与插件的接口

### 5.1 注入与发现

插件在页面主环境（MAIN world）定义 `window.omavote`，并在注入完成时派发 `omavote:ready` 事件。非官方站点是在页面加载后才注入的，所以页面除了加载时检查 `window.omavote`，还要监听这个事件。

### 5.2 方法

| 方法 | 返回 | 说明 |
|---|---|---|
| `getKey()` | `{descriptor, key_id, display, genesis}` 或 `null` | 站点未连接时返回 `null`，不弹窗 |
| `connect()` | 同上 | 未连接时弹出确认窗口；在非官方站点上，接口只会在用户已通过工具栏连接后出现 |
| `signBallots({manifest, bodies})` | `{signatures}`，与 `bodies` 顺序一致 | 校验见 §4，弹出确认窗口 |
| `disconnect()` | — | 撤销本站连接 |

事件 `omavote:changed`：key 重置或连接状态变化时派发，页面应重新调用 `getKey()`。

错误码：`USER_REJECTED`、`NOT_CONNECTED`、`WRONG_NETWORK`、`INVALID_REQUEST`、`ANCHOR_REUSED`（§4 第 6 项，页面应等出新块后重新生成选票）、`BUSY`（同一来源已有待确认请求）、`EXPIRED`（确认窗口超时未处理）。

### 5.3 消息路径

页面主环境 → `window.postMessage` → 内容脚本（ISOLATED world）→ `chrome.runtime.sendMessage` → service worker。

- 内容脚本只注入顶层页面，不注入 iframe；service worker 拒绝 `frameId` 不为 0 的请求，也拒绝 `documentLifecycle` 不是 `active` 的请求（预渲染或往返缓存中的页面，用户看不见，不能弹出确认窗口）。
- service worker 从浏览器提供的 `MessageSender` 取请求来源与文档信息，不读取消息里自称的来源（[MessageSender](https://developer.chrome.com/docs/extensions/reference/api/runtime#type-MessageSender)）。
- 待确认的请求（含重建后的全文）保存一份不可变副本，存在 `chrome.storage.session`，防止 service worker 被回收后丢失；确认窗口按 id 读取。用户确认后签的是这份副本，页面提交后无法替换。
- 每个来源同一时间只允许一个待确认请求；确认时限 5 分钟。
- **结果异步送回。** 需要用户确认的请求，service worker 校验后立即答复“已受理”，不让原消息通道一直开着等用户。用户确认、拒绝或请求失效后，service worker 用 `chrome.tabs.sendMessage` 指定请求记录的 `documentId`，把结果送回发起请求的文档，内容脚本再交给页面。原因：service worker 空闲 30 秒就可能被回收，单个请求最多处理 5 分钟，正好等于确认时限（[service worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)）；用户看票超过半分钟很常见。service worker 被回收后，由确认窗口的消息或 `chrome.alarms` 唤醒，从 session 存储接着处理；每次被唤醒时先清理已过期的请求并通知页面 `EXPIRED`。

**请求绑定。** 每个待确认请求创建时记录：`origin`、`tabId`、`frameId`、`documentId`、当时的 key_id、该站点的连接版本号（每次连接或断开都递增），以及确认截止时间。

**签名前再检查一次。** 用户点确认后、实际签名前，service worker 重新核对：

1. 当前时间未超过请求的确认截止时间，也未超过解锁截止时间（§7）；
2. 该站点仍处于连接状态，连接版本号与请求记录一致；
3. 插件当前的 key_id 与请求记录一致（重置过就不一致）；
4. 发起请求的文档仍然存在：用 `chrome.tabs.sendMessage` 指定 `documentId` 向原文档发一次确认，失败即视为页面已导航或关闭。

任一项不满足，请求作废并通知确认窗口，不签名。只检查“这个请求曾经获准进入确认窗口”是不够的。

**页面请求与插件内部操作分开授权。** 页面经内容脚本只能调用 §5.2 的四个方法。批准签名、拒绝、解锁、锁定、重置 key、断开站点等内部操作，只接受插件自身页面（工具栏弹窗、确认窗口）发出的消息。判断依据是 `MessageSender.origin` 等于插件自己的 `chrome-extension://<id>` 来源；**不能只看 `sender.id`**，因为内容脚本发出的消息 `sender.id` 也是插件自己的 id。确认请求的 id 只是标识，持有它不代表有权批准。

## 6. 网络

- **发布版**：内置主网参数（WASM `known_network("mainnet")`）。是否另出测试网版本待定。
- **开发版**：构建时从本地开发链服务的 `GET /api/network` 读取参数写入插件，官方域名替换为本地开发地址（`localhost`、`127.0.0.1`，任意端口）。开发版在弹窗和确认窗口醒目标注 DEVNET。
- 任何情况下都不使用页面传入的网络参数。

## 7. 密钥保管

- **生成**：`crypto.getRandomValues` 生成 32 字节，经 WASM 的 `secp256k1_public_key` 检查为合法私钥（不合法时重新生成）。
- **加密**：PBKDF2-HMAC-SHA256，600,000 次迭代（[OWASP 口令存储](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)），每个 keystore 16 字节随机盐，派生 AES-256-GCM 密钥（[WebCrypto deriveKey](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey)）。每次加密使用新的 12 字节随机 IV（包括修改口令时）。AAD 为版本号加公钥，防止密文被换到别的记录上。
- **存储**：`chrome.storage.local` 保存 `{version, kdf: {name, hash, iterations, salt}, cipher: {name, iv}, ciphertext, public_key}`。不保存口令，不保存明文私钥。
- **解锁**：解密后由私钥推出公钥，与记录中的公钥比对。解锁后的私钥存于 `chrome.storage.session`：只在内存中，插件停用、重载、更新或浏览器重启时清空（[Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage)）。访问级别保持默认的 `TRUSTED_CONTEXTS`，只有插件自身上下文能读取，代码中不得调用 `setAccessLevel` 放开给内容脚本。
- **自动锁定**：解锁时在 session 中记录解锁截止时间，用户在插件界面里的每次操作把它往后推（§3.5）。**每次实际签名前比较当前时间与截止时间**，已过期就立即清除私钥并要求重新解锁。`chrome.alarms` 只做辅助清理：alarm 可能延迟触发，电脑休眠恢复后、alarm 还没执行时，私钥不能仍然可用（[Chrome alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms)）。另提供手动锁定。
- **口令**：最短 12 个字符，允许长口令、粘贴和密码管理器，不强制大小写或符号组合；没有找回方式。修改口令时用新盐和新 IV 重新加密。
- **已知限制**：解锁期间，私钥明文在插件进程的内存中，本机恶意软件可以读取。第一版不提供导出和备份。

## 8. 权限与站点

| manifest 项 | 内容 |
|---|---|
| `permissions` | `storage`、`alarms`、`scripting`、`activeTab` |
| `host_permissions` | 官方域名（待定，见下）；配合静态内容脚本自动注入 |
| `optional_host_permissions` | 任意 https 站点，以及本地开发地址 |
| `minimum_chrome_version` | 111（MAIN world 静态内容脚本自 111 起支持） |

`activeTab` 让工具栏弹窗读到当前标签页的来源，否则弹窗拿不到网址，也就无法申请“连接这个网站”；它不会出现在安装提示里。

- **非官方站点**：用户在工具栏弹窗点“连接这个网站”时，插件调用 `chrome.permissions.request` 只申请该来源（必须由插件界面里的用户点击触发），再用 `chrome.scripting.registerContentScripts` 为该来源长期注册注入，并对当前标签页立即注入（[permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)、[scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)）。只接受 https 来源和本地开发地址。
- **注入由 service worker 完成。** Chrome 权限框出现时工具栏弹窗可能被关闭，弹窗里的后续代码就不会执行。所以注册注入、对该来源已打开的标签页立即注入，都由 service worker 监听 `chrome.permissions.onAdded` 完成。弹窗仍开着时，再把该站点记为已连接；弹窗已关闭，或用户是从 Chrome 自己的站点访问菜单授予的权限，则只完成注入，连接仍须页面调用 `connect()` 并经确认窗口同意。
- **安装提示**：只列出官方域名，不出现“读取和更改所有网站上的数据”。
- **官方域名必须在首次上架 Chrome 网上应用店之前确定。** 更新时新增会触发警告的权限，Chrome 会先停用插件，直到用户同意新权限（[权限警告](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings)）。有多个官方域名（例如主站和备用站）时，应在第一版一并写入。确定之前，manifest 中保留占位，发布前必须替换。

**自托管站点的说明**在插件实现时写入 [15：运维手册](15-operations.md)，内容为：访问者如何通过工具栏连接站点、Chrome 权限框的含义、如何断开，以及开发版插件与本地开发链的配合。

## 9. 仓库结构与构建

单仓库，在根目录新增 `extension/`，与 `web/`、`verifier-ts/` 并列：

```
extension/
  manifest.json        MV3；官方域名占位
  src/background.ts    service worker：keystore、站点连接、请求校验、签名
  src/content.ts       ISOLATED world：页面与 service worker 之间转发
  src/inpage.ts        MAIN world：window.omavote
  src/keystore.ts      口令派生与加解密
  src/requests.ts      结构化请求校验（调用 WASM）
  src/ui/              工具栏弹窗（解锁、连接本站、已连接站点、key 信息、重置）与确认窗口
  src/wasm/pkg/        omavote-wasm 构建产物，不入库（与 web 相同）
  test/
  package.json
```

- 工具链沿用 web：TypeScript 加 Vite 多入口构建，`npm run wasm` 用 wasm-pack 生成核心。界面很小，先用原生 DOM，不引入框架。
- 插件页面的 CSP 需要 `'wasm-unsafe-eval'` 才能加载 WASM；不加载任何远程代码。
- 界面提供英文和中文，与 web 一致。
- `scripts/ci.sh` 增加插件的类型检查、单元测试与构建。

## 10. 前端改动（`web/`）

前端现在只完整支持 EVM key 的代理投票，以下几处都要改，不只是新增一个签名函数：

1. **发现与连接**：检测 `window.omavote` 和 `omavote:ready`；钱包选择处在 EIP-6963 钱包之外增加“Omavote 插件”。连接状态管理参照 `web/src/app/wallet.tsx`。
2. **代理投票组件**：`web/src/components/vote.tsx` 的 `DelegateVote` 目前用 MetaMask 地址构造 EVM key（`core.evmKey`），并在多处写死 `ADAPTER_EVM`。改为从当前连接的签名来源取得 key descriptor：MetaMask 仍是 `evm_eoa`，插件是 `secp256k1`；adapter 取自 descriptor，不写死。每个提案是否接受该 key adapter，按其 manifest 的 `auth_registry.key_adapters` 检查，不接受时说明原因，不发起签名。
3. **签名分支**：现有 `Signer` 只接收文本（`web/src/lib/flow.ts` 的 `walletSigner`）。新增插件签名器，接收 manifest 与选票 body，一次把同一提案的多张票交给 `signBallots`，超过 20 张时按 20 张一批分批请求。返回的签名照常经现有验签步骤后再提交。收到 `ANCHOR_REUSED` 时，等出新块后重新生成选票。
4. **GRANT 表单**：新增“使用已连接插件的 key”，自动填入 descriptor。
5. **恢复**：“换新 key 并撤回旧票”流程接入插件的新 key（§3.7）。
6. **连接提示**：页面不在官方域名下、又没有检测到插件时，在连接区显示：“点浏览器右上角的 Omavote 图标连接本站。已安装插件但仍看不到时，可能是本站尚未授权。”

## 11. 核心改动（`crates/omavote-wasm`）

新增 `ckb_sign_message` 与 `secp256k1_public_key` 两个方法，供插件生成 key 和签名（§2.3）。两者只包装核心已有函数，不改变任何验签规则。服务端的 `POST /api/core/{method}` 把 WASM 方法开放给命令行客户端，这两个需要私钥的方法在那里一律拒绝，不能让任何人习惯把私钥发给服务器。

## 12. 测试与验收

- **单元测试**：
  - 请求校验的正反例：错误网络、OWNER 票、他人 key、非法 action、manifest 与 `poll_id` 不符、一次请求混合多个提案或选择、超出数量上限、额外字段与超长输入；
  - keystore：往返、错误口令、篡改密文或 AAD、参数版本；
  - 签名：用已知私钥签名后经 `verify_key` 通过，并与 `vectors/signatures.json` 中的 CKB 消息摘要与签名一致。
- **安全边界的失败场景**（比正常流程更能验证边界）：
  - 网页伪造批准、解锁、重置等内部消息，一律被拒；
  - 断开站点后，点击仍开着的旧确认窗口，不签名；
  - 重置 key 后批准旧请求，不签名；
  - alarm 尚未触发但解锁截止时间已过，尝试签名时要求重新解锁；
  - 确认时限已过、发起请求的页面已导航或关闭后再确认，不签名；
  - iframe 内或非 `active` 文档发起的请求被拒；超出字节上限的请求在解析前被拒；
  - 请求一张与已签票同锚点、内容不同的票，被拒（`ANCHOR_REUSED`）；同一张票重签得到相同签名；
  - 确认窗口打开后、service worker 被回收再唤醒，用户确认后结果仍送回原页面；
  - 确认窗口刚获得焦点时点击确认无效。
- **开发链端到端**：在 `deploy/devnet/run-e2e.sh` 中增加插件场景。Playwright 用持久上下文加载未打包的开发版插件，依次完成：创建 key、在本地站点连接、owner A 用 Neuron 方式签 GRANT、在插件确认窗口批量签票并计入；重置 key，签带撤回的 GRANT，确认旧代理票被排除、新票计入。
- **逐浏览器人工验收**：Chrome、Brave、Edge、Arc 分别验证安装提示、官方域名一键连接、非官方站点工具栏连接、确认窗口、锁定与解锁、浏览器重启、断开。按 [17](17-external-acceptance.md) 的模板记录。
- **评审重点**（补入 [12](12-review-guide.md)）：消息校验与来源处理、session 存储的访问级别、CSP、确认窗口能否被页面影响。

## 13. 待定事项

| 事项 | 当前建议 |
|---|---|
| 官方域名 | 由团队确定，必须在首次上架前写入 |
| 口令最短长度 | 12 个字符，允许粘贴和密码管理器，不强制字符组合（已写入 §7） |
| 自动锁定时间 | 空闲 15 分钟，按截止时间检查（已写入 §7） |
| 一次确认可签的选票数上限 | 20 张，另有请求字节上限（§4） |
| 非官方站点的连接提示 | 加（已写入 §10 第 6 项） |
| 测试网发布版 | 视社区测试需要 |
| Firefox | 第一版之后 |
| 多设备（导出 key，或每台设备一把 key） | 第一版之后；受 §2.2 一 owner 一把 key 的约束 |
