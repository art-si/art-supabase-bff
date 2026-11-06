# art-supabase-bff

基于 art-supabase-pro 主仓组件体系的 BFF 平台。第一阶段实现统一认证和应用管理。

## 边界

- 身份中心：pro Supabase 项目 ckbftoopuyophiebamwy。
- 业务数据库：BFF 项目 bksbwnxdurmuolygiofh。
- 浏览器通过同源 BFF API 访问业务数据，使用 HttpOnly 会话 Cookie；数据库密钥、访问令牌和刷新令牌只留在服务端。
- pro 的业务角色不会自动变成 BFF 管理权限。BFF 使用自己的租户成员和应用授权。
- 通过 art-supabase-pro npm 依赖复用主仓入口、Art 组件、Hooks、主题、布局、菜单 Store、工作标签页和动态路由注册器。BFF 仅保留业务页面、同源 API 和服务端会话接入，不保留公共实现副本。

## 本地运行

需要 Node.js 22.21 或更高版本、pnpm 11.28.2。

1. 安装依赖：pnpm install。
2. 根据 .env.example 准备 .env.local；服务端密钥不得使用 VITE_ 前缀。
3. 启动开发服务：pnpm dev，默认 http://localhost:3010。
4. 生产构建：pnpm build；启动构建版本：pnpm start。

同一时间只运行一个 BFF 服务。开发服务和构建版本均使用 3010；切换前在原终端按 Ctrl+C 停止旧服务，再运行 pnpm dev 或 pnpm start。浏览器访问 http://localhost:3010；localhost:3006 是 pro 自己的开发服务。

开发命令会监视 server 和 vite.config.ts，修改服务端代码或构建配置后自动重启；Vue 页面和样式继续使用 Vite 热更新。依赖预编译缓存按 BFF 端口隔离在 node_modules/.cache/platform-vite/bff 下，重复启动会复用缓存；不要为了日常启动删除 node_modules 缓存。

清理临时验证日志、发布副本及旧构建：npm run clean:local。脚本只删除本项目内列出的临时文件，保留 .env.local、数据库源码和 .artifacts/backups 下的恢复备份。需要预览时运行 powershell.exe -NoProfile -File scripts/clean-local-artifacts.ps1 -WhatIf。

数据库已经初始化。server/database/schema.sql 是唯一的完整结构定义，不是增量迁移；不要把它用于 pro。

## 统一认证

采用授权码 + PKCE + 浏览器绑定 state。为兼容 pro 当前 HS256 签名，申请 email profile 权限，并通过身份中心的 UserInfo 接口确认用户；不请求需要更换签名密钥的 OIDC ID Token。所有返回地址均由 OAuth 客户端预注册。

首次登录必须已开通 BFF 成员，未开通的账号不自动获得平台权限。管理员可在已开通成员范围内分配应用访问权。

打开 BFF 地址后，未登录时直接进入统一身份中心，使用 pro 原账号和原密码登录；内部 BFF 客户端自动接续授权并返回 BFF“应用管理”。已有有效 BFF 会话时直接进入系统。BFF 登录不会以 pro 工作台作为成功终点。浏览器若自动填入历史账号，请确认使用已开通 BFF 权限的账号。过期请求需要从 BFF 地址重新发起。

### 部署时的回调地址

回调由服务端环境变量 `BFF_ORIGIN` 生成，固定路径为 `/api/auth/callback`，不从浏览器的 Host 或查询参数接受任意回调。

| 环境 | BFF_ORIGIN 示例           | OAuth 客户端中登记的精确回调                |
| ---- | ------------------------- | ------------------------------------------- |
| 本地 | `http://localhost:3010`   | `http://localhost:3010/api/auth/callback`   |
| 生产 | `https://bff.example.com` | `https://bff.example.com/api/auth/callback` |

生产启动必须提供 HTTPS 的 `BFF_ORIGIN`。在部署环境设置服务端密钥和客户端凭据，并在身份中心为该 OAuth 客户端登记对应的精确回调地址；不要使用通配符。统一登录页从 Supabase 校验过的授权请求读取返回地址，无需在 pro 页面代码里再维护一份部署域名。更换为独立 OAuth 客户端时，还需将其公开客户端 ID 加入 pro 的内部可信客户端配置；客户端密钥始终只留在 BFF 服务端。

Windows 上可复用已登录的 Supabase CLI 凭据执行初始化工具，凭据不会打印：

```powershell
./scripts/supabase-management.ps1 -Action Inspect
./scripts/supabase-management.ps1 -Action VerifyBff
./scripts/supabase-management.ps1 -Action ProvisionMember -Login '已有账号邮箱' -MemberRole viewer
```

应用登记、修改、启停和成员授权均经过服务端权限检查；普通成员只能列出本租户已启用且已授权的应用。应用启停管理的是平台内的可见性，不代替外部应用自己的鉴权。

## 验证

```powershell
pnpm typecheck
pnpm test:unit
pnpm ui:audit
pnpm build
node --use-env-proxy --import tsx tests/integration/http-security.ts
```

最后一项需要本地构建服务器运行于 http://localhost:3012，可通过 BFF_TEST_ORIGIN 指定其他本机端口。它使用右边数据库中的隔离测试租户，结束后清理所有测试记录。

tests/fixtures/ui-server.ts 仅供界面测试，提供内存中的虚构数据，不连接任何 Supabase 项目，不能作为真实认证验证。

## npm 复用约定

- `@/` 指向已安装的 pro 包源码，`@bff/` 指向本工程源码；主仓组件、Hooks 和工具均从 `@/` 引入。
- `src/main.ts` 使用主仓 `bootstrapRuntime` 和 `App.vue`；通过服务端会话接口提供当前用户、权限判断和退出操作。
- 动态业务菜单来自 `/api/auth/session`，由主仓 `RouteRegistry` 和 `ComponentLoader` 注册并自动挂载主仓布局。前端静态路由仅包含认证错误与框架错误页。
- Vite、TypeScript、ESLint、Stylelint、Prettier 和 UI 审查复用主仓配置。`npm run boundary:audit` 阻止公共源码重新复制到本工程。
- `npm run skills:link` 将主仓随包发布的 skills 注册到本工程；安装依赖后自动执行，不维护技能内容副本。
- 升级公共能力：先在 pro 修改和验证，发布提交后更新本工程 `art-supabase-pro` 的固定提交地址，再安装、检查和回归。支持显式设置 `ART_SUPABASE_PLATFORM_ROOT` 进行两仓联合开发；正常运行不查找旁边的源码目录。
- `npm run check` 运行边界、类型、代码规范、样式、UI 和认证单测；`npm run build` 验证生产打包。

公共源码旧副本已移至忽略目录 `.artifacts/framework-source-backup`，不参与运行、构建或提交。移出前已保存 Git 基线；工程内不再维护这些公共副本。

详见 docs/architecture.md。
