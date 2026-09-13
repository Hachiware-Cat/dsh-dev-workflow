---
name: api-architect
description: >
  专家级 API 设计:REST / GraphQL / gRPC / WebSocket 契约。用于 API 设计、端点设计、
  OpenAPI/Swagger、GraphQL schema、gRPC service、协议缓冲、API 版本化、错误结构、
  分页、限流、OAuth/JWT 鉴权。随 dsh-plugin-dev-workflow 一起发布,
  并由 api_contract 工具提供模板、lint 与质量清单。
whenToUse: >
  当任务涉及接口契约(端点、请求/响应结构、错误码、版本策略、分页、限流、鉴权)时加载。
  dev-workflow 流程中由 ② 架构师在产出「API 契约」小节前加载;③ 开发按它实现;④ 质检按它核对。
version: 0.0.1
---

# API Architect(随 dev-workflow 发布)

> 随 `dsh-plugin-dev-workflow` 一起发布:技能文本与五份参考件收进插件包
> (`skills/api-architect/`),可执行的一面由插件工具 `api_contract` 承接 ——
> 选范式 / 取模板 / lint 校验 / 质检核对表 / 现状,五条都在那里。
>
> **版本口径**:上面的 `version` 跟**随包的插件版本**对齐(技能文本本身没有独立的发布节奏)。
> 它只在该技能文件被改写时跟着插件版本一起推进;**插件版本变更不会自动改写这里**,
> 所以它是一份"随包快照"的标注,不是运行时读出来的值 —— 运行时读的是
> `api_contract action=status` 回报的插件 `VERSION`(以及 `relay action=status` 的
> `apiView.skill`,那里把技能版本与插件版本并排显示,不一致会点名)。

## 一、在 dev-workflow 里怎么用(四步)

| 步骤 | 谁 | 动作 |
|---|---|---|
| 1. 选范式 | ② 架构师 | `api_contract action=guide` —— REST 做 CRUD、GraphQL 做灵活查询、gRPC 做内部服务 |
| 2. 取模板 | ② 架构师 | `api_contract action=template kind=openapi\|graphql\|proto\|ratelimit\|security` → 用 `write` 落到 `docs/api/` |
| 3. 自检 | ② 架构师 | `api_contract action=lint` → **verdict 必须是 `pass` 才准写「API 契约」小节**:`no_specs` = spec 没落地;`pass_with_skips` = 有候选被跳过、这条结论只覆盖**已扫到的**候选(跳过按"处"算:一处 = 一个文件或一棵未展开的子树,有子树时连分母都无法确定;跳过**记录**多到明细放不下时会写成 `≥N 处`,见下)—— 两种都不是通过 |
| 4. 登记 | ② 架构师 | spec 路径 + 版本策略 + lint 结论(**含覆盖面**)写进 `架构师.md` 的「API 契约」;契约变更走 `workflow_state_save contractRevision` |

> **候选被跳过时怎么办**:lint 会按原因分组留痕,照它的分支处理 ——
> `depth`(超过 2 层)用 `paths` **精确指到文件**可以补进结论(指到它 2 层内的目录同样有效;
> 指到更高的祖先目录仍会因深度被跳过);`oversize`(超过 512 KB)
> **精确指路无效**(size 守卫对 `paths` 同样生效),只能拆到上限以下,或确认它不属于本项目契约
> 并在「API 契约」小节**显式登记为未校验 + 原因**。`paths` 的语义是**追加**(默认候选目录 ∪ paths),
> 不是"只扫这里"。
>
> **看到「明细已截断」时**:留痕里的 `跳过 N 处` 会写成 `≥N 处`,并且紧跟一行
> 「本次共记下 M 条跳过记录,留痕只保留前 20 条明细;另有 K 条连明细都没有」。这是**如实交代**,
> 不是让你去找全量 —— **没有**这样的字段(`payload.scanSkipped` 就是那批明细,同样没有它们)。
> 这时要做的是:按已列出的那些先处理(depth 补进结论 / oversize 拆小或登记未校验),
> 并把「跳过记录还有 K 条没有明细」**如实登记**在「API 契约」小节旁边 —— 别写"已全部覆盖"。

下游:③ 开发**按 spec 实现**(字段名/状态码/错误结构逐一对齐,不自行发明接口);
④ 质检**核对实现与 spec**(路径/方法/字段/状态码/错误结构),口径是 `api_contract action=checklist`。

> 契约优先(API-first):`设计契约 → 生成桩 → 实现 → 对着 spec 测`。spec 是唯一基准,代码不是。

## 二、核心能力

| 领域 | 技术 |
|------|------|
| **REST** | OpenAPI 3.1、HATEOAS、分页(游标/页码) |
| **GraphQL** | SDL、Relay 连接、DataLoader、Federation |
| **gRPC** | Protocol Buffers、四种流式模式 |
| **Security** | OAuth 2.0、JWT、API Key、RBAC |
| **DX** | Swagger UI、SDK 生成、沙箱环境 |

## 三、架构模式

### API-First
```
设计契约 → 生成桩 → 实现 → 对着 spec 测
```

### 响应信封(全局统一,别一处一个样)
```yaml
success: { data: <resource>, meta: { page, total } }
error:   { error: { code, message, details: [{ field, issue }] } }
```

### 版本化三选一(先定,再发第一个版本)
- URL:`/v1/users`(最直白,推荐对外)
- Header:`Accept: application/vnd.api+json;version=1`
- Query:`/users?version=1`

## 四、十条反模式(踩了就返工)

| # | 症状 | 修法 |
|---|------|------|
| 1 | 动词化 URL `/getUsers`、`/createOrder` | 用名词 `/users`,动作交给 HTTP 方法 |
| 2 | 信封不一致(有时 `{data:[…]}`,有时裸数组) | 全站统一信封 |
| 3 | 破坏性变更不留版本 | 语义化版本 + 弃用头 + 下线期 |
| 4 | GraphQL N+1(列表里逐条查库) | DataLoader 批处理、`@defer` 大载荷 |
| 5 | REST 过度返回(50 字段只用 3 个) | 稀疏字段集 `?fields=id,name` 或改 GraphQL |
| 6 | 列表不分页(返回全量) | 默认上限 + 游标分页 + `hasMore` |
| 7 | 没有幂等键(重复 POST 建重复资源) | 收 `Idempotency-Key`,回放缓存响应 |
| 8 | 泄漏内部错误(栈/SQL 进 500) | 生产只回通用文案 + request id |
| 9 | 没配 CORS(浏览器端全被拦) | 显式配 origins/methods/headers |
| 10 | 没有限流(被刷穿且无用量视图) | 按档位限流 + 回 `X-RateLimit-*` |

## 五、质量清单(`api_contract action=checklist` 会逐条对文件核)

```
[ ] 端点全部用名词,动词交给 HTTP 方法
[ ] 响应信封全局一致
[ ] 错误响应带错误码与可执行文案
[ ] 所有列表端点都有分页
[ ] 鉴权/授权已写明(securitySchemes)
[ ] 限流头已定义
[ ] 版本策略已写明
[ ] CORS 只放已知来源
[ ] 变更类操作支持幂等键
[ ] OpenAPI spec 校验无 ERROR
[ ] SDK 生成验证过
[ ] 每种请求/响应都有示例
```

## 六、参考件(相对本技能根目录)

| 文件 | 内容 |
|------|------|
| `references/openapi-spec.yaml` | 完整 OpenAPI 3.1 spec 示例 |
| `references/graphql-schema.graphql` | 带 Relay 连接的 GraphQL schema |
| `references/grpc-service.proto` | Protocol Buffer,含全部流式模式 |
| `references/rate-limiting.yaml` | 按档位的限流配置 |
| `references/api-security.yaml` | 鉴权、CORS、安全响应头 |

> 取模板不要直接读这些文件:**用 `api_contract action=template kind=<openapi\|graphql\|proto\|ratelimit\|security>`** ——
> 它返回的就是上面这几份的全文,省掉一次路径猜测。

> 要校验一律用 `api_contract action=lint`(纯 JS,递归扫候选目录、结论落插件状态、可指纹核对 ——
> 见 lib/feature.js 的 `templateDumpFindings` / `lintApiFiles`)。

## 七、校验是怎么做的

1. **不依赖 bash**:校验是纯 JS(`api_contract action=lint`),递归扫描项目根下的候选目录
   (`api/`、`openapi/`、`docs/api/`、`docs/`、`proto/`、`graphql/`、`schema/`、`spec/` 与根目录),
   并把结论写进插件状态,`relay action=status` 与流程状态文档都能读到。
   > 校验一律以 `api_contract` 工具为准:它递归扫候选目录,结论可核对,
   > 不依赖"只在当前目录 glob、靠 `grep -q` 判定"的那类脚本。
2. **判定口径**:ERROR / WARN 两级 + `ERROR>0 → FAIL`、`WARN>5 → 通过但有告警`。
3. **边界**(仅作分工提示):数据模型归 ② 架构师在「数据模型」小节,前端消费归 ③′ 前端,部署另有其人 ——
   本技能只负责接口契约。

## 八、输出产物

1. OpenAPI spec(契约)　2. GraphQL SDL　3. `.proto`　4. 开发者文档
5. SDK 示例　6. Postman/HTTP 用例集

## 九、工具(DSH 名称)

> 本节一律用 **DSH 的实际工具名**。别处见到的 `Read` / `Write` / `Edit` / `Bash(npx:*)` 这类写法
> 在 DSH 里**不存在**,照抄会调用失败(本技能统一改成下面这些名字)。

- `read` / `write` / `edit` —— 落盘 spec(插件本身无工作区写权限,spec 由**会话**用 `write` 落 `docs/api/`)
- `api_contract` —— `guide` 选范式 / `template` 取模板 / `lint` 校验 / `checklist` 核对 / `status` 看现状
- `pwsh` —— 需要时跑 `npx @redocly/cli lint`(OpenAPI 校验)或 `npx openapi-generator-cli`(SDK 生成);
  这两个是**可选**的外部工具,没装就别引,`api_contract action=lint` 已经覆盖核心规则
