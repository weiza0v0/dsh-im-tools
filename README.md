# dsh-im-tools

给 **DeepSeek Harness (DSH)** agent 的 IM 主动投递工具。装上之后，agent 可以在**任何会话**里
（网页、CLI、定时任务）直接往你的微信 / 飞书 / 企微 / 钉钉 / QQ / Telegram 等推送文字或文件，
不需要先绑定会话，也不用拼 `curl`。

配套插件是 [`@xmanrui/dsh-im`](https://github.com/xmanrui/dsh-im)。本仓库是**独立插件**，不 fork、
不修改上游代码。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `im_targets` | 列出本机已配置的主动投递目标（渠道 / targetId / 名称 / botId） |
| `im_send_text` | 主动发送一条文字；`format` 支持 `plain` / `markdown` |
| `im_send_file` | 主动发送本地文件（绝对路径，≤ 30 MB，图片自动走图片消息） |

目标解析顺序：工具参数 → 环境变量 `DSH_IM_BOT_ID` / `DSH_IM_TARGET_ID` → 本机唯一目标。
只有一个目标时可以全部省略。

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

### 关于文件投递

- 文字走上游自带的 `POST /api/dsh-im/delivery/messages`；
- 文件走 `POST /api/dsh-im/delivery/files`，这是**配套补丁**提供的接口（上游目前只支持文字）：
  [weiza0v0/dsh-im-hold](https://github.com/weiza0v0/dsh-im-hold)（对应上游 issue
  [#385](https://github.com/xmanrui/dsh-im/issues/385)）。在上游合并前，需要给 dsh-im 打上该补丁
  才能用 `im_send_file`；没有该接口时工具会返回 `http-404` / `http-401`。

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_HOME` | `~/.dsh` | 从这里读取 `integrations/*/workspaces.json` 里的投递目标 |
| `DSH_WEB_URL` | `http://127.0.0.1:3080` | DSH Web 地址 |
| `DSH_IM_BOT_ID` | — | 多目标时的默认 botId |
| `DSH_IM_TARGET_ID` | — | 多目标时的默认 targetId |

## 安全提示

- 依赖的两个 HTTP 接口**没有鉴权、也没有 CORS**，只应在本机使用，不要把 3080 暴露到公网；
- `im_send_file` 接受任意**本地绝对路径**（≤ 30 MB）。如果你的环境不可信，请在插件侧加目录白名单，
  或只把工具提供给可信 agent。

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
