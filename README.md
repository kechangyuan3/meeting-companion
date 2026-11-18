# 会议搭子

**最新版：2026.11.18 · 公开在线版**

**[立即打开最新版会议搭子](https://meeting-companion-kechangyuan3.happymorel8.chatgpt.site/)**

直接把上面的网页地址发给朋友即可，无需先配置 GitHub Pages。页面可公开查看，真实 AI 功能由每位访客填写自己的服务密钥并使用各自额度。源码与现有在线版同步，更新内容见 [版本说明](docs/releases/2026-11-18.md)。

把 MOSS-Live 实时交流、Vexa 线上会议转写和 Codex 后台任务放进同一个工作台。

**[在线使用 MOSS](https://meeting-companion-kechangyuan3.happymorel8.chatgpt.site)** · **[在线使用 Vexa](https://meeting-companion-kechangyuan3.happymorel8.chatgpt.site/vexa)** · **[无需 Key 的流程演示](https://meeting-companion-kechangyuan3.happymorel8.chatgpt.site/demo/)**

在线版本适配电脑、手机和平板；每位访问者填写自己的 Key，真实连接 MOSS 语音或 Vexa 会议服务。MOSS 需要浏览器支持麦克风和 Web Audio，并由用户允许权限。`/demo/` 单独提供无需 Key 的示例流程。

在线页面通过 HTTPS 后台中转 API。MOSS / Vexa Key 只保留在当前页面及对应请求／语音连接内存中，刷新后需要重新填写。讯飞凭据可选择仅在此浏览器加密保存，详见下文。不同访问者的请求分别携带自己的密钥。Vexa 仅在当前标签页保存正在参会的会议标识（不含 Key、入会密码和转写），方便刷新后重新输入 Key 并停止机器人。

在线版提供 MOSS / 讯飞实时交流、Nex 会中问答与纪要、录音转写和结论朗读，以及 Vexa 入会转写。Codex CLI 查询和 Vexa 纪要使用下面的本机版本；线上服务不会执行访问者电脑上的 Codex。

## 功能

| 服务 | 功能 |
| --- | --- |
| MOSS-Live | 电脑麦克风实时对话、打断、字幕及任务委派 |
| 讯飞星火超拟人交互（在线版） | 全双工语音、中文识别与回答，服务授权验证、浏览器可选加密记住凭据 |
| MOSS-Transcribe-Diarize-Pro | 会后把会议录音转成分说话人的文字（S01、S02…），带时间点 |
| Nex N2.6（MOSS 平台） | 会中依据字幕回答问题；会后依据转写生成概要、决定、待办、分歧 |
| MOSS-Transcribe 1.0 | 普通音频转写，不区分说话人 |
| MOSS-TTS 1.5 Flash / 1.0 Pro | 按需将 Nex 回答或纪要生成 MP3，手动播放和下载 |
| Vexa Cloud | 加入 Zoom / Google Meet / Teams，轮询带发言者的转写，控制退出 |
| Codex CLI（可选） | 接收 MOSS 委派的查询任务，或整理 Vexa 已确认的会议转写 |

当前 MOSS 与 Vexa 使用各自入口；尚未把 MOSS 音频送入线上会议，也未把 Vexa 转写自动转发给 MOSS。Vexa v0.12 open-core 的 `/speak` 仍未接通，见[官方 API 说明](https://docs.vexa.ai/api/meetings)。

## 源码入口

- `cloud/public/`：当前完整在线界面，包含讯飞、Nex 会中问答、录音导入、转写、纪要和朗读。
- `worker/index.js` 与 `runtime/`：在线 API / WebSocket 后台与共享协议。
- `public/` 与 `server.mjs`：本机运行界面，含 Codex CLI 委派；不是在线页面的发布目录。
- `demo/`：无需 Key 的预设交互演示，内容为示例。

如还想另行使用 `kechangyuan3.github.io/meeting-companion/` 网址，可以按 [GitHub Pages 教程](docs/github-pages.md) 发布；现有在线网址已可直接分享。

## 会中对话可选讯飞星火（在线版）

在线版左侧“连接服务”可以把会中对话换成讯飞星火「超拟人交互」（全双工：音频持续上传，由讯飞判断什么时候开口）。录音和会后整理不受影响。

1. 在[讯飞开放平台](https://www.xfyun.cn/solutions/sparkos_interactive)创建应用，领取或购买“超拟人交互”服务包（个人新用户免费 2 小时，企业认证 10 小时）。
2. 在[超拟人交互服务控制台](https://console.xfyun.cn/services/VCN)确认剩余时长和有效期，复制该服务下同一个应用的 APPID、APIKey、APISecret。页面选“讯飞星火”，点“验证讯飞服务”。指尖文字识别（fingerocr）的次数不是该服务的额度。
3. 想在会后生成分人转写和纪要，再填一个 MOSS Key；不填也能下载录音。

实现：页面把 16 kHz PCM 发到本站 `/connect-xf`，服务端按讯飞通用鉴权签名、连接 `wss://sparkos.xfyun.cn/v1/openapi/chat`，把 PCM 包成讯飞请求帧，再把讯飞回复拆成字幕和 24 kHz 语音转回页面。讯飞单次连接最长 30 分钟，页面在 29 分钟时新开一条连接（沿用对话历史）后再切换。讯飞凭据默认只保留在当前页面内存；勾选“记住此浏览器的讯飞凭据”后可持久保存。

验证会发送约 3 秒 16 kHz 合成静音，检查业务回应和授权错误，不读取麦克风。仅 WebSocket 握手成功不会立即判定服务可用；11200 会显示授权/额度未通过。运行时错误也会撤下通过标记。测试通过仅说明当时服务可用，后续仍受额度、并发和有效期约束。讯飞超拟人交互使用服务内置模型；官方接口文档未给出默认底层 LLM 的固定版本，不将它标作 Nex 或某个确定的星火快照。

## 会议音频转写与结论朗读（在线版）

「会议转写与纪要朗读」可以选择 `moss-transcribe-diarize-pro`（分人、热词）或 `moss-transcribe-1.0`（普通文字、不分人）。结束本页会议后使用录音，或手动选择 WebM、OGG、M4A、WAV、MP3、FLAC、AAC 文件。载入只保留在本页，点击生成才上传；网站单文件限制 40 MB，多人模型单段最多 60 分钟。普通转写仅有 `text` 时也会保留结果，交给 Nex 生成纪要，并可作为后续 Nex 问答的资料。已经转写的结果只重新生成纪要时不重复上传；更换转写模型会重新转写并计费。

朗读支持 `moss-tts-1.5-flash`、`moss-tts-1.0-pro`。读取当前账号可用音色，或从 MOSS Create 音色库复制 ID，填入最近 Nex 回答、会后纪要或最多 5000 字符的文字，点击生成 MP3，随后手动播放/下载。取消会中止当前请求，清除连接会释放本页音频；不自动开口，也不将 TTS 包装成全双工。模型请求只使用当前访客的 Key，不接受任意目标 URL 或回调地址。

转写和朗读是独立收费能力，需要可用账户额度；Nex 的限时免费不代表音频模型免费。具体以 [MOSS 当前价格](https://platform.moss.cn/app/pricing/) 为准。真实连通测试使用合成内容；接口返回 402 时按额度不足显示，不冒充成功。

## 在自己的浏览器记住讯飞凭据

填写自己的 APPID、APIKey、APISecret，勾选“记住此浏览器的讯飞凭据”，点击“保存到此浏览器”；验证成功时也会按勾选状态保存。下次打开自动填入，并切换到讯飞；仍需点击验证，不会自动录音或发送密钥给服务端。

凭据使用 AES-GCM 加密后与不可导出的 CryptoKey 一起放在本域名的 IndexedDB，未写入页面源码、Cookie、localStorage、服务端数据库或 GitHub。它只属于当前浏览器配置文件；换浏览器、换设备或清除网站数据后需重新填写。共用电脑不要启用。它不能防御已能控制本机或执行同源脚本的人，也不是操作系统密码库。

“清除已保存凭据”会删除此浏览器保存的讯飞凭据，并清除当前页面讯飞连接配置；顶部“结束并清除 Key”也会同时删除已保存的讯飞凭据。关闭页面或结束普通会议不会删除已选择保存的凭据。

## MOSS-Live 连接保活与恢复

实时语音仍使用 `moss-live-1.0`；`nex-n2.6` 是文本输出模型，不接收或生成音频，不能直接替换全双工语音。Nex 用于会中问答和会后纪要。

在线中转在握手完成后清除握手专用超时，每 15 秒发送官方 `ping`。收到 `session.closing` 时保留关闭代码、原因和是否支持恢复；服务端允许恢复或发生可恢复的传输中断时，先关闭旧连接，再用原 `session_id` 和原选项恢复。每次恢复最多重试三次，明确的权限、额度、限流和不可恢复关闭会停止，不自动新建会话绕过限制。

旧版把 25 秒握手超时留给了升级后的 WebSocket；隔离对照中旧中转在第 25 秒关闭，新中转连真实 MOSS 持续 125 秒并收到 8 次保活回应。旧页面把不足一分钟显示为“约 1 分钟”，现改为按实际秒数显示。这不是已确认的 MOSS Key 一分钟配额限制。测试为静音连通测试，实际麦克风对话仍需在浏览器体验。

上游语音恢复期间，浏览器保留录音、字幕、会议计时和暂停收音状态；恢复空档的音频不加速补传，页面会提示稍候再说。恢复后的字幕使用独立连接编号，避免覆盖前一段。网站与浏览器之间的连接完全断开时会保留可下载录音，不自动上传生成收费转写。

协议参考：[MOSS-Live 实时接口](https://platform.moss.cn/docs/reference/moss-live/)、[Nex N2.6 模型说明](https://platform.moss.cn/docs/models/nex/)。

## 会中直接问 Nex N2.6（在线版）

右侧「会中问 Nex N2.6」使用真实 `nex-n2.6` Chat Completions，可在不开麦克风时单独提问，也可在 MOSS-Live / 讯飞全双工语音继续运行时询问会议要点、分歧或待办。使用页面已验证的 MOSS Key，不需要另一把 Nex Key。

「带上当前会议字幕」勾选时仅发送本页当前会议的文字；服务器最多保留最近 60000 字符和 8 轮问答历史，未附带字幕时作为一般文字问答。Nex 没有联网或电脑执行工具，答案以会议原话为准。文字流跳过推理过程，可停止生成、继续追问、清空本页问答、导出 Markdown；停止会中语音不会清空问答。

问答历史只在本页内存，刷新前请导出，不上传到 GitHub 或共享数据库。在线请求为 `/api/moss/ask`，使用调用者自己的 Key，来源校验和凭据隔离与会后整理一致。服务端模型固定为 Nex，浏览器取消生成会中止上游请求。本机版同样提供此 HTTP 接口，网页入口当前在在线版。

已用虚构测试字幕调用真实服务，返回模型快照 `nex-n2.6-2026-11-05`，正确回答测试时间和负责人；不涉及用户历史会议音频。

## 会后整理

MOSS-Live 只负责会中的实时对话，会议结束后不会生成纪要。会后整理用 MOSS 平台的另外两个模型补上，在线版和本机版都支持，使用同一个 MOSS Key：

1. 会议开始后，浏览器录下麦克风音频（WebM/Opus，约 14 MB/小时）。暂停收音期间录到的是静音。
2. 点击“结束会议”后，录音上传给 `moss-transcribe-diarize-pro`（异步任务），识别出不同说话人和时间点。单段最长 60 分钟，所以录音每 55 分钟自动切一段，多段的说话人标签会加上“第 N 段”。
3. 分人转写和会中字幕一起交给 `nex-n2.6`，生成纪要。只依据转写，不编造负责人和日期。
4. 页面“会后整理”卡片可以导出 Markdown 纪要（纪要 + 分人转写 + 会中字幕），也可以下载录音。转写成功后再点“重新生成纪要”不会重复转写计费。

计费以 MOSS 控制台当前价格为准：分人转写按音频时长计费，Nex N2.6 目前限时免费。录音只保存在当前页面内存，刷新或关闭页面即丢失。请提前告知参会者会议会被录音。

## 本地真实使用

准备 Node.js 22.19+ 或 Node.js 24。Windows、macOS、Linux 使用同一套 Node 源码。

```sh
git clone https://github.com/kechangyuan3/meeting-companion.git
cd meeting-companion
npm install
npm start
```

浏览器打开 `http://127.0.0.1:17860/`。MOSS 页面填入自己的 MOSS Key，点击验证，再开始会议并允许麦克风。Vexa 页面填入自己的 Vexa Key，再粘贴自己的完整测试会议链接。

- [MOSS 控制台](https://platform.moss.cn/)：创建 API Key。MOSS Key 与 Vexa Key 不通用。
- [Vexa 账户页](https://vexa.ai/account)：登录后创建并复制完整 API Key，不要把密钥名称当作 Key。
- Codex 功能需要事先安装并登录 Codex CLI。CLI 在 PATH 中时自动识别；Windows 桌面版附带的 exe 也可通过 `CODEX_PATH` 指定。
- 环境变量示例见 `.env.example`。使用环境文件时复制为 `.env`，通过 `node --env-file=.env start.mjs` 启动。
- 只有后台查询受 Codex 是否安装的影响。MOSS 直接交流、Vexa 入会和转写可独立使用。

MOSS 发送麦克风音频给 MOSS 服务；Vexa 由云端机器人获取会议音频。请告知参会者转写安排，并使用自己的账户额度。结束时让 Vexa 机器人退出；关闭浏览器不会停止云端机器人。

## 分享与部署

- `cloud/public/` 是在线真实连接界面；`worker/index.js` 提供无共享密钥、无数据库的 HTTPS API 及 WebSocket 中转。
- `demo/` 是无需后台的示例流程，可直接静态托管。
- `npm run build:cloud` 将页面与后台打包为单个 `dist/server/index.js`，用于 Sites / Cloudflare Workers。部署自己的副本时使用自己的项目标识，并在构建时设置 `SITE_ORIGIN` 为自己的域名。
- `public/` 加 Node 服务是本机真实版本；接口只监听回环地址，校验来源和 Cookie。
- GitHub Pages 仅适合发布 `demo/`；真实服务需要支持 WebSocket 和 HTTPS 请求的后台。
- 在线网址可以直接分享。`127.0.0.1` 仅供下载后的本机版本使用，不能作为公开分享地址。
- 不要直接把本机服务开放到公网，也不要将自己的 Key 写进网页或仓库。

## 数据与密钥

本机版密钥保留在本机服务内存；在线版 MOSS / Vexa 密钥保留在访问者当前页面及对应请求内存；讯飞可按上述方式选择加密保存到当前浏览器。转写可导出为 Markdown，云端服务仍按各自政策处理记录。Codex 子进程不继承 MOSS 或 Vexa Key。此仓库不包含个人路径配置、会议记录、登录凭据或安装包。

## 开发

```sh
npm test
npm run preview
```

`npm run preview` 在 `http://127.0.0.1:17863/` 预览示例流程。`npm run build:cloud` 后可用 `npm run preview:cloud` 预览在线界面；真实 WebSocket 连接在部署的 Workers 环境中验证。

测试通过本地模拟服务验证 MOSS 音频与委派、进程取消、Vexa 请求/转写/退出、来源和密钥隔离，以及在线多访问者之间的认证、二进制音频和关闭隔离，不会派机器人进入真实会议。Vexa 真实入会仍需要有效 Key 和自己的会议。

## 来源与许可证

新增代码使用 MIT License。MOSS 官方 SDK 和音频示例使用 MIT，许可证保留在 `vendor/mosslive/LICENSE`；WebSocket 依赖 ws 使用 MIT。

- [MOSS 实时对话文档](https://platform.moss.cn/docs/scenarios/moss-live/)
- [Vexa 官方仓库](https://github.com/Vexa-ai/vexa)
- [Vexa 入会指南](https://docs.vexa.ai/how-to/send-a-bot)
- [Codex 官方仓库](https://github.com/openai/codex)

## 用 Claude Code、Codex 或其他工具继续修改

仓库：https://github.com/kechangyuan3/meeting-companion

克隆后让工具打开仓库目录；通用说明见 `AGENTS.md`，Claude Code 入口见 `CLAUDE.md`。本仓库属于你的 GitHub 账号，直接提交使用该账号的 Git / GitHub 登录权限；安装 AI 工具本身不会额外授予 GitHub 权限。其他人可阅读、fork、提交 PR，直接写入需要仓库授权。

常用流程：`git pull --ff-only` → 修改 → `npm test` → `npm run build:cloud` → 审查 `git diff` → 提交并推送。GitHub Actions 会测试 Node 22 / 24。推送 GitHub 不会自动更新 Sites，线上发布还要使用同一项目的 Sites 发布流程。
