# art-supabase-bff

基于 art-supabase-pro 主仓组件体系的 BFF 平台。第一阶段实现统一认证和应用管理。

## 边界

- 身份中心：pro Supabase 项目 ckbftoopuyophiebamwy。
- 业务数据库：BFF 项目 bksbwnxdurmuolygiofh。
- 浏览器通过同源 BFF API 访问业务数据，使用 HttpOnly 会话 Cookie；数据库密钥、访问令牌和刷新令牌只留在服务端。
- pro 的业务角色不会自动变成 BFF 管理权限。BFF 使用自己的租户成员和应用授权。
- 保留主仓 Art 组件、主题、布局及其配套工具；未引入业务子仓、业务页面和已有业务数据。保留组件需要服务端数据时，应在 BFF 增加对应 API 适配；不允许组件直接请求 pro 业务库。

## 本地运行

需要 Node.js 22.21 或更高版本、pnpm 11.28.2。

1. 安装依赖：pnpm install。
2. 根据 .env.example 准备 .env.local；服务端密钥不得使用 VITE_ 前缀。
3. 启动开发服务：pnpm dev，默认 http://localhost:3010。
4. 生产构建：pnpm build；启动构建版本：pnpm start。

同一时间只运行一个 BFF 服务。开发服务和构建版本均使用 3010；切换前在原终端按 Ctrl+C 停止旧服务，再运行 pnpm dev 或 pnpm start。浏览器访问 http://localhost:3010；localhost:3006 是 pro 自己的开发服务。

开发命令会监视 server 和 vite.config.ts，修改服务端代码或构建配置后自动重启；Vue 页面和样式继续使用 Vite 热更新。依赖预编译缓存按 BFF 端口隔离在 node_modules/.cache/vite-bff 下，重复启动会复用缓存；不要为了日常启动删除 node_modules 缓存。

清理临时验证日志、发布副本及旧构建：npm run clean:local。脚本只删除本项目内列出的临时文件，保留 .env.local、数据库源码和 .artifacts/backups 下的恢复备份。需要预览时运行 powershell.exe -NoProfile -File scripts/clean-local-artifacts.ps1 -WhatIf。

数据库已经初始化。server/database/schema.sql 是唯一的完整结构定义，不是增量迁移；不要把它用于 pro。

## 统一认证

采用授权码 + PKCE + 浏览器绑定 state。为兼容 pro 当前 HS256 签名，申请 email profile 权限，并通过身份中心的 UserInfo 接口确认用户；不请求需要更换签名密钥的 OIDC ID Token。所有返回地址均由 OAuth 客户端预注册。

首次登录必须已开通 BFF 成员，未开通的账号不自动获得平台权限。管理员可在已开通成员范围内分配应用访问权。

使用时打开 http://localhost:3010，点击“前往统一登录”，使用 pro 原账号和原密码登录，再点击“同意并继续”返回“应用管理”。浏览器若自动填入历史账号，请确认改成已开通 BFF 权限的账号。授权请求有效期较短；若已过期，请回到 BFF 重新点击登录。

Windows 上可复用已登录的 Supabase CLI 凭据执行初始化工具，凭据不会打印：

~~~powershell
./scripts/supabase-management.ps1 -Action Inspect
./scripts/supabase-management.ps1 -Action VerifyBff
./scripts/supabase-management.ps1 -Action ProvisionMember -Login '已有账号邮箱' -MemberRole viewer
~~~

应用登记、修改、启停和成员授权均经过服务端权限检查；普通成员只能列出本租户已启用且已授权的应用。应用启停管理的是平台内的可见性，不代替外部应用自己的鉴权。

## 验证

~~~powershell
pnpm typecheck
pnpm test:unit
pnpm ui:audit
pnpm build
node --use-env-proxy --import tsx tests/integration/http-security.ts
~~~

最后一项需要本地构建服务器运行于 http://localhost:3012，可通过 BFF_TEST_ORIGIN 指定其他本机端口。它使用右边数据库中的隔离测试租户，结束后清理所有测试记录。

tests/fixtures/ui-server.ts 仅供界面测试，提供内存中的虚构数据，不连接任何 Supabase 项目，不能作为真实认证验证。

详见 docs/architecture.md。
