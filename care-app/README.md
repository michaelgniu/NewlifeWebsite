# 关怀探访系统 · 网页版（Supabase + 网页前端）

真正的网页应用：Postgres 数据库 + 用户登录 + 角色权限（行级安全）+ 探访看板。
**全部免费**（Supabase 免费版 + GitHub Pages）。

## 角色权限

| 角色 | 能做什么 |
|---|---|
| **管理员 admin** | 全部：管用户/角色、管小组、看改所有访客 |
| **负责人 leader** | 看改所有访客、登记、分配、接手未跟进 |
| **同工 volunteer** | 只看**分配给自己**的访客、填反馈、+1来访 |

> 「只看自己的」是在**数据库层面（RLS）**强制的，不是前端藏一藏——同工即使打开开发者工具也拿不到别人的数据。

## 第一阶段已实现

- 邮箱注册/登录、退出
- 三种角色 + 行级权限
- 登记新朋友、探访看板（按状态分列）、我的待办
- 填探访反馈、+1 来访、分配同工、改状态
- 管理页：改用户角色/区域/启用、增查小组

> 第二阶段将做：周三自动分配、周五升级提醒、失联判断、Gmail 邮件通知（用 Supabase 定时任务 + 邮件服务）。

## 安装步骤

### 1. 建 Supabase 项目
1. 打开 https://supabase.com → 注册 → New Project（选免费版，区域选离你近的，如 Singapore）
2. 记下数据库密码（自己保管）

### 2. 建表
- 左侧 **SQL Editor → New query**，把本目录 `schema.sql` 全部粘贴，点 **Run**
- 成功后在 **Table Editor** 能看到 visitors / profiles / groups / followups / config 等表

### 3. 填前端密钥
- Supabase 左下 **Project Settings → API**，复制 **Project URL** 和 **anon public** key
- 打开本目录 `config.js`，把两处占位替换为你的真实值
  - `anon` key 是设计上可公开的，安全由 RLS 保证

### 4. 部署前端（GitHub Pages）
- 本 `care-app` 目录已在仓库里，推送后即可通过
  `https://<你的用户名>.github.io/NewlifeWebsite/care-app/` 访问
  （或你的自定义域名 + `/care-app/`）

### 5. 建第一个管理员
1. 打开上面的网址 → 点「注册」→ 用你的邮箱注册
2. 回到 Supabase → SQL Editor 运行（把邮箱换成你的）：
   ```sql
   update profiles set role='admin' where email='你的邮箱';
   ```
3. 刷新网页，你就是管理员了，可在「管理」页把其他同工设为 leader/volunteer

### 6.（可选）关闭邮箱验证方便内部使用
- Supabase → **Authentication → Providers → Email**，可关闭 "Confirm email"，
  这样同工注册后无需收验证邮件即可登录（内部小范围使用更方便）

## 日常使用

- **负责人**登记新朋友 → 分配同工（或留空等第二阶段自动分配）
- **同工**登录看「我的待办」→ 联系后「填反馈」
- **负责人**在「探访看板」一眼看到每个人的状态

## 隐私

访客个人信息存在你自己的 Supabase 数据库里，**代码仓库不含任何个人数据**。
`config.js` 里的 anon key 是公开安全的；真正的密钥（service_role）不要放进前端或仓库。
