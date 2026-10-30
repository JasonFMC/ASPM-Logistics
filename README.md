# ASPM Workshop

父级平台。当前子板块：Tickets、YARD。

## 技术栈

- Vite + React + TypeScript（Hash 路由）
- YARD 用自绘底图（无 GPS）
- Supabase Sydney（Auth / Postgres / Storage）
- GitHub Pages 托管

## 本地启动

1. 安装依赖：`npm install`
2. 复制环境变量：`copy .env.example .env`（Windows）并填入 Supabase URL / anon key
3. 在 Supabase SQL Editor 执行 `supabase/schema.sql`（工单另执行 `supabase/tickets.sql`，同事再执行 `supabase/staff.sql`，然后执行 `supabase/ticket_ops.sql`）
4. Authentication → Users 创建至少一个登录账号（建议关闭公开注册）
5. `npm run dev`

## 新同事第一次使用

这一节是同事启用时的现行步骤。后面的更新改完后，以这里的最终做法为准。

1. Supabase → Authentication → Users → Add user → Create new user。填可以登录平台的谷歌邮箱和密码，勾上 Auto Confirm User。这是大门，不是收信的 warehouse 邮箱。公开注册保持关闭。新建账号默认不是管理员。
2. 用这只谷歌邮箱登录后，打开工单。这一页是登录领取人：屏幕上是这只邮箱已经注册的人，头像下面是名字。点自己的头像，输入当时设的密码进入。新同事点「加入团队」，填名字和密码；左侧选一张现成小脸，右侧可以自己调脸、眼睛、耳朵、嘴巴、背景和颜色。密码不要告诉共用这只邮箱的人。进入后，左边池子是还没人领的任务，紧急的和约了时间的排在前面，拖到自己身上或点「领取任务」。办完和取消的单会离开池子。打开一张单可以写下单号、数量和约定时间并确认，对上院子里的货或位置，标成等待时要选原因，也可以写备注。备注不改状态。套上流程以后，工单状态跟着当前环节走；领取人就是这一步的负责人，要交给别人就放回。左侧点「改资料」可以改自己的名字和密码，留空的新密码表示不改。管理员在工单的「员工」页能看到改后的名字和密码。要换领取人时点左侧「员工身份」。关掉浏览器标签后要重新输入密码。
3. 在这台 Windows 上双击 `scripts/Install-Open-In-Outlook.cmd`。窗口里出现 `Installed for this Windows user.` 即可关掉。每台电脑、每个 Windows 用户做一次。不改邮箱密码。
4. 点「拉取新邮件」会登录任务邮箱，把澳洲东部时间 2026-10-19（本周一）0 点之后收到、还没建单的信补进工单。已经建过的不重复。同一封信在邮箱里改了标题再保存，下次拉取会改工单标题和摘要，并清掉这张工单的原信缓存；状态、仓库、客户和流程不变。Message-ID 和 UID 都变了的，会另建一张工单。进度条按实际步骤走：已接到请求、连上邮箱、找到新信、写入工单、完成。一次最多新建 200 单；如果提示还有没建的，再点一次。每次拉取都是重新登录，拉完就退出。打开工单就能看原信，版式和正文与邮箱里的那封一致。读信进度条会依次走过：已接到请求、已核对缓存、连上邮箱、取到信、取回正文、读完正文。正文在库里保留两周，两周后自动清掉，工单标题和进度还在。标题上方是显眼的发件人（名字和头像），下面是收件人、时间和附件；没有附件时写「无」。附件不入库，每个附件按类型显示图标、文件名和大小，名字与邮件里一致。点一下就在新标签页打开，不会自动下载：PDF、图片、文本、转来的邮件直接显示；Word、Excel 等浏览器显示不了的，页面上写明原因。要存到本机时自己点下载：PDF 用阅读器自带的下载按钮，其他附件用页面右上角的「下载」。浏览器提示拦截了弹出窗口时，在地址栏右侧选始终允许本站，再点一次附件。PDF 若仍是直接下载，把浏览器设置里「下载 PDF 而不是打开」关掉。整封信超过 25 MB 时页面不打开，用「打开原邮件」到 Outlook 里看。浏览器第一次询问是否打开 Outlook 时，勾上始终允许。

## Supabase 注意

- 创建项目时区域选 **Sydney (`ap-southeast-2`)**
- Free 约 7 天无活动会暂停

## 部署到 GitHub Pages

远程仓库是 `JasonFMC/ASPM-Logistics`。

1. Settings → Pages → Source: GitHub Actions
2. 在仓库 Secrets 添加：
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
3. 推送 `main` 后自动构建部署
