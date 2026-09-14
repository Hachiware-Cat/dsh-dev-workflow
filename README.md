# dev-workflow

> 把「多个 AI 角色协作做一个软件项目」从**靠模型自觉转述**变成**由插件保证送达**。

DSH（DeepSeek Harness）host 平面插件：**七个模型工具 + 24 份随包技能 + 四份角色档案**。
每个角色是一个独立子会话（带自己的角色人格），角色之间的互呼由插件代投；等待关系、熔断窗口、
仲裁队列、台账、开工记忆全部落盘，跨重启保留。

**版本 0.0.1** · 零第三方运行时依赖（`lib/index.js` / `lib/feature.js` 只用 `node:` 内置模块；入口对 `schemastery` 的引用是 `try/catch` 的可选增强，取不到就用保底 schema）· [MIT](./LICENSE)

---

## 总开关（设置 → dev-workflow 预设）

插件自带一个总开关，出现在 **设置** 左侧导航最后一项（卡片样式与「皮肤」同一套）：

| 开关 | 预设名册 | 插件功能 |
|---|---|---|
| **开**（默认） | `dev-workflow` 显示在 Agent 预设与新会话的选择里 | 功能已挂载：七个工具 + 24 份随包技能可用 |
| **关** | 预设目录改名搬到同根 `.disabled/`，名册里不再显示 | 功能从进程里卸下：七个工具与随包技能当场注销，**功能模块也不会被 import** |

**「停用」不是「删除」**：插件包、预设文件、运行态（`~/.dsh/dev-workflow/`）全部原样留在磁盘上，重新打开即恢复。开关值写在 `~/.dsh/settings.yaml` 的 `dev-workflow:` 节，重启后保持。

**两条硬要求**：① 只有**装了本插件**的 profile 才显示「工作流模式」预设与设置里的开关；② 开关**关着**就不显示它。名册的默认根 `$DSH_HOME/.agent-presets` 是所有 profile 共用的，而本插件按 profile 安装——作用域不一致，所以 `install.mjs` 会给该 profile 挂一个**私有名册根**（`<profile>/agent-presets/`，预设本体也在那儿，来源在仓库 `preset/dev-workflow/`）。见 [`使用说明.md` §8.0](./使用说明.md)。

机制：组合里那一行 `id: dev-workflow` 加载的是 **入口 `lib/index.js`**（常驻——否则关掉之后没人能把开关打开），功能本体是 **`lib/feature.js`**，由入口按开关值挂载 / 卸下；开关卡片是 **`lib/client.js`**（浏览器半侧）。详见 [`使用说明.md` §零](./使用说明.md)。

---

## 它解决什么

| 问题 | 这个插件的做法 |
|---|---|
| 角色之间要互相喊话，靠模型记得调 `send_message` | `relay` 由插件**代投**，并渲染等待图 / 熔断 / 仲裁队列 |
| 派角色要手写人格、工具集、工作目录 | `relay_spawn` 按档案注入 persona；只读档案自动收敛为只读工具集 |
| 「需求最终稿交用户审核」只是一句人设，没机制托底 | **需求确认门**：未登记用户确认前，生产角色（`@be`/`@fe`/`@dba`…）不派活；确认钉在需求文档的 SHA256 上，改一版即作废 |
| 流程状态靠模型口头描述，换个会话就断片 | `workflow_state_*` 落盘 `docs/workflow/流程状态.md`，随时可续跑 |
| 接口契约各说各话 | `api_contract` 提供 OpenAPI / GraphQL / proto 模板与 lint（ERROR > 0 即 FAIL） |
| 重启后什么都不认 | 等待关系 / 熔断窗口 / 角色绑定 / 台账 / 开工记忆全部落盘 |

## 需求确认门

pm 的人设一直写着「需求最终稿必须停下来交用户审核（唯一不受「开工授权」影响的硬关卡）」——
但此前**没有任何机制托底**：门、校验、断言一个都没有。现在它由两半合成，**先记账、后上锁**：

| 一半 | 落点 | 事实 |
|---|---|---|
| ② 记账 | `workflow_state_save requirementApproval={by:"user", note:"…"}` | 把「用户批准的是**哪一版**需求」记成结构化事实：需求文档（默认 `docs/workflow/项目经理.md`，档案可用 `requirementFile` 覆盖）的 **SHA256 指纹** + 时间 + 登记人 + 有没有外部证据 |
| ① 上锁 | `kickoff` 与 `relay_spawn` 在「生产角色**首次**入场」这一格拦下 | 判据不是「某条待办勾没勾」（那是自证），而是 ② 那个指纹字段 |

三条硬规矩：

1. **指纹漂移即作废**：需求文档改过之后，上一句「用户已确认」自动失效，门重新关上（与 `api_contract` 的 spec 指纹同一套口径）。「确认」不是一次性的橡皮图章。
2. **钥匙只在人手里**：登记只收**主会话**（DSH 眼里确切的 live runtime root）的调用。角色子会话连用户都问不到 —— `ask_user_question` 对「归属于另一个 agent 的子级」直接抛 `DELEGATED_CALLER` —— 所以它写的「用户已确认」没有事实可核，直接拒。主会话亲手派一个未确认的生产角色**放行但留痕**（回执一行 + 台账一笔「未确认即派活」），门挡的是「流程自动往前跑」，不是「人想立刻开工」。
3. **必须留逃生阀**：`docs/workflow/.active` 里写一行 `approval=skip` 即放行（用户侧，不经模型）；配置 `requirementApproval: "track"`（只记账不拦）/ `"off"`（都不做）可整档降级；档案里给角色写 `awaitRequirement: false` 可逐角色豁免。误拦会让流程直接停摆，比「少拦一次」贵得多。

「自证」与「有据可查」在回执里**分开说**：进程内观测到该会话为该项目调用过 `ask_user_question`，就记下时间戳；观测不到就照写「未观测到向用户提问，这条是自证的」。不拦，但绝不冒充有据可查。

被门拦下的角色进 `kickoff` 回执的第四档 **`deferred`**（不是 `failed`：它没出错，只是还没到入场的时候）。
协调者（它要写需求）、只读角色、以及 `@arch`（pm 人设要求可行性一律互呼它）不受门约束。

## 七个工具

| 工具 | 作用 |
|---|---|
| `relay` | 互呼编排：10 个 action，含一句话开工 `kickoff`、台账 `ledger`、仲裁 `arbitrate` |
| `relay_spawn` | 派角色子会话（注入人格；只读档案自动收敛工具集） |
| `workflow_state_status` | 读流程状态：激活门 / 档案 / 待办 / 契约 / 预设自动激活的可观测面 |
| `workflow_state_load` | 读状态文档全文 |
| `workflow_state_save` | 渲染状态文档全文并回传，由主会话落盘（插件自身无工作区写权限） |
| `workflow_state_use` | 多流程并行：切换到 `流程状态-<需求名>.md` |
| `api_contract` | 契约 `guide` / `template` / `lint` / `checklist` / `status` |

## 四份档案

| 档案 | 角色 | 适用 |
|---|---|---|
| `standard` | pm / arch / be / fe / qa | 完整流程 |
| `lean3` | pm / be / qa | 小需求或原型期，砍掉架构与前端两条并行线 |
| `review` | arch / qa（都是只读） | 只做架构评审与质检，不产出代码 |
| `platform6` | pm / arch / be / fe / dba / qa | 大项目 |

## 随包 24 份技能

`api-architect` 是 `api_contract` 的可执行一面（契约模板 + 限流 + 安全）；另有五个角色人设点名的
**23 份联动技能**：

- **通用**：`test-driven-development`、`systematic-debugging`、`testing-strategy`、`requesting-code-review`、`spike`、`grill-me`、`ponytail`、`api-docs`、`architecture-diagram`、`excalidraw`
- **Java / Spring**：`spring-boot-project-creator`、`spring-boot-rest-api-standards`、`spring-boot-crud-patterns`、`spring-boot-test-patterns`
- **Python / Django**：`django-patterns`、`django-security`、`django-tdd`、`python-project-structure`、`python-error-handling`、`python-testing-patterns`
- **前端 / 设计**：`frontend-design`、`ui-ux-pro-max`、`impeccable`

技能不是「随包放着」而已：候选会按**激活门**与**当前档案的角色集**双重收窄后才进技能目录 ——
角色人设里那句「联动技能（按需加载）」才是真做得到的。

## 安装

安装 = **① 把包放到位** + **② 让组合加载它**。本插件是零第三方运行时依赖的 host 静态行，
所以第一步不牵扯依赖树。

```powershell
# 推荐：DSH 官方入口。包内声明了 dsh.bundle，装完会自动加入 profile 的 bundles，不用手写激活行
dsh plugin --profile web add dsh-dev-workflow        # 从 npm 装
dsh plugin --profile web add .\dsh-dev-workflow             # 从本地克隆目录装

dsh plugin --profile web remove dsh-dev-workflow     # 卸载
```

装完 **重启 DSH** 生效 —— 插件在宿主启动时加载。

<details>
<summary>手工路线（npm / 离线 / 内网）</summary>

```powershell
npm pack                                    # ① 产出 dsh-dev-workflow-<版本>.tgz
$dst = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-dev-workflow"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
tar -xzf .\dsh-dev-workflow-*.tgz -C $env:TEMP
Copy-Item "$env:TEMP\package\*" $dst -Recurse -Force   # ② 铺进 node_modules
```

这条路**不在 bundles 里**，所以要自己在 profile 的 `cordis.patch.yml` 加一行同 id 的 `insert`：

```yaml
- insert:
    - id: dev-workflow
      name: ./node_modules/dsh-dev-workflow/lib/index.js
```

⚠️ 别在 profile 目录里跑 `npm install` —— 那是个 pnpm 工程，要用包管理器就走上面 `dsh plugin`。

</details>

## 快速上手

```
relay action=kickoff goal="给订单服务加一个取消接口"   # 一次派齐当前档案的角色，并投递开场指令
workflow_state_status                                  # 看激活门 / 档案 / 待办 / 需求确认门
relay action=status                                    # 看等待图 / 熔断 / 台账 / 技能可见数
```

开工路径上，**生产角色要等需求确认**：`kickoff` 回执里 `deferred(N)` 就是它们，出路写在 `nextActions` 里。
四条出路任选：让主会话确认后登记（`workflow_state_save requirementApproval={by:"user"}`）、
用户在 `docs/workflow/.active` 写一行 `approval=skip`、配置降级 `requirementApproval: "track"`、
或给角色写 `awaitRequirement: false`。

**开工不需要先建任何文件**。激活门有四条来源：`docs/workflow/.active`、插件记忆、项目里已有的状态文档、
以及 `dev-workflow` 预设（在该预设下开会话即自动开工）；`.active` 里写 `off` 压过一切，用户关得掉。

> 「dev-workflow 预设」是**每个 profile 私有**的可选件（`<profile>/agent-presets/dev-workflow/`），
> 本体随包发布（`preset/dev-workflow/`，在 `files` 白名单里），由 `install.mjs` 铺进 profile；
> 没有它插件照样可用，只是每次开工要显式 `kickoff` 或写一次 `.active`。
> 设置里的**总开关**控制的就是它：关掉会把预设搬进同根的 `.disabled/`（名册里不再显示），
> 打开再搬回来；插件功能本身也随开关挂载 / 卸下（见上文「总开关」）。

## 文档

- [`使用说明.md`](./使用说明.md) —— 完整手册：上手八步、工具参考、**14 条踩坑约束**、自定义档案、排查表、安装细节

## 开发

```powershell
node selftest.mjs         # 290 条 —— 功能本体纯逻辑(lib/feature.js)
node smoke.mjs            # 811 条 —— 功能本体端到端(从安装位置复跑时加 DSH_SMOKE_TMP=<可写目录>)
node switch.selftest.mjs  #  10 条 —— 总开关:预设搬迁 + 挂载/卸下 + "关闭时不 import"
node switch.smoke.mjs     #  12 条 —— 开关卡片:假浏览器里真加载 bundle、点开关写设置
```

四套断言都**不依赖 DSH**，可以直接在克隆目录里跑。功能本体在 `lib/feature.js`（七个工具 + 24 份随包技能），
入口在 `lib/index.js`（常驻，注册设置里的总开关，并按开关值挂载 / 卸下功能本体）。

## 许可证

[MIT](./LICENSE)
