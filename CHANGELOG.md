# Changelog

## 0.2.0 — 2026-11-20

### 新增
- **飞书文件投递直连开放平台**：新增 `lib/feishu-direct.mjs`
  （`tenant_access_token` → `im/v1/files` 或 `im/v1/images` → `im/v1/messages`），
  `im_send_file` 遇到飞书目标直接走这条通道，不再需要给 `@xmanrui/dsh-im` 打
  `delivery/files` 源码补丁。私聊目标用 `open_id`，群聊目标用 `chat_id`。
- 抽出 `deliverFile(target, path)`，工具与 `dsh-im-send file` CLI 共用同一套校验与分发。
- 文件安全阀：绝对路径、普通文件、拒绝符号链接、≤ 30 MB、拒发
  `.credentials.yaml` / `id_rsa*` / `.env` / `server-credentials.json`，以及
  `.ssh` `.aws` `.kube` `.gnupg` `.docker` 目录下的文件。
- `test/feishu.test.mjs`：直连上传、图片走图片接口、群聊 `chat_id`、敏感文件拒发、API 错误映射。

### 变更
- `im_send_file` 对非飞书渠道保留上游 `delivery/files` 兜底；该接口缺失时返回
  `im-file-unsupported`（以前是含糊的 `http-401` / `http-404`）。
- 飞书权限错误（`99991663` / `99991664`）单独映射为 `im-feishu-permission`。
- README 去掉「必须打 dsh-im-hold 补丁」的说法。

## 0.1.0 — 2026-10-18

- 首个版本：`im_targets` / `im_send_text` / `im_send_file`，微信额度熔断，
  `dsh-im-send` CLI（0 token 推送）。
