// English and Chinese strings for the popup and the confirmation window. English is
// the default, as in the web app; the choice is remembered in storage.local.

const en = {
  "app.name": "Omavote Signer",
  "app.devnet": "DEVNET",
  "app.devnetNote": "Development build for a local chain. Never use it for real votes.",
  "lang.switch": "中文",

  "create.title": "Create your voting key",
  "create.intro": "This extension holds one voting key and signs only Omavote delegate ballots.",
  "create.noTransfer": "It cannot transfer assets. The key's CKB address is only for checking your voting identity: do not send any assets to it. The key is an ordinary secp256k1 key, and assets sent to its address would be hard to recover once the key is reset.",
  "create.noBackup": "There is no backup in this version. If you lose this computer or forget the password, reset and authorize a new key with Neuron.",
  "create.password": "Password (at least 12 characters)",
  "create.confirm": "Repeat the password",
  "create.mismatch": "The passwords differ.",
  "create.short": "At least 12 characters.",
  "create.submit": "Create key",

  "unlock.title": "Unlocked for signing",
  "unlock.locked": "Locked",
  "unlock.password": "Password",
  "unlock.submit": "Unlock",
  "unlock.lock": "Lock now",
  "unlock.note": "Locks after 15 minutes without activity in this extension.",

  "key.title": "Voting key",
  "key.address": "CKB address of the key (do not send assets)",
  "key.copy": "Copy",
  "key.copied": "Copied",

  "site.current": "This site",
  "site.unsupported": "Only https sites and local development addresses can be connected.",
  "site.official": "Official site",
  "site.connected": "Connected",
  "site.notConnected": "Not connected",
  "site.connect": "Connect this site",
  "site.connectNote": "Chrome will ask to allow access to this site. The site then sees your key's public address and can ask you to sign ballots; every signature needs your confirmation.",
  "site.officialConnectNote": "Open the voting page and press Connect there.",
  "site.disconnect": "Disconnect",
  "sites.title": "Connected sites",
  "sites.none": "No site is connected.",

  "settings.title": "Settings",
  "settings.changePassword": "Change password",
  "settings.oldPassword": "Current password",
  "settings.newPassword": "New password",
  "settings.save": "Save",
  "settings.saved": "Password changed.",
  "settings.reset": "Reset key",
  "settings.resetWarn": "Resetting deletes this key for good and disconnects every site. To vote again, authorize the new key with Neuron (on the voting page: \"new key, cancel old ballots\"). Assets sent to the old address would be very hard to recover.",
  "settings.resetAck": "I understand that the current key will be deleted.",
  "settings.resetConfirm": "Delete the key",

  "confirm.connectTitle": "Connect to this site?",
  "confirm.connectText": "The site will see your voting key's address. It cannot sign anything without your confirmation.",
  "confirm.signTitle": "Sign delegate ballots",
  "confirm.from": "Request from",
  "confirm.unofficial": "Not the official site",
  "confirm.key": "Voting key",
  "confirm.proposal": "Proposal",
  "confirm.choice": "Choice",
  "confirm.owners": "For {n} address(es)",
  "confirm.ownersNote": "Check that every address below is one you mean to vote for.",
  "confirm.fullText": "Full text of the ballot for {owner}",
  "confirm.checkForum": "Compare the # number with the proposal on the forum.",
  "confirm.approve": "Sign {n} ballot(s)",
  "confirm.approveConnect": "Connect",
  "confirm.reject": "Reject",
  "confirm.expires": "Expires in {s} s",
  "confirm.needKey": "Create a voting key first.",
  "confirm.unlockFirst": "Unlock to sign.",
  "confirm.done": "Done. You can close this window.",
  "confirm.gone": "This request is no longer waiting.",

  "choice.YES": "YES (Approve)",
  "choice.NO": "NO (Reject)",
  "choice.CANCEL": "CANCEL (Withdraw vote)",

  "error.WRONG_PASSWORD": "Wrong password.",
  "error.LOCKED": "Unlock the extension first.",
  "error.EXPIRED": "This request expired or the page was closed.",
  "error.NOT_CONNECTED": "The site is no longer connected, or the key changed.",
  "error.ANCHOR_REUSED": "A different ballot was already signed on this block. Let the page prepare the ballots again.",
  "error.other": "Error: {message}",
};

export type Key = keyof typeof en;

const zh: Record<Key, string> = {
  "app.name": "Omavote 签名插件",
  "app.devnet": "开发链",
  "app.devnetNote": "本地开发链专用的开发版，切勿用于真实投票。",
  "lang.switch": "English",

  "create.title": "创建投票 key",
  "create.intro": "本插件只保管一把投票 key，只签 Omavote 代理选票。",
  "create.noTransfer": "本插件不能转账。这把 key 的 CKB 地址只用于核对投票身份，请勿转入任何资产。它是一把普通的 secp256k1 私钥，重置之后，误转入该地址的资产将很难取回。",
  "create.noBackup": "本版本没有备份。丢失电脑或忘记口令时，请重置并用 Neuron 重新授权新 key。",
  "create.password": "口令（至少 12 个字符）",
  "create.confirm": "再输入一次口令",
  "create.mismatch": "两次输入的口令不同。",
  "create.short": "至少 12 个字符。",
  "create.submit": "创建 key",

  "unlock.title": "已解锁，可以签名",
  "unlock.locked": "已锁定",
  "unlock.password": "口令",
  "unlock.submit": "解锁",
  "unlock.lock": "立即锁定",
  "unlock.note": "在本插件中 15 分钟无操作后自动锁定。",

  "key.title": "投票 key",
  "key.address": "key 的 CKB 地址（请勿转入资产）",
  "key.copy": "复制",
  "key.copied": "已复制",

  "site.current": "当前网站",
  "site.unsupported": "只能连接 https 网站和本地开发地址。",
  "site.official": "官方网站",
  "site.connected": "已连接",
  "site.notConnected": "未连接",
  "site.connect": "连接这个网站",
  "site.connectNote": "Chrome 会询问是否允许访问该网站。连接后，网站能看到你的 key 地址，并可请求你签署选票；每次签名都需要你确认。",
  "site.officialConnectNote": "打开投票页面，在页面里点“连接”。",
  "site.disconnect": "断开",
  "sites.title": "已连接的网站",
  "sites.none": "尚未连接任何网站。",

  "settings.title": "设置",
  "settings.changePassword": "修改口令",
  "settings.oldPassword": "当前口令",
  "settings.newPassword": "新口令",
  "settings.save": "保存",
  "settings.saved": "口令已修改。",
  "settings.reset": "重置 key",
  "settings.resetWarn": "重置会永久删除这把 key，并断开所有网站。要继续投票，须用 Neuron 授权新 key（在投票页面选择“换新 key 并撤回旧票”）。误转入旧地址的资产将很难取回。",
  "settings.resetAck": "我明白当前的 key 将被删除。",
  "settings.resetConfirm": "删除 key",

  "confirm.connectTitle": "连接这个网站？",
  "confirm.connectText": "网站将看到你的投票 key 地址。没有你的确认，它不能签任何内容。",
  "confirm.signTitle": "签署代理选票",
  "confirm.from": "请求来源",
  "confirm.unofficial": "不是官方网站",
  "confirm.key": "投票 key",
  "confirm.proposal": "提案",
  "confirm.choice": "选择",
  "confirm.owners": "为 {n} 个地址投票",
  "confirm.ownersNote": "请确认下面每个地址都是你这次想代表的。",
  "confirm.fullText": "{owner} 的选票全文",
  "confirm.checkForum": "请对照论坛上的提案核对 # 编号。",
  "confirm.approve": "签署 {n} 张选票",
  "confirm.approveConnect": "连接",
  "confirm.reject": "拒绝",
  "confirm.expires": "{s} 秒后失效",
  "confirm.needKey": "请先创建投票 key。",
  "confirm.unlockFirst": "解锁后才能签名。",
  "confirm.done": "已完成，可以关闭此窗口。",
  "confirm.gone": "这个请求已不再等待确认。",

  "choice.YES": "YES（赞成）",
  "choice.NO": "NO（反对）",
  "choice.CANCEL": "CANCEL（撤回投票）",

  "error.WRONG_PASSWORD": "口令错误。",
  "error.LOCKED": "请先解锁插件。",
  "error.EXPIRED": "请求已失效，或发起请求的页面已关闭。",
  "error.NOT_CONNECTED": "网站已断开，或 key 已更换。",
  "error.ANCHOR_REUSED": "这个区块上已经签过另一张票。请让页面重新生成选票。",
  "error.other": "错误：{message}",
};

export type Lang = "en" | "zh";
const dicts: Record<Lang, Record<Key, string>> = { en, zh };
let lang: Lang = "en";

export async function loadLang(): Promise<Lang> {
  try {
    const v = (await chrome.storage.local.get("lang")).lang;
    lang = v === "zh" || v === "en" ? v : navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
  } catch {
    lang = "en";
  }
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  return lang;
}

export async function toggleLang(): Promise<void> {
  lang = lang === "en" ? "zh" : "en";
  await chrome.storage.local.set({ lang });
}

export function t(key: Key, vars: Record<string, string | number> = {}): string {
  return dicts[lang][key].replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}

export const dictionaries = dicts;
