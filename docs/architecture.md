# 结构与数据流

## 一次下载的完整链路

```
浏览器
  │  POST /api/resolve {text|urls, lang}
  ▼
server.js ──► lib/x2.js resolve()
  │              ├─ POST https://x2twitter.com/api/userverify {url}      → token（绑定链接+出口 IP，约 5 分钟）
  │              ├─ POST https://x2twitter.com/api/ajaxSearch {q,lang,cftoken} → {status:"ok", data:"<html>"}
  │              └─ parseResultHtml()
  │                    ├─ 文案（h3）、时长、推文 ID（input#TwitterId）、缩略图
  │                    └─ 下载按钮 → dl.snapcdn.app/get?token=<JWT> → 解 JWT 得 {url, filename}
  ▼
前端渲染候选（视频/图片/封面 + 画质）
  │  POST /api/download {tweet, items[], saveCover}
  ▼
server.js 建 job → 队列（并发 = settings.concurrency）
  ▼
lib/downloader.js downloadItem()
  │  1 CDN 直连 → 2 CDN+代理 → 3 网关 → 4 网关+代理
  │  写 xxx.mp4.part → rename() 原子落盘（重名按设置追加 _1 / 跳过 / 覆盖）
  ▼
lib/store.js               写 library.jsonl 一行 + 目录内 meta.json
  ▼
前端轮询 GET /api/job?id= → 进度（received/total、当前线路）→ 完成后刷新资源库
```

## 模块

| 文件 | 职责 | 不做什么 |
| --- | --- | --- |
| `server.js` | HTTP 路由、静态托管、任务队列、Range 流式读文件 | 不实现解析细节 |
| `lib/x2.js` | 链接规范化、调两条接口、解析 HTML 片段、JWT 解码、限流冷却与结果缓存 | 不碰磁盘 |
| `lib/net.js` | `requestText` / `requestStream`、跳转、超时、HTTP 代理 CONNECT 隧道 | 不认识 x2twitter |
| `lib/downloader.js` | 四线路回退、`.part` 原子写、封面、MIME | 不管索引 |
| `lib/store.js` | 设置读写、目录与文件名规范化、越界校验、资源库 JSONL | 不发请求 |

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 版本、端口、设置、统计、目录 |
| POST | `/api/settings` | 改设置（root / folderTemplate / lang / concurrency / conflict / proxy / saveCover） |
| POST | `/api/resolve` | `{text}` 或 `{urls:[]}` → 每条推文的媒体列表 |
| POST | `/api/download` | `{tweet, items[], saveCover}` → job |
| GET | `/api/job?id=` | 任务快照（含每项状态、字节、线路、错误） |
| GET | `/api/jobs` | 最近 20 个任务 |
| GET | `/api/library?q=&limit=` | 资源库 + 统计 |
| GET | `/api/file?id=&dl=1` | 原文件，支持 `Range`（视频拖动） |
| GET | `/api/thumb?id=` | 预览图：下载时存的 `.poster.jpg` → 图片自身 → 同目录 `cover.jpg` → ffmpeg 现抽一帧（缓存）→ 回查推文封面（缓存） |
| POST | `/api/item/delete` | `{id, withFile}` |
| GET | `/api/diagnose` | 解析接口 / CDN / 网关 / 写权限 / 代理 / 运行时 |
| GET | `/api/log?lines=` | `info.log` 末尾若干行 |
| GET | `/healthz` | 存活探测 |

## 进度上报

任务状态只存在内存里，前端每 700ms 拉一次 `/api/job`：

| 字段 | 含义 | 用途 |
| --- | --- | --- |
| `items[].received` / `items[].total` | 单文件已收字节 / `Content-Length` | 单文件进度条、`92%` 文本 |
| `bytesReceived` / `bytesTotal` | 所有条目求和 | 推文级总进度条（按字节，不按条目） |
| `startedAt` / `finishedAt` | 开始 / 结束时间 | 完成后的「用时」 |
| `status` | `queued` / `running` / `done` / `failed` | 排队中 / 下载中 / 收尾中 / 完成 |

速度与剩余时间不由服务器上报：前端用相邻两次轮询的增量算瞬时速度（指数平滑 `0.6·旧 + 0.4·新`），`ETA = 剩余字节 / 速度`。`Content-Length` 还没到或走分块传输时 `total=0`，进度条切到流光的 `is-indeterminate` 样式。

## 数据文件

`settings.json`

```json
{
  "root": "/vol1/1000/media/x2media",
  "folderTemplate": "{user}/{tweetId}",
  "lang": "zh_cn",
  "concurrency": 2,
  "saveCover": false,
  "proxy": "",
  "autoBestQuality": true,
  "conflict": "rename"
}
```

`library.jsonl`（一行一条，追加写；删除时整体重写）

```json
{"id":"9f2c…","tweetId":"1840…","user":"tester","tweetUrl":"https://x.com/tester/status/1840…","caption":"…","kind":"video","quality":1080,"ext":".mp4","relPath":"tester/1840…/X2Twitter.com_1080p.mp4","size":8123456,"mime":"video/mp4","sourceUrl":"https://video.twimg.com/…","createdAt":"2026-11-16T10:00:00.000Z"}
```

`<下载目录>/<作者>/<推文ID>/meta.json`：这条推文的原文、文案、这次保存了哪些文件，脱离应用也能看懂。

## 预览图（poster）

视频没有内嵌缩略图，所以下载完成后顺手配一张，落在视频旁边：`X2Twitter.com_xxx_1280p.poster.jpg`。

1. 下载时：用解析结果里的推文缩略图（`pbs.twimg.com`，走和媒体一样的直连 / 代理两跳）落成 `.poster.jpg`；失败且有 ffmpeg 就本地抽第 1 秒的一帧（`scale=720:-2`），缓存下来不再重复跑。
2. 老记录（升级前下载的）：请求 `/api/thumb` 时按 `ffmpeg` → 回解析接口取推文缩略图 的顺序补，补完写回磁盘，只补一次。
3. 都没有就返回 404，前端退化成 ▶ 占位符，不影响列表。

`ffmpeg` 不是必需依赖：找不到就只用推文缩略图这条线（`X2_FFMPEG` 可指定路径）。

## 限流（Cloudflare 1015）

`/api/userverify` 按 IP 限流，超限时返回 `HTTP 429 + "error code: 1015"` 并带 `Retry-After`（实测常见 2041 秒，被截到 30 分钟上限）。实测 `/api/ajaxSearch` 并不校验令牌（`cftoken` 传空串也返回完整结果），因此解析默认走**匿名搜索**，`userverify` 降级成兜底：只有搜索接口返回 401/403 或消息里提到 token 时才去取令牌。这样每次解析只有 1 次请求，也不会平白撞上 1015。

`lib/x2.js` 的处理：

| 环节 | 行为 |
| --- | --- |
| 匿名优先 | 先 `search(url, '', lang)`；抛 `code=token` 才 `fetchToken` 后重试 |
| 识别 | `status === 429` 或响应体匹配 `error code: 1015` / `1011` / `rate limited` → `x2Error('ratelimit')`，`detail` 是剩余秒数 |
| 冷却 | 记 `cooldownUntil`，冷却期内 `gate()` 直接抛错，**不发请求** |
| 重试 | 限流不进重试分支（重试只会拉长冷却） |
| 间隔 | 两次 `userverify` 之间强制 ≥4 秒（`X2_CALL_GAP` 可调） |
| 缓存 | 同一「链接 + 语言」的解析结果缓存 10 分钟（`X2_RESULT_TTL`），并发请求合并成一次 |
| 对外 | `/api/state` 返回 `cooldown:{active,waitMs}`；`/api/resolve` 返回 `cooldown` 与 `ratelimit`；前端按钮显示倒计时并在到点前保持禁用 |

换出口 IP（设置里填 HTTP 代理）是唯一能立刻解除限流的手段，冷却不会因为重启进程而消失——重启后是新的进程状态，但 Cloudflare 那边仍然按 IP 计时。

## 安全边界

- 所有文件操作都过 `assertInside(root, target)`，`relPath` 来自索引也照样校验，拒绝 `..` 越界。
- 文件名走 `safeName()`：去掉 `\/:*?"<>|` 与控制字符、压空白、限长 96。
- 请求体上限 4 MB；下载任务只接受来自解析结果的 url/文件名，不接受任意服务器端路径。
- 无第三方依赖：只用 `node:http/https/net/tls/fs`，减少供应链面。

## 已知取舍

- 任务队列在内存里，进程重启后丢失未完成任务（已入库的文件不受影响）。
- 不做断点续传：失败即整条重来，靠四线路回退提升成功率。
- 解析强依赖 x2twitter 的两条接口；对方改版时只需要动 `lib/x2.js` 的 `parseResultHtml`。
