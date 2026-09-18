# ASPM YARD

场外货物位置可视化 MVP：地图点选、搜索、拍照、运走删照片。

## 技术栈

- Vite + React + TypeScript（PWA 友好、移动优先）
- Leaflet 平面图（无 GPS）
- Supabase Sydney（Auth / Postgres / Storage）
- GitHub Pages 免费托管（Hash 路由）

## 本地启动

1. 安装依赖：`npm install`
2. 复制环境变量：`copy .env.example .env`（Windows）并填入 Supabase URL / anon key
3. 在 Supabase SQL Editor 执行 `supabase/schema.sql`
4. Authentication → Users 创建至少一个登录账号（建议关闭公开注册）
5. `npm run dev`

## Supabase 注意

- 创建项目时区域选 **Sydney (`ap-southeast-2`)**
- Free 约 7 天无活动会暂停；Storage 1GB，运走货物会删照片以节省空间

## 部署到 GitHub Pages

1. 推送到 GitHub 公开仓库 `aspm-yard`
2. Settings → Pages → Source: GitHub Actions
3. 在仓库 Secrets 添加：
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. 推送 `main` 后自动构建部署
5. 打开 `https://<你的账号>.github.io/aspm-yard/`

## MVP 功能

- 登录
- 上传场地平面图
- 添加 / 批量生成位置（如 A-01～A-15）
- 货物绑定位置、搜索、地图高亮
- 拍照压缩上传（≤1600px / 0.8）
- 移动历史
- 运走后删除相关照片
