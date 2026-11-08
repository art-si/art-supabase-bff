# pro 运输协同：调度资源综合核验

## 首个业务验证

入口位于 pro TMS 的「待配载派车」配载/拆单弹窗。选择车辆或司机后，具有 `TmsPendingWaybillList:ResourcePreflight` 权限的人员可以打开「调度资源综合核验」。抽屉把 TMS 调度提醒和 VMS 证照风险放在两个页签中，提供加载、错误重试、账号不一致及租户切换反馈。

该能力只读；原有调度提交、证照阻断、例外确认与业务状态转换继续执行现有规则。没有修改运输单、车辆、司机或证件记录。

## 真实数据来源

- `tms_check_dispatch_advisories_secure(p_order_id,p_vehicle_id,p_driver_id)`：现有调度业务权限与订单租户范围检查。
- `vms_check_dispatch_certificate_risk_secure(p_vehicle_id,p_driver_id)`：现有车辆/司机证照过期、撤销检查与例外权限。

两者均为 pro 已有 STABLE RPC。BFF 使用当前 BFF OAuth 会话所属的 pro 用户 JWT 调用固定 RPC，使用 pro 的公开项目键作为网关键，不使用 pro service role。所选租户通过现有 `x-art-tenant-scope` 机制传递，pro 数据库继续决定该账号可以读取的范围。调用方传入的 pro 用户标识只用于两边账号一致性核对，不授予权限。

单次核验的租户来自原始运输单；平台“全部租户”下也使用这张单据的具体租户发起核验。若全局已选租户与单据不一致，前端阻止请求。两个现有 RPC 因此在同一具体范围核对订单、车辆与司机，避免跨租户对象拼接造成误导。

## BFF 约束

`GET /api/integrations/pro/dispatch-preflight` 需要有效 BFF 会话、`BffProTransport:View` 及启用的 `pro-transport-pilot` 应用授权。权限入口登记在 BFF 应用管理菜单下。普通成员需要单独授予应用与动作权限。

返回内容只包含调度提醒、证照风险、例外能力、核验时间和本次编号，不包含 token、供应商配置、证件号码或完整上游响应。任一 RPC 失败时整次核验失败，不将缺失数据解释为安全。

这是固定业务聚合端点的首个验证，尚未改造为可配置的发布网关图；本次编号不对应版本接口调用日志。不要将该验证报告为已跑通可配置编排/发布流程。

## 配置与部署范围

通过 `scripts/supabase-management.ps1 -Action SyncProTransportPilot` 分别对两个限定项目执行对应的元数据增量：

- BFF 项目：canonical `BFF PRO TRANSPORT PILOT` 区块、应用和权限。先备份、回滚校验，再应用。
- pro 项目：仅新增 TMS 叶子菜单下的按钮权限，继承其 `app_code`。不对 pro 执行 BFF schema。
- `BFF_PRO_PUBLIC_KEY` 仅在服务端保存 pro 的 anon/public 项目键。
- `BFF_PRO_INTEGRATION_ORIGINS` 限定本地 pro 源站。
- TMS 的 `VITE_BFF_ORIGIN` 可指定集成地址；开发环境默认 `http://localhost:3010`，生产环境必须显式配置。

当前浏览器入口用于 `localhost:3006` 与 `localhost:3010` 的同站点本地演示，并要求同一账号在 BFF 中登录。独立站点部署不能依赖 SameSite=Lax cookie+CORS；应由统一 pro Edge 签名桥承载，再复用此业务聚合逻辑。不要将浏览器 JWT 或服务密钥写入新的前端存储。

## 验证入口

- BFF：`tests/unit/pro-transport.test.ts`、`tests/integration/pro-transport-pilot.sql`。
- TMS：`tests/unit/dispatch-preflight.test.ts`、`tests/playwright-preflight.config.ts`。
- 浏览器测试使用合成数据覆盖风险、重试及窄屏；真实业务函数使用限定 pro 项目的只读事务检查。浏览器到 BFF 的真实 HTTP 联调必须另有有效的统一登录会话，不能用模拟测试替代。

2026-11-08 的限定项目只读事务验证得到：选定运输单与车辆存在 1 条调度提醒、0 条证照阻断项；平台全部范围读取也返回 1 条提醒；无效的其他租户范围被数据库拒绝。事务已回滚，没有修改业务数据。该结果属于真实业务函数验证，不代表已完成真实浏览器登录到 BFF 的端到端调用。

同日，用户重新登录后，使用实际 BFF 会话调用聚合服务，经 HTTP 请求 pro 的两个现有 RPC，成功返回 1 条调度提醒、0 条证照风险、未阻断。联调修复了原始 RPC snake_case 字段与业务 DTO camelCase 的差异，复用 pro 的 `keysToCamelDeep` 公共方法。5 项聚合服务测试、服务端类型检查及格式检查通过；登录失效提示浏览器测试也通过。此证据覆盖服务端到 pro 的真实 HTTP 调用，浏览器通过 BFF 路由的完整链路仍需另行核验。

后续完整的 3 项合成浏览器测试全部通过（核验结果与重试/窄屏、无权限隐藏入口、未登录时提供登录入口）。本地 BFF 与 pro 开发服务改为独立隐藏后台进程启动，分别监听 3010 与 3006，避免终端会话结束导致服务退出；启动日志保存于本地忽略的 `.artifacts/*-dev-service.*.log`。
