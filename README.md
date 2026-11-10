# art-supabase-bff

基于 art-supabase-pro npm 主仓组件体系的 BFF 平台，已接入统一认证、应用管理、菜单、字典、角色、成员、上游服务和接口编排。

## 边界

- 身份中心：pro Supabase 项目 ckbftoopuyophiebamwy。
- 业务数据库：BFF 项目 bksbwnxdurmuolygiofh。
- 浏览器通过同源 BFF API 访问业务数据，使用 HttpOnly 会话 Cookie；数据库密钥、访问令牌和刷新令牌只留在服务端。
- pro 的业务角色不会自动变成 BFF 管理权限。BFF 使用自己的租户成员和应用授权。
- 通过 art-supabase-pro npm 依赖复用主仓入口、Art 组件、Hooks、主题、布局、菜单 Store、工作标签页和动态路由注册器。BFF 仅保留业务页面、同源 API 和服务端会话接入，不保留公共实现副本。

## Netlify 免费演示部署

`netlify.toml` 发布 `docs/` 前端并将 `/api/*`、根入口和登录入口转发到同源 Node 函数。函数复用 `server/app.ts` 的原始认证、权限和 API 处理，普通 Node 开发/部署入口仍为 `server/index.ts`。

在 Netlify 选择 Free，连接 GitHub 镜像仓库的 `master` 分支。配置与 `.env.example` 相同的服务端 OAuth、Supabase 和加密环境变量，以及正式 HTTPS 地址 `BFF_ORIGIN`。密钥只放平台环境变量；沿用现有加密密钥版本。身份中心的既有 OAuth 客户端需增加精确的 `https://<站点域名>/api/auth/callback`，保留本地回调。

告警评估和资源清理均每分钟执行，使用 Netlify Scheduled Functions；普通请求不启动常驻计时器。仅正式发布版本执行定时任务，预览不会自动执行。

Netlify 的同步函数存在 60 秒时限、缓冲请求/响应 6 MB 限制，二进制编码后实际可用文件大小更低。此限制独立于 BFF 原来的 10 MiB 文件限制；大文件和较慢的 AI 字图生成不能保证成功。该方案用于免费演示，不承诺与常驻 Node 的大文件、长任务能力相同。免费额度耗尽会暂停，需要在控制台监控使用量。

## Render 免费演示部署

仓库根目录的 `render.yaml` 定义一个免费 Node Web Service，同时提供前端和同源 API；不新建 Render 数据库，继续使用既有 BFF Supabase 项目。

1. 使用 GitHub 账号登录 Render，授权访问 Gitee 镜像对应的 GitHub 仓库；新建 Blueprint，选择该仓库的 `master` 分支和 `render.yaml`。
2. 核对实例为 **Free**。配置页面中填写服务端 OAuth 客户端、Supabase 和加密配置；沿用现有环境的密钥与密钥版本，不重新生成覆盖既有加密数据。密钥只填 Render 的 Environment，不提交仓库或填入 `VITE_` 变量。
3. 由 Render 分配 HTTPS 地址。未指定 `BFF_ORIGIN` 时服务读取平台的 `RENDER_EXTERNAL_URL`；自行绑定域名后显式配置 `BFF_ORIGIN`。在 pro 对应 OAuth 客户端中增加该域名下精确的 `/api/auth/callback`，保留仍在使用的本地回调。
4. 部署后检查 `/api/health`、真实登录、菜单、图片上传与保存。不以健康检查成功替代登录验收。

监听地址由 `BFF_HOST` 控制：本地默认 `127.0.0.1`，Render 配置 `0.0.0.0`；端口依次读取 `BFF_PORT`、Render `PORT`、本地默认 `3010`。Render 不应复制本地的 `BFF_PORT=3010` 或 `BFF_ORIGIN=http://localhost:3010`。

免费服务闲置会休眠，首次访问可能需要约一分钟启动；休眠期间自动告警评估和清理任务也暂停。持久数据和图片使用 Supabase，不依赖 Render 本机文件。此配置用于演示，master 分支有新提交时自动部署；未配置上游允许列表时保持不允许访问外部上游。

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

## GitHub Actions 与 Node 部署

本仓库会提交 `docs/` 生产前端产物。Gitee 同步到 GitHub 后，`Build Node deployment package` 工作流会在 master/main 推送时执行检查、重新构建，并上传包含 `docs`、Node 服务端和锁文件的部署包；也可在 Actions 中手动运行。构建使用公开测试标记检查密钥泄漏，不需要配置真实服务端密钥。

`docs` 需要由 Node BFF 在同一域名下提供。GitHub Pages 只能提供静态文件，不能单独运行本项目的登录回调、会话和 API。

Node 服务器部署步骤：

1. 安装 Node.js 24 和 pnpm 11.28.2；下载 Actions 的 `art-supabase-bff-node-*` 产物，解压其中的 tar.gz 到独立发布目录。
2. 执行 `pnpm install --frozen-lockfile`。当前 TypeScript 服务运行时还依赖 tsx 和 Vite，不能只安装生产依赖。
3. 通过服务器环境变量或服务器本地 `.env.local` 配置 `.env.example` 中的值，将 `BFF_ORIGIN` 设置为实际 HTTPS 域名；沿用原有会话及凭据加密密钥。真实配置不要放入 Git、Actions 构建产物或任何 `VITE_` 变量。
4. 在 pro 身份中心登记精确的 `https://你的域名/api/auth/callback`，保持 OAuth 客户端配置与服务器一致。
5. 使用 systemd、容器或现有进程管理器执行 `pnpm start`。服务监听本机 `127.0.0.1:BFF_PORT`，由 HTTPS 反向代理将该域名的全部请求转发到该端口，保留同源 API 和 HttpOnly Cookie。
6. 检查 `/api/health`，再验证真实登录和业务页面。数据库结构另由有权限的部署者通过 scoped CLI 审核并应用 canonical schema，构建工作流不自动变更数据库。

当前工作流负责检查和交付部署包；尚未配置远程服务器连接及自动重启步骤，需根据实际 Node 托管环境接入部署作业。

## 统一认证

采用授权码 + PKCE + 浏览器绑定 state。为兼容 pro 当前 HS256 签名，申请 email profile 权限，并通过身份中心的 UserInfo 接口确认用户；不请求需要更换签名密钥的 OIDC ID Token。所有返回地址均由 OAuth 客户端预注册。

首次登录必须已开通 BFF 成员，未开通的账号不自动获得平台权限。平台管理员可在“系统管理 → 成员管理 → 开通成员”中输入已有统一账号邮箱，核验有效统一身份后加入当前 BFF 工作空间，不改变 pro 的租户归属；默认开通为普通成员，再分配业务角色和应用访问权。重复开通不会覆盖原有权限或重新启用停用成员。

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
./scripts/supabase-management.ps1 -Action PrepareMemberDirectory
./scripts/supabase-management.ps1 -Action ProvisionMember -Login '已有账号邮箱' -MemberRole viewer
```

应用登记、修改、启停和成员授权均经过服务端权限检查；普通成员只能列出本租户已启用且已授权的应用。应用启停管理的是平台内的可见性，不代替外部应用自己的鉴权。

## 基础管理

- **系统管理 → 角色与权限**：复用 pro npm 角色页，维护职责角色、逐项菜单/按钮权限及成员分配。页面保留完整原生布局；BFF 未建立组织记录时，组织 API 返回当前工作空间的空树。
- **系统管理 → 成员管理**：管理员通过“开通成员”核验已有统一账号邮箱并将其加入当前 BFF 工作空间；查看及调整成员的平台身份、访问状态、业务角色、应用授权与会话。此处不创建 pro 登录账号或重置密码。页面核验使用服务端 `BFF_IDENTITY_DIRECTORY_SERVICE_KEY`，部署时可运行 `PrepareMemberDirectory` 写入忽略提交的 `.env.local`；该凭据仅用于服务端读取 pro 身份，业务写入仍只进入 BFF 数据库。上述 `ProvisionMember` 保留为运维工具。
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

通过 **服务管理 → 接口编排**，声明调用参数、编排步骤与响应字段。接口按应用和环境隔离，支持 1–8 个顺序执行的 HTTP 步骤；后续步骤可通过 JSON Pointer 读取前序步骤字段。响应支持显式声明的标量字段，以及含字段白名单的分页记录。

- 创建和修改保存为草稿；修改后需重新验证。验证检查参数、路径占位符、步骤顺序及绑定的上游配置版本。上游配置变化后须重新选择版本并验证。
- 试运行要求当前草稿已验证、应用及上游已启用，并通过出站策略与凭据就绪检查。总执行时限为 30 秒，前序失败时后续步骤跳过。页面展示步骤摘要和映射结果；配置或凭据在执行期间变化时，结果标为过期。
- `BffInterface:Test` 控制普通测试；非 GET 步骤还需 `BffInterface:TestWrite`。写测试仅用于开发或预发布环境，并须配置 `BFF_INTERFACE_TEST_WRITE_ORIGINS` 为受控测试源站，同时包含在 `BFF_UPSTREAM_ALLOWED_ORIGINS` 中。生产草稿测试始终只允许 GET。
- 上游存在接口引用时，通过共用关联检查定位接口并处理绑定，再删除上游。草稿不直接承接正式调用；正式请求使用不可变发布版本，见下方版本发布与网关。

## Pro 接入与统一响应

### 已部署的线上入口

- BFF 管理端：<https://bff-platform.netlify.app/>。
- Pro 调用端：[BFF 接入中心](https://art-si.github.io/art-supabase-pro/#/examples/bff-integration)。登录 Pro 后也可从侧栏进入同名页面；目录仅对已开通 BFF 的账号显示。
- 首次核验：搜索「线上平台健康检查」，确认应用「线上接入验证」、环境「生产」，点击「选择接口」→「运行接口」。该接口不需要参数，成功结果为 `status: ok`，并显示请求编号和运行版本。
- 业务接口接入：在 BFF 登记可从公网访问的 HTTPS 上游，将精确源站加入服务端允许列表；声明输入与输出、测试、发布并启用后，Pro 刷新目录即可调用。分页接口显示「查询分页记录」，普通接口显示「运行接口」。
- Pro 页面源码为 `src/views/examples/bff-integration/index.vue`；复用调用 API 为 `src/api/bff.ts`。目前接入中心消费已发布接口，既有运输/车辆等业务页面不会自动替换数据源，需要在具体 API provider 中显式接入。

### 日常操作

1. 在「应用管理」登记并启用应用，配置成员授权；行内「配置应用接入」进入该应用的上游列表。
2. 在「上游服务」登记真实服务地址与环境、配置认证并启用，再检测连接。启用记录不会启动服务进程；连接正常也不代表业务认证或输出映射正确。
3. 在「接口编排」声明输入、步骤和输出，保存后验证定义，再运行测试。分页输入必须是正整数，页码从 1 开始，每页最多 100 条。
4. 在「版本发布」发布并启用版本；Pro「BFF 接入中心」按应用、环境选择已发布接口调用。失败时查看步骤摘要或调用日志；修改草稿后重新测试和发布。

接入和排障入口保留应用、环境及接口上下文：上游行内「配置接口」进入同应用、同环境的编排列表；接口「前往发布」定位对应发布记录；发布页可返回草稿或查看调用日志。使用流程中的跳转也会保留当前应用和环境，新建服务或接口默认沿用列表范围。

发布前检查展示未满足条件的数量，并按权限提供应用、上游或草稿的处理入口；入口路径冲突可查看同环境的发布接口。回滚和启用检查针对已发布快照，修改草稿不会修复既有快照。若版本操作发生并发冲突，窗口禁止继续提交旧版本，需从刷新后的列表重新打开。

告警详情可按应用、环境、关联接口及观测时间窗口查看调用日志，应用级告警也可定位相应范围。调用详情可返回运行版本或当前草稿；这些页面展示当前配置，当次调用以日志中记录的版本及步骤摘要为准。结果未知的写调用仍须核对上游业务结果，不自动重试。

本机 Pro 需要同时运行 `pnpm bff:dev-bridge`（3037）和 Pro 开发服务（3006），BFF 开发服务在 3010。两端现有桥接配置需匹配。Pro 业务列表通过 `@/api/bff` 的 `fetchBffCatalog` 获取有权访问的接口，再将 `fetchBffPage(api, input, { current, size })` 作为 ArtTableQuery 数据来源；不要在页面保存 BFF 或上游服务密钥。

- 每个步骤可配置 HTTP 响应或业务码响应合同：声明成功码与数据 JSON Pointer。数字 `200` 和字符串 `"200"` 严格区分；HTTP 200 中的业务失败不会被当成成功，也不透传上游错误正文。
- 分页合同声明记录位置、总数来源、页码及每页条数输入和允许输出的字段。支持页码或 offset/limit 上游，以及 PostgREST `Content-Range`；未知总数会提示合同错误，不伪造总数。每页最多 100 条、32 个字段、64 KiB。
- 统一成功响应为 `{code:200,msg,requestId,version,data}`；分页 `data` 为 `{records,total,current,size}`。旧标量定义和不可变发布版本仍受支持。
- Pro 公共 npm 包提供 `@/api/bff` 和完整 **BFF 接入中心**。启用 `VITE_BFF_ENABLED=true` 后，只有服务端确认当前账号具有 BFF 访问权限才贡献动态菜单；默认关闭，既有业务菜单保持原行为。
- GitHub Pages 上的 Pro 通过已认证的 `bff-gateway` Edge Function 调用独立 BFF 服务。Edge 用 Pro `Auth.getUser` 和有效用户资料检查身份，BFF 再按固定签发者与 subject 核对自己的会员、应用及接口权限。浏览器不接收 BFF 服务密钥、上游凭据或 BFF 令牌。
- 两侧服务端配置同一专用 32 字节 Base64 `BFF_PRO_BRIDGE_SECRET`；Pro Edge 还需 `BFF_SERVICE_URL=https://你的BFF域名` 和准确的 `BFF_PRO_ALLOWED_ORIGINS`。签名绑定请求体，60 秒过期，一次性编号在数据库防重放；浏览器 Cookie 网关的 CSRF 校验继续生效。

## 版本发布与网关

- **服务管理 → 版本发布**：先验证并试运行接口草稿，再发布不可变版本。发布记录固定接口定义与上游配置版本；回滚选择已有历史版本，停用后网关立即拒绝新的调用。
- **调用入口**：`/api/gateway/{应用编码}/{环境}/{接口路径}`，使用 BFF 的 HttpOnly 会话和应用授权；写请求还需要 Origin、CSRF、`BffInterface:InvokeWrite` 和 UUID 格式的 `Idempotency-Key`。
- 同一成员的相同幂等键正在执行时返回 `202 IN_PROGRESS`；已成功请求在 15 分钟内返回加密保存的原结果，不再次调用上游。输入变化、结果过期或执行结果不确定时拒绝自动重放。调用元数据清理后，原键不再提供去重保证。
- 单次执行最多 30 秒；每成员每分钟 120 次、4 个并发，每租户每分钟 600 次、16 个并发。发生权限、发布、配置或凭据变化时，结果按不确定状态处理，通过请求编号核对。
- 上游源站和内网策略仍由部署环境显式配置；业务页面不能绕过 SSRF、元数据地址及重定向限制。

## 调用日志与告警

- **运行观测 → 调用日志**：按应用、环境、接口、请求编号、状态和错误分类检索，查看耗时及步骤状态；不保存输入、上游响应正文、令牌或原始请求地址。
- **运行观测 → 告警中心**：配置失败次数、失败率、超时次数或结果不确定次数，使用 5/15/60 分钟窗口；支持阈值、最小样本量、静默期、立即评估、启停与归档。
- 告警事件支持打开、确认、恢复和关闭。确认只表示有人接手；恢复依据后续真实窗口，不把确认当作业务恢复。
- 后台评估默认每 60 秒执行，支持故障退避和跨租户公平调度。终态调用元数据保留 90 天后分批清理，后台调度可能带来延迟；该保留期也限定幂等键的最长存续范围。
- 新模块完成数据库回滚校验和真实 HTTP 联调后，再通过 scoped `EnableReleaseNavigation`、`EnableObservabilityNavigation` 开放给已有管理员租户。

## 模块字典

业务选项统一使用 pro 的 `useDictionaryOptions`，字典编码按模块集中在 `src/config/dictionaries.ts`。对应状态和身份展示复用 `ArtDictDisplay`，使用同一份字典名称与标签配置。

- **应用管理**：应用状态。
- **成员管理**：访问状态、平台身份。
- **上游服务**：运行状态、认证方式、凭据操作。
- **接口编排**：请求方法、验证状态、输入位置、字段类型、映射来源。
- **系统配置**：网站语言、水印内容、登录验证方式、验证控件尺寸与主题。
- **通用配置**：是否、运行环境，以及共享管理页面使用的通用字典。

应用、上游、接口输入和前序步骤来自业务数据；固定协议枚举来自字典。内置协议值由服务端校验并保持不变，字典管理可维护名称、排序与展示样式。

字典默认项维护在 `server/database/schema.sql` 的 `BFF MODULE DICTIONARIES` 区块。使用 `powershell.exe -NoProfile -File scripts/supabase-management.ps1 -Action SyncBusinessDictionaries` 同步至限定的 BFF 项目。该操作先保存恢复快照、执行两次回滚校验，再幂等补齐缺失项，并验证已有选项及租户隔离。

## 检查

```powershell
pnpm typecheck
pnpm ui:audit
pnpm build
```

## npm 复用约定

- `@/` 指向已安装的 pro 包源码，`@bff/` 指向本工程源码；主仓组件、Hooks 和工具均从 `@/` 引入。
- `src/main.ts` 使用主仓 `bootstrapRuntime` 和 `App.vue`；通过服务端会话接口提供当前用户、权限判断和退出操作。
- 动态业务菜单来自 `/api/auth/session`，由主仓 `RouteRegistry` 和 `ComponentLoader` 注册并自动挂载主仓布局。前端静态路由仅包含认证错误与框架错误页。
- Vite、TypeScript、ESLint、Stylelint、Prettier 和 UI 审查复用主仓配置。`npm run boundary:audit` 阻止公共源码重新复制到本工程。
- `npm run skills:link` 将主仓随包发布的 skills 注册到本工程；安装依赖后自动执行，不维护技能内容副本。
- 升级公共能力：先在 pro 修改和验证，发布提交后更新本工程 `art-supabase-pro` 的固定提交地址，再安装、检查和回归。运行、构建和类型检查均只加载固定 npm 包，不查找旁边的源码目录。
- `npm run check` 运行边界、类型、代码规范、样式和 UI 审查；`npm run build` 验证生产打包。

公共源码旧副本已移至忽略目录 `.artifacts/framework-source-backup`，不参与运行、构建或提交。移出前已保存 Git 基线；工程内不再维护这些公共副本。

详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 系统配置

通过 **系统管理 → 系统配置** 维护系统名称、简称、说明、Logo、浏览器图标和水印，默认名称为“BFF平台”。图片支持 HTTPS 地址或本站相对路径，留空恢复公共默认图标。

页面完整复用 pro 包的标准网站配置界面，不传入 profile、canEdit 或布局裁剪参数。BFF 在 API provider 和服务端对接本租户完整配置、并发校验、图片存储和标准 `System:WebsiteConfig:*` 权限。Logo、Favicon 与菜单品牌字图使用共享上传和资源选择器；AI 通过服务端会话调用 pro 的原有 AI 函数并保留其权限检查。保存后共享侧栏、标题、图标和水印立即同步；其他会话重新加载后取得新配置。并发冲突保留当前输入，由操作者确认重新加载。

BFF 品牌配置按当前租户保存，不修改 pro 的网站设置、账号、注册或登录策略。身份认证始终使用 pro 的同一登录表单，BFF 不再提供本地登录卡片。

构建默认输出到 `docs/`，生产服务与产物检查读取同一目录；可通过 `VITE_OUT_DIR` 调整。架构文档保留在根目录 `ARCHITECTURE.md`，不参与构建清空。
