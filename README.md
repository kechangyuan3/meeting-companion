# 会议搭子

把 MOSS-Live 实时交流、Vexa 线上会议转写和 Codex 后台任务放进同一个工作台。

**[在线使用 MOSS](https://meeting-companion-kechangyuan3.happymorel8.chatgpt.site)** · **[在线使用 Vexa](https://meeting-companion-kechangyuan3.happymorel8.chatgpt.site/vexa)** · **[无需 Key 的流程演示](https://meeting-companion-kechangyuan3.happymorel8.chatgpt.site/demo/)**

在线版本适配电脑、手机和平板；每位访问者填写自己的 Key，真实连接 MOSS 语音或 Vexa 会议服务。MOSS 需要浏览器支持麦克风和 Web Audio，并由用户允许权限。`/demo/` 单独提供无需 Key 的示例流程。

在线页面通过 HTTPS 后台中转 API。Key 只保留在当前页面及对应请求／语音连接内存中，不保存到 Cookie、浏览器存储或数据库；不同访问者的请求分别携带自己的密钥。刷新后需要重新填写。Vexa 仅在当前标签页保存正在参会的会议标识（不含 Key、入会密码和转写），方便刷新后重新输入 Key 并停止机器人。

在线版提供 MOSS 实时交流与 Vexa 入会转写。Codex CLI 查询和纪要使用下面的本机版本；线上服务不会执行访问者电脑上的 Codex。

## 功能

| 服务 | 本地真实版本 |
| --- | --- |
| MOSS-Live | 电脑麦克风实时对话、打断、字幕及任务委派 |
| Vexa Cloud | 加入 Zoom / Google Meet / Teams，轮询带发言者的转写，控制退出 |
| Codex CLI（可选） | 接收 MOSS 委派的查询任务，或整理 Vexa 已确认的会议转写 |

当前 MOSS 与 Vexa 使用各自入口；尚未把 MOSS 音频送入线上会议，也未把 Vexa 转写自动转发给 MOSS。Vexa v0.12 open-core 的 `/speak` 仍未接通，见[官方 API 说明](https://docs.vexa.ai/api/meetings)。

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

本机版密钥保留在本机服务内存；在线版密钥保留在访问者当前页面及对应请求内存。两者都不把 Key 写入浏览器存储。转写可导出为 Markdown，云端服务仍按各自政策处理记录。Codex 子进程不继承 MOSS 或 Vexa Key。此仓库不包含个人路径配置、会议记录、登录凭据或安装包。

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
