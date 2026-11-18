# 把会议搭子发布成 GitHub Pages

目标网址：`https://kechangyuan3.github.io/meeting-companion/`。这个地址需要完成下面的发布步骤才会上线。

代码已经在公开仓库 `kechangyuan3/meeting-companion`，无需再建仓库或重复上传压缩包。`Magic-Notes` 和 `meeting-companion` 是两个不同项目，可以分别拥有自己的 Pages 地址。

## 第一次发布：按顺序点击

1. 登录 GitHub，打开 [会议搭子仓库](https://github.com/kechangyuan3/meeting-companion)。
2. 点击上方 **Settings**，再点左侧 **Pages**。也可以直接打开 [Pages 设置](https://github.com/kechangyuan3/meeting-companion/settings/pages)。
3. 在 **Build and deployment → Source** 选择 **GitHub Actions**。本项目使用已准备好的构建工作流，不要选择从 `main` 根目录或 `docs` 直接发布。
4. 打开上方 **Actions**，在左侧点击 **Publish GitHub Pages**，点 **Run workflow**，分支保持 **main**，再点绿色的 **Run workflow**。
5. 等这次任务变成绿色成功状态，返回 **Settings → Pages**，点击 **Visit site**。第一次发布可能需要等待几分钟。
6. 把 `https://kechangyuan3.github.io/meeting-companion/` 发给朋友。网页可以公开查看，查看页面无需 ChatGPT 或 GitHub 账号。点击“无需 Key，先看演示”可看预设流程；真实语音、Nex 和 Vexa 使用每位访客自己的服务密钥与额度。

若 Actions 列表没有这项工作流，请刷新页面并确认在 `main` 分支。若没有 Run workflow，确认当前登录的是有本仓库写权限的账号。若任务失败，打开这次任务，找到红色步骤查看报错；不要把 Key 发到 Issue 或写进工作流。

## 以后修改怎么发布

Claude Code、Codex 或你自己修改源代码，提交并推送到本仓库之后，重复第 4 步手动运行 **Publish GitHub Pages**。这个工作流只在手动点击时发布，避免普通代码提交意外更新网页。

构建命令是 `npm run build:pages`。它从 `cloud/public` 与 `demo` 生成 `pages-dist`；Actions 只上传该目录，不会把数据库、本机配置、录音或 `.env` 当成网页上传。`pages-dist` 不提交到 Git。网站的入口是构建后的 `index.html`，CSS、脚本和麦克风工作模块都支持 `/meeting-companion/` 子路径。

## 网页地址与模型、后台的区别

`chatgpt.site` 是原有网页的托管域名，不决定使用哪个 AI。MOSS-Live / 讯飞负责全双工语音，Nex N2.6 负责会中问答和纪要，MOSS 转写 / TTS 负责音频处理。

GitHub Pages 负责公开网页，实际 API 和 WebSocket 继续连接现有后台 `https://meeting-companion-kechangyuan3.happymorel8.chatgpt.site`。后台允许 `https://kechangyuan3.github.io` 访问，密钥仍由每位访客单独提供，不嵌入网页。不同域名的浏览器存储分开，原网页记住的讯飞凭据不会自动迁移到 GitHub Pages，需要在新网址重新填写并按需保存。

如果朋友的网络无法访问现有后台域名，GitHub Pages 的界面仍能打开，但真实 AI 功能也可能无法连接。要连后台也完全独立，需要另行部署 Worker 到自己可访问的服务器；纯 HTML 或 GitHub Pages 无法代替这个后台。可以用构建环境变量 `MEETING_BACKEND_ORIGIN` 指定经过你确认的新 HTTPS 后台，同时在后台配置允许的 Pages 来源。

GitHub Pages 不需要保存真实 API Key 到仓库或 Actions Secrets。本项目也不使用共享 Key 为所有人付费。

参考：[GitHub Pages 发布来源](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)、[创建 Pages 站点](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)。
