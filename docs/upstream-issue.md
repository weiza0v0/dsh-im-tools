# 上游 issue 草稿（xmanrui/dsh-im）

> 用途：先发 issue 探路，再决定是否提 PR。中文为主，末尾附英文摘要。

## 标题

`[Feature] /hold：把图片+文字合成一次输入（暂存），以及主动投递文件接口`

## 正文

**背景**

微信个人号协议里图片和文字是两条消息。现在图片单独到达时，插件会用固定提示「请分析这张图片。」
立刻发起一个回合；用户想补一句要求时，那一轮已经跑起来了，结果是「发图 + 说明」永远变成两轮，
第一轮常常答非所问。上游 `/batch` 只收纯文字，媒体不参与收集。

**提议 1：`/hold` 暂存（私聊）**

- `/hold` 进入暂存：文字、图片、文件都只收集、不执行；
- `/send` 合成一条提交：文字按顺序拼成 `[消息 N]`，图片/文件作为附件挂到同一条消息；
- `/cancel` 丢弃；提交失败保留内容可重试；
- 上限 10 项（图片合计 ≤ 20、文件合计 ≤ 10），防止撑爆宿主附件限制；
- 暂存期间图片立即开始下载，规避 iLink/企微/QQ 等短时效媒体链接；
- 复用现有 `BatchInputManager` 状态机，扩展 `mode: 'batch' | 'hold'`，条目从 `string[]` 变为
  `{ text?, images?, files? }`。

影响面（参考实现）：`batch-input.mjs`、共享文本桥、微信/飞书/企微/企微应用/钉钉/QQ 六个桥的
批处理入口（把归一化后的 `images/files` 交给收集器，提交时用 `preparedMessage` 挂回附件）、
命令目录与英文翻译。

**提议 2：文件主动投递接口**

```
POST /api/dsh-im/delivery/files
{"botId":"...","targetId":"...","path":"/absolute/path/file.pdf"}
→ {"sent":true,"fileName":"file.pdf"}
```

- 只收绝对路径，必须是普通文件，≤ 30 MB；按扩展名选择 `sendImage` / `sendFile`；
- 各渠道新增 `sendProactiveFile`（controller → runtime → 渠道原语），复用回合内附件回传的发送函数；
- 鉴权沿用现状（无鉴权、仅本机），文档里明确风险；如果需要，也可以加「仅允许工作区目录」的白名单。

影响面：`delivery-service/rpc/http`、`delivery-adapter`、各渠道 controller/runtime。

**想请教**

1. 这两个方向是否愿意接收？如果愿意，我们按 5.1.0（当前最新）rebase 后拆成两个 PR；
2. `/hold` 是否应该直接扩展 `/batch`（我们现在的做法），还是你们更希望独立命令/独立状态；
3. 文件接口的路径安全边界，你们倾向「任意绝对路径」还是「限定工作区/白名单」；
4. 如果你们打算自己实现，我们也可以只提供设计说明和测试用例。

**现状**

我们有可运行实现（本地补丁 + 独立工具插件），已在微信上验证：
`/hold` 一次提交 2 条文字 + 1 张图 + 1 个文件成功；文件投递接口发送 PDF/图片成功。
需要的话可以提供 diff、测试与演示。

---

**English summary**

Two proposals: (1) `/hold`, a media-aware sibling of `/batch` that collects text, images and files
and submits them as one turn (fixes the WeChat "image and text arrive separately" problem);
(2) `POST /api/dsh-im/delivery/files` for proactive file delivery, reusing the per-channel artifact
senders. We have a working implementation and tests, and are happy to rebase onto the latest release
and split it into two PRs. Questions: would you accept these directions; should `/hold` extend `/batch`;
and what path allowlist do you prefer for file delivery?
