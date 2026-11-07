# art-supabase-bff

基于 art-supabase-pro npm 主仓组件体系的 BFF 平台，已接入统一认证、应用管理、菜单、字典、角色、成员、系统品牌、上游服务、接口编排及版本发布。

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
4. 生产构建：pnpm build，浏览器产物写入 `docs/`；启动构建版本：pnpm start。可用 `VITE_OUT_DIR` 覆盖构建输出目录，构建和启动需使用同一个值。

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

## 基础管理

- **系统管理 → 角色与权限**：复用 pro npm 角色页，维护职责角色、逐项菜单/按钮权限及成员分配。BFF 没有组织模型，因此由服务端路由关闭共享页的组织筛选和字段。
- **系统管理 → 成员管理**：查看本租户已开通账号、平台身份、业务角色、应用授权及有效会话。此处不创建 pro 登录账号或重置密码；新成员通过上述身份核验工具开通。
- **系统管理 → 菜单管理、数据中心 → 字典管理**：复用 npm 页面，写入 BFF 数据库。角色删除与菜单/字典删除均使用主仓的关联检查弹窗，并由服务端最终重查。
- 平台管理员身份来自 BFF 成员的受控 `admin` 字段；普通职责角色名称或登录成功不会授予该身份。委派授权不能超过操作者当前具有的权限。
- 有应用新增权限的成员创建应用后自动取得该应用的访问授权。委派编辑和授权只作用于当前已获准访问的应用；创建者字段仅用于审计，不提供永久权限旁路。
- 停用成员会在同一事务中撤销其 BFF 会话、业务角色和应用授权；重新启用不会恢复这些授权。停用管理员前需明确核对其保留的平台身份。系统禁止自我停用、自我降级及移除最后一名有效管理员。
- 编辑、授权和成员状态变更使用版本或打开时的授权快照；遇到冲突需重新加载，防止覆盖其他管理员的修改。

## 上游服务

通过 **服务管理 → 上游服务**，按应用和环境登记服务草稿，配置地址、超时和认证方式，维护凭据并执行连接检测。页面与弹窗继续复用 pro npm 的 ArtTableQuery、ArtForm、ArtDialog、主题和布局。

- 服务编码、应用和环境创建后固定；配置编辑、凭据维护和启停使用版本校验。
- `BFF_CREDENTIAL_KEYS` 是仅服务端使用的版本化密钥集合，值为 32 字节 Base64；`BFF_CREDENTIAL_KEY_ID` 指定当前写入版本。密钥必须独立于会话密钥；保留仍有记录使用的旧版本。凭据不回显，不进入浏览器存储或审计日志。
- 配置 `BFF_UPSTREAM_ALLOWED_ORIGINS` 精确源站列表后，才能启用和检测相应地址。内网目标还需 `BFF_UPSTREAM_ALLOWED_CIDRS`；云元数据及链路本地地址仍禁止。生产始终使用 HTTPS，禁止本地 HTTP 放行。
- 网络策略留空时，可先登记 HTTPS 草稿。连接检测不发送凭据、不跟随重定向，仅表示网络可达，不能作为业务认证通过的依据。
- 删除前检查引用并停用服务；删除归档配置、移除凭据，保留不可变配置版本和操作审计。

## 接口编排

通过 **服务管理 → 接口编排**，声明调用参数、编排步骤与响应字段。接口按应用和环境隔离，支持 1–8 个顺序执行的 HTTP 步骤；后续步骤可通过 JSON Pointer 读取前序步骤字段。输入与映射值支持文本、数字和布尔类型，响应输出为显式声明的标量字段。

- 创建和修改保存为草稿；修改后需重新验证。验证检查参数、路径占位符、步骤顺序及绑定的上游配置版本。上游配置变化后须重新选择版本并验证。
- 试运行要求当前草稿已验证、应用及上游已启用，并通过出站策略与凭据就绪检查。总执行时限为 30 秒，前序失败时后续步骤跳过。页面展示步骤摘要和映射结果；配置或凭据在执行期间变化时，结果标为过期。
- `BffInterface:Test` 控制普通测试；非 GET 步骤还需 `BffInterface:TestWrite`。写测试仅用于开发或预发布环境，并须配置 `BFF_INTERFACE_TEST_WRITE_ORIGINS` 为受控测试源站，同时包含在 `BFF_UPSTREAM_ALLOWED_ORIGINS` 中。生产草稿测试始终只允许 GET。
- 上游存在草稿引用时，通过共用关联检查定位接口并处理绑定，再删除上游。已发布版本保留固定配置引用，不能删除关联上游或接口。

## 系统配置

在 **系统管理 → 系统配置** 维护系统名称、简称、说明、Logo、浏览器图标和水印。默认系统名称为“BFF平台”；图片支持 HTTPS 地址或本站相对路径，留空恢复公共默认图标。

页面、表单、主题和预览直接使用 pro npm 包的品牌配置模式。BFF 只实现自己的数据接口、版本比较和 `BffBrand:View` / `BffBrand:Edit` 权限；不在 BFF 重复实现登录、品牌组件或通用设置页。保存后当前页共享侧栏、标题、图标与水印立即使用新配置；其他会话重新加载后取得最新配置。并发修改会保留当前输入，确认重新加载后才丢弃。

该配置按当前 BFF 租户保存，与 pro 的网站设置、认证策略、注册和密码配置相互独立。页面由后端导航下发；升级到支持 `branding` 的宿主后，通过 `EnableBrandingNavigation` 开放。

## 版本发布与调用

通过 **服务管理 → 版本发布**，检查草稿就绪状态、生成发布版本、查看版本快照及发布事件，执行回滚和启停。每个接口独立显示运行版本与当前草稿；操作说明必填并保留到事件记录中。

1. 启用所属应用和上游，配置网络策略与服务端凭据。
2. 在接口编排中验证当前草稿并完成成功测试；上游配置或凭据变化后重新测试。
3. 在版本发布中执行发布前检查并填写说明。发布保存不可修改的定义与上游配置快照，再切换运行版本。
4. 修改草稿不会改变当前运行版本。回滚切到已有快照并保留启停状态；停用的接口回滚后仍需单独启用。停用立即关闭后续调用入口。

运行入口为同源 `/api/gateway/{应用编码}/{环境}/{发布路径}`，例如发布路径 `/orders/{orderId}` 对应 `/api/gateway/demo-ops/development/orders/ORDER-001`。路径中的示例应用须替换为真实应用编码；可从页面复制相对路径。回调和运行域名均不写死在前端。

- 运行调用要求有效 BFF 会话及应用授权，并具备 `BffInterface:Invoke`；非 GET 还需 `BffInterface:InvokeWrite`、精确 Origin、当前会话 CSRF 请求头及 UUID 格式的 `Idempotency-Key`。网关不提供匿名或跨域调用。
- 同一租户、成员的写请求编号只能使用一次；相同版本与输入在 15 分钟内可重放已加密缓存的映射结果，进行中的请求返回 202。输入变化、版本变化、缓存过期或执行结果未知时拒绝重新执行原编号。结果未知表示上游可能已产生副作用，应先按服务端请求编号核对，不能自动换编号重试。
- 网关仅返回服务端 `requestId`、发布版本号与声明的输出字段。调用元数据不保存实际路径参数、请求体、原始响应或凭据；短时重放结果通过会话主密钥派生的独立用途密钥加密，并绑定租户、成员及版本。会话密钥轮换后旧重放缓存可能不可读，不会因此重执行上游。
- 同一成员每分钟最多 120 次、并发 4 次；同一租户每分钟最多 600 次、并发 16 次。整次编排最长 30 秒，不自动重试上游写请求。GET 入口不能包含非 GET 上游步骤。
- 历史版本固定上游配置，运行仍检查当前应用、服务、网络策略及凭据。历史配置与当前凭据策略不兼容时拒绝执行，不恢复旧秘密。

菜单与权限遵循先部署宿主、再逐租户开放的顺序。确认运行宿主声明 `releases` 能力后，可使用 `EnableReleaseNavigation` 管理动作开放已验收的版本页面与调用权限；既有成员的职责角色仍需由管理员按需授权。

## 验证

```powershell
pnpm typecheck
pnpm test:unit
pnpm test:e2e
pnpm ui:audit
pnpm build
node --use-env-proxy --import tsx tests/integration/http-security.ts
```

浏览器回归和最后一项需要本地服务运行于 http://localhost:3012，可通过 BFF_TEST_ORIGIN 指定其他本机端口。浏览器回归只使用合成 API 数据，验证实际 npm 页面和动态路由；真实 API 检查使用右边数据库中的隔离测试租户，结束后清理所有测试记录。这两项都不能代替真实统一登录验收。

代理环境运行本机 HTTP 联测时，先设置 `$env:NO_PROXY='localhost,127.0.0.1'`。数据库回滚验证包含 `control-plane-schema.sql`、`role-access.sql`、`application-authorization.sql`、`upstream-schema.sql`、`interface-schema.sql` 和 `release-schema.sql`；仅执行 `ValidateBffSchema` 不提交结构变更。隔离发布与网关联测使用 `node --use-env-proxy --import tsx tests/integration/release-http.ts`，需要受控本机上游策略，不能指向真实业务服务。

成员页视觉数据可通过 `node --use-env-proxy --import tsx tests/integration/ui-fixtures.ts apply` 准备，并以同命令的 `remove` 清理。该工具只创建两条停用、无法匹配 pro 签发者的临时验收记录，不创建身份中心账号、不授予访问权限；验收后必须清理。

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

详见 ARCHITECTURE.md。
