# dsh-im-tools

给 **DeepSeek Harness (DSH)** agent 的 IM 主动投递工具。装上之后，agent 可以在**任何会话**里
（网页、CLI、定时任务）直接往你的微信 / 飞书 / 企微 / 钉钉 / QQ / Telegram 等推送文字或文件，
不需要先绑定会话，也不用拼 `curl`。

配套插件是 [`@xmanrui/dsh-im`](https://github.com/xmanrui/dsh-im)。本仓库是**独立插件**，不 fork、
不修改上游代码；文件投递也不再依赖任何 dsh-im 源码补丁。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `im_targets` | 列出本机已配置的主动投递目标（渠道 / targetId / 名称 / botId） |
| `im_send_text` | 主动发送一条文字；`format` 支持 `plain` / `markdown` |
| `im_send_file` | 主动发送本地文件（绝对路径，≤ 30 MB，图片自动走图片消息）；飞书目标直连开放平台，其它渠道需上游支持 |

目标解析顺序：工具参数 → 环境变量 `DSH_IM_BOT_ID` / `DSH_IM_TARGET_ID` → 本机唯一目标。
只有一个目标时可以全部省略。

### 微信额度熔断（默认开启）

微信会对同一会话的连续主动推送做限制：约 10 条之后开始返回 `prepare failed`
（见 [xmanrui/dsh-im#151](https://github.com/xmanrui/dsh-im/issues/151)），且只有用户再给机器人
发一条消息才会恢复。本插件在发送前就拦截：

- 默认每个目标**自上次用户消息以来最多 8 条**（`DSH_IM_PROACTIVE_LIMIT` 可调）；
- 计数不只看本工具：还会读取 dsh-im 写到 `state.json` 的 `recentOutboundMessages`，
  把**双向同步**（`[来自 DSH]` / `[DSH 助手]`）和助手回复算进去，取两者较大值；
  因此网页聊天开着同步时，额度会消耗得更快，`im_targets` 会如实显示；
- **连续 2 次发送失败**即熔断，避免继续撞限制；
- 恢复方式：用户给机器人发任意一条消息（插件通过 `state.json` 里
  `contextTokens.users[].receivedAt` 检测到新消息后自动重置）；
- 额度/熔断状态记录在 `$DSH_HOME/dsh-im-tools/quota.json`，`im_targets` 会显示
  `sent/limit` 与是否 `BLOCKED`；
- 超限返回 `im-quota-exhausted`，熔断返回 `im-quota-blocked`，消息里会写明原因。
- 其它渠道（飞书/企微/Telegram 等）不套用这个额度。

## 安装

```bash
dsh plugin --profile web add dsh-im-tools
```

本地开发（不发布）：

```bash
dsh plugin --profile web add link:/absolute/path/to/dsh-im-tools
```

装完重启 `dsh web`。**新建一个会话**后工具才会出现在 agent 的工具清单里（长会话的工具清单是
会话建立时固定的，不会热更新）。

## 前置条件

1. 已装并连接 `@xmanrui/dsh-im`，且在「设置 → IM机器人 → 主动投递」里保存了至少一个目标；
2. DSH Web 在跑（默认 `http://127.0.0.1:3080`，可用 `DSH_WEB_URL` 覆盖）。

### 关于文件投递（v0.2.0 起：飞书直连，无需补丁）

- **文字**走上游自带的 `POST /api/dsh-im/delivery/messages`，不需要任何补丁；
- **文件**分两条路：
  - **飞书目标 → 直连飞书开放平台**（本插件自己发，不经过 dsh-im）：
    `tenant_access_token/internal` → `im/v1/files`（图片走 `im/v1/images`）→ `im/v1/messages`。
    所以 dsh-im 可以随便跟着上游升级，`im_send_file` 不会失效，也不需要
    [dsh-im-hold](https://github.com/weiza0v0/dsh-im-hold) 这类源码补丁。
    私聊目标用 `open_id`，群聊目标用 `chat_id`，取自
    `$DSH_HOME/integrations/dsh-feishu/workspaces.json` 的 `deliveryTargets`；
    app secret 取自 `$DSH_HOME/.credentials.yaml` 的 `refs:` 段（键名 = 机器人 `secretRef`），
    也可用同名环境变量覆盖。
  - **其它渠道 → 上游 `POST /api/dsh-im/delivery/files`**：上游从来没提供这个接口，
    所以现在会返回 `im-file-unsupported`。要发文件请选飞书目标，或把文件作为回合回复发出。

飞书直连自带的安全阀：必须是绝对路径的普通文件、拒绝符号链接、≤ 30 MB、
拒发 `.credentials.yaml` / `id_rsa*` / `.env` / `server-credentials.json` 以及
`.ssh` `.aws` `.kube` `.gnupg` `.docker` 目录下的文件。

## 无模型推送（CLI，0 token）

定时任务、构建脚本、cron 不需要经过 agent，直接调用：

```bash
dsh-im-send targets                         # 看目标与额度（--json 可机读）
dsh-im-send text "构建完成"                  # 发文字
dsh-im-send text "**报告**" --format markdown
dsh-im-send file /abs/path/report.pdf        # 发文件
dsh-im-send text "hi" --target tgt_xxx --bot wx_xxx
```

- 不创建会话、不调用模型，因此**不消耗 token**；
- 与工具共用同一份额度记录（`$DSH_HOME/dsh-im-tools/quota.json`）；
- 退出码：`0` 成功，`1` 出错，`2` 额度用尽/熔断，`3` 渠道投递失败；
- 额度用尽时可用 `--notify-target <target>`（或 `DSH_IM_NOTIFY_TARGET`）把固定提示发到**另一个渠道**
  （例如飞书群），因为此时微信本身已经发不出去；
- 适合写成：

```cron
*/30 * * * * DSH_HOME=$HOME/.dsh node /path/to/dsh-im-tools/bin/dsh-im-send.mjs text "定时报告" >> /tmp/dsh-im-send.log 2>&1
```

```bash
# systemd timer / 脚本里按退出码处理
if ! node bin/dsh-im-send.mjs text "完成"; then
  [ $? -eq 2 ] && echo "微信额度用尽，需要用户回一句话" | mail -s alert you@example.com
fi
```

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_HOME` | `~/.dsh` | 从这里读取 `integrations/*/workspaces.json` 里的投递目标 |
| `DSH_WEB_URL` | `http://127.0.0.1:3080` | DSH Web 地址 |
| `DSH_IM_BOT_ID` | — | 多目标时的默认 botId |
| `DSH_IM_TARGET_ID` | — | 多目标时的默认 targetId |

## 常见问题

- **`502 delivery-failed` / iLink `{"ret":-2,"errmsg":"prepare failed"}`**：这是微信侧的限制，不是插件问题。
  连续给机器人主动发送约 10 条消息后会被拒绝，需要**用户先给机器人发一条消息**（或机器人自身发消息）才能重新激活。
  上游相关讨论：<https://github.com/xmanrui/dsh-im/issues/151>。自动化场景请控制频率、避免连续重试。
- **工具看不到**：重启 `dsh web` 后，新建一个会话即可；长会话的工具清单不会热更新。
- **`im-file-unsupported`（`im_send_file`）**：目标不是飞书。上游 dsh-im 只支持主动投递文字，
  文件投递目前只有「飞书直连」这一条路；把目标换成飞书私聊/群聊即可。
- **`im-feishu-permission`**：飞书应用缺发消息/发文件权限（`99991663` / `99991664`），
  去开放平台补 `im:message:send_as_bot` 等权限并发布版本。

## 安全提示

- 依赖的两个 HTTP 接口**没有鉴权、也没有 CORS**，只应在本机使用，不要把 3080 暴露到公网；
- `im_send_file` 接受任意**本地绝对路径**（≤ 30 MB），并已内置拒发凭据/私钥类文件与敏感目录
  （见上文）；如果你的环境不可信，可以再加目录白名单，或只把工具提供给可信 agent。
- 飞书直连不会新建无鉴权的 HTTP 端点：文件只在进程内读取后上传，不需要把本机端口暴露出去。

## 工作原理

插件在 `apply()` 里通过 `ctx.inject(['tools'])` 注册三个工具；工具的 `execute` 读取
`~/.dsh/integrations/*/workspaces.json` 找到投递目标，再 `POST` 到 DSH Web 的 delivery 接口。
它不依赖当前会话绑定，也不经过模型上下文之外的任何东西。

## 开发

```bash
npm test        # node --test，使用本地 mock HTTP 服务
```

## License

MIT。与 `@xmanrui/dsh-im`（MIT）无隶属关系，仅作为其投递能力的补充。
