# Meeting Companion 开发说明

项目：MOSS / 讯飞实时语音、MOSS 会后整理、Vexa 会议转写。Node.js >=22.19，ES Modules。

- 安装：npm install；测试：npm test；线上构建：npm run build:cloud。
- cloud/public 为线上界面，worker/index.js 为 HTTPS / WebSocket 后台，runtime 为公共协议；public 与 server.mjs 是本机版；demo 是无 Key 示例。
- 提交前运行测试、构建，检查 git diff。保留已有功能和不同访问者间的凭据隔离。
- 不得提交真实 APPID/APIKey/APISecret、.env、录音、转写、登录信息或个人本机配置。使用示例凭据测试，避免真实调用费用。
- 讯飞记住凭据仅限访问者当前浏览器 IndexedDB；不得改为公共共享密钥或将真实凭据嵌入静态资源。
- 网站项目标识与原网址保存在 .openai/hosting.json 和 README.md。不要创建替代项目，不要强推或覆盖他人的提交。
- GitHub 代码更新不等于 Sites 上线。构建产物 dist 不入 Git；经 Sites 的同项目发布流程上线。
- 使用用户自己的 GitHub 凭据提交；不要把访问令牌写进 remote URL、文件或日志。
