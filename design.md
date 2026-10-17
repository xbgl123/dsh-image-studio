# 图像生成模型扩展（dsh-image-studio）

面向 DSH 模型设置页的「模型扩展类插件」，分两阶段交付：

- **第一部分**：页面结构改造 + 配置项管理 + 数据持久化（图像生成模型接入区）。
- **第二部分**：图像生成任务自动调度核心逻辑 + Prompt 智能转译层（需求识别、能力校验、透传优先转译、自动路由）。

- 插件包：`dsh-image-studio`（Host 半 + Client 半，单包双半）
- 设置命名空间：`image-studio`
- 页面落点：`settings.models.footer`（模型设置页在原生提供商行与「添加模型提供商」之后的有序扩展区）
- 调度落点：`agent/pre-step`（每回合进入模型请求前），以及 `generate_image` 工具（模型/Skill 主动调用）
- 安装方式：`plugin_manager action=install_bundle`，已装入 `desktop` profile

> **第二部分需要重启应用才生效。** Host 半是普通 JS 模块，`dsh-client-modules` 的 HMR 只覆盖
> `cordis.patch.yml` 配置变更，不重新导入已装载的插件模块——运行中的 `image-studio` 行仍是第一部分的 schema。
> 重启后请用下面的「第二部分自检」确认。


## 1. 需求与实现对应

### 第一部分：接入配置框架

| 需求 | 实现 | 状态 |
| --- | --- | --- |
| 原生对话类模型配置统一归为「默认对话模型接入区」 | 原生 `@deepseek-ai/dsh-client-ui-settings-models` 的整块内容（DeepSeek 内置账号、豆包/GLM 等第三方目录提供商、自定义模型 API、新增/编辑/删除/设为默认/多协议）**零改动**保留，仍在该页首区渲染 | 已满足（见 §4 的 slot 限制说明） |
| 新增独立「图像生成模型接入区」，与对话模型区物理分隔 | 注册为 `settings.models.footer` 的独立 section，带 `border-top` 分隔线与独立标题/说明，位于原生行之后 | 已满足 |
| 通过自定义 API 接入任意图像生成模型 | 每条记录含 `protocol`（OpenAI Images / OpenAI Images Edits / Stable Diffusion HTTP API / 自定义）、`baseUrl`、`apiKey`、`model`、`headers[]`、`params` | 已满足 |
| 可配置 API 密钥、接口地址、模型标识、自定义请求头、参数模板 | `apiKey`、`baseUrl`、`model`、`headers[{name,value}]`、`params{size,width,height,steps,timeoutMs}` | 已满足 |
| 每个图像生成模型独立配置 Prompt 格式预设 | `promptFormat` ∈ {`natural` OpenAI 自然语言, `sd-tags` SD 标签权重, `custom` 自定义模板} | 已满足 |
| 单独配置前置默认词、负面默认词 | `promptPrefix`、`promptNegative`（`custom` 模式另有 `promptTemplate`，支持 `{prompt}`/`{prefix}`/`{negative}`） | 已满足 |
| 多模型：添加、编辑、删除 | 行内编辑器；`+ 添加图像生成模型`、`编辑/收起`、`删除`（二次确认） | 已满足 |
| 默认值：任一模型设为全局默认，同一时间仅一个 | 行内「设为默认」与编辑器复选框；保存时同一次 `mutate` 内清除其它记录的 `isDefault` | 已满足 |
| 配置本地持久化，重启后自动加载 | 写入 profile 的 `cordis.patch.yml`（`config-editor` 的文档）；`imageModels` 为 volatile 节点 | 已满足 |

### 第二部分：调度与转译

| 需求 | 实现 | 位置 |
| --- | --- | --- |
| 1 需求识别（全场景：用户对话 / Agent 任务 / Skill） | `detectImageIntent` 三源解析：命令式短语、意愿句、「生产动词 + 图像名词」；能力提问（"能图像生成吗"）与否定（"不要画图"）都不触发 | `src/intent.mjs` |
| 2 能力校验 | `conversationModelGeneratesImages` / `routeRequest`。**DSH 目录里不存在"输出模态"这一概念**（`ModelModality` 只有 `text`/`image` 且是*输入*，运行时会剥离未知字段），因此只能由用户显式声明 `nativeImageRoutes` | `src/router.mjs` |
| 3 Prompt 智能转译（透传优先 / 最少修改 / 格式匹配） | 格式相同 → **逐字透传**（测试断言 `prompt` 与输入完全相等）；格式不兼容或策略要求 → 才转换；参数（尺寸/数量/步数/超时）始终映射到 API 字段 | `src/prompt.mjs` |
| 3 Skill 来源识别 | `source: 'skill'` → 标记为「已优化 Prompt」，关闭默认词补全与风格增强；且**永不改写**其正文（格式不兼容时选择保留原文而非转换） | `isOptimizedPrompt` |
| 3 可配置强制开关（三档） | 每个模型的 `promptPassThrough` ∈ {`auto` 默认, `always` 强制透传, `never` 强制转换}，设置页格式配置组内有下拉 | `client.js` + `src/prompt.mjs` |
| 4a 对话模型自带图像生成能力 → 不切换 | 命中 `nativeImageRoutes` 时直接放行：不生成、不调用第二个端点、`agent/pre-step` 决策对象原样返回 | `routeRequest` → `{kind:'native'}` |
| 4b 无图像生成能力 → 无感调用全局默认图像生成模型 | `agent/pre-step` 内调用默认图像生成模型，把生成结果作为**本步骤的 user 消息**（含 image block）追加进决策，模型与路由都不变、不中断对话 | `index.js` `scheduleBeforeStep` |
| 4c 未配置/未设默认 → 引导提示 | 返回同时给用户与模型看的一句引导（指向 设置 → 模型 → 图像生成模型接入区），并明确「设为默认」 | `routeRequest` → `{kind:'unconfigured'}` |
| 5 主链路可运行 | 两条入口共用同一个 `runImageRequest`：真实 HTTP 调用、真实附件持久化、结果回到当前对话上下文；`generate_image` 工具供模型/Skill 主动调用 | `src/generate.mjs`、`src/tool.mjs` |

**为什么"能力校验"要用户显式声明**：`@deepseek-ai/dsh-llm` 的 `LlmModelInfo` 只有 `inputModalities?: readonly ModelModality[]`，
`ModelModalityMap = { text, image }` 且语义是*请求输入*；`listModels` / `normalizeModelInfo` 会把适配器返回的
额外字段重建剥离，插件无法通过目录注入自定义能力位。`dsh-llm` 里也没有任何"模型产出图片"的内容块或流式分支
（`StreamChunk` 无 image 变体）。因此猜测（例如用 `inputModalities.includes('image')`）会误判——那表示*能看图*。
唯一可审计的做法是配置里的白名单，这也与仓库内 `dsh-tool-subagent` 的 `allowedModels` 先例一致。


## 2. 数据模型（Host `Config`）

```js
// dsh-image-studio/index.js
const imageModel = z.object({
  id, name, protocol, baseUrl,
  apiKey: z.string().role('secret').default(''),   // 写后只回存在性标记，永不回显
  model, headers: [{ name, value }],
  promptFormat, promptPrefix, promptNegative, promptTemplate,
  params: { size, width, height, steps, timeoutMs },
  isDefault,
})
const Config = z.object({ imageModels: z.array(imageModel).default([]).volatile() })
```

要点：

- **密钥只写不读**：`apiKey` 带 `role('secret')`，Settings 服务的远程读取会把它剥成 `secrets[].{path,set}`。
  页面因此只会显示「已保存 / 未保存 API 密钥」的圆点，输入框留空表示保留原密钥。
- **整表一个 volatile 节点**：Loader 规定 volatile 字段不能嵌套在 volatile 容器内（`dsh-app-boot` 的
  `validateVolatilePlacement`）。正因为 `apiKey` 是 secret 角色，列表整体必须放在唯一的 volatile 节点上；
  页面通过 `settings.mutate` 的路径操作逐字段写入，不触碰密钥字段。
- **协议与格式是封闭枚举**：非法值在 Host 侧就被 schema 拒绝（`Config` 校验失败会让写入被拒），
  页面另有即时校验（名称非空/不重复、base URL 为 http(s)、模型标识非空、自定义模板非空、请求头需有名）。

## 3. 读写链路

```
页面（React，注册进 settings.models.footer）
  └─ ctx.configForms.get('image-studio')        // 共享 describe 镜像，含 revision/writable/secrets
       ├─ 读：ConfigFormController.getSnapshot()
       └─ 写：ConfigFormController.mutate(ops, revision)
              └─ ctx.remote.settings.mutate → dsh-settings → config-editor.edit
                     └─ profile 的 cordis.patch.yml（持久化 + Loader volatile 提交，无需重启）
```

写操作策略（`client.js` 的 `operations`）：

- 新增：`set imageModels[<末尾新下标>] = <记录>`，记录中**不含** `apiKey`；用户填了新密钥时再追加一条
  `set imageModels[i].apiKey`。这样既保留其它记录已存的密钥，也不会把「读到的空占位」写回去。
- 编辑：逐字段 `set imageModels[i].<field>`；`apiKey` 仅在用户输入时写入。
- 删除：`unset imageModels[i]`（Settings 的语义是**移除数组元素**，不是留空位）。
- 设默认：同一次 `mutate` 内先置目标 `true`、再对其余已为 `true` 的记录置 `false`。
- 每次写入都带页面读到的 `revision`；被外部修改后写入会以 `settings/conflict` 被拒并提示重新打开编辑器。

`smoke.mjs` 用一份 `applyPathOp` 的等价实现覆盖了上述策略，其中一条用例专门证明「把读到的整表写回去会抹掉密钥」，
用以固化「必须走路径操作」这一约束。

## 3b. 第二部分：调度链路

```
用户/Agent/Skill 产生一句"画一张…"
   │
   ▼  agent/pre-step（每 agent 注册在 agent.ctx 上）
detectRequestInMessages(messages)          ← 跳过 source.kind === 'image-studio' 的自己人
   │  命中
   ▼
runImageRequest(state, request)            ← 与 generate_image 工具共用的唯一操作
   ├─ routeRequest: native?  → 放行，决策原样返回，不生成
   │                configured → 用指定/default 图像生成模型
   │                unconfigured → 返回引导文案（作为一条 user 消息）
   ├─ translateRequest: 格式匹配→逐字透传 / 不匹配→转换；参数映射
   ├─ adapters.generate: POST /images/generations | /sdapi/v1/txt2img（真实 HTTP）
   └─ attachments.saveImage(bytes) → ImageAttachmentRef
   │
   ▼
createUserMessage({ content:[text?, image], source:{kind:'image-studio'} })
   │
   ▼
return { ...decision, messages: [...decision.messages, message] }
   → 该消息在本步骤内落为 durable user/message 事件：
     模型上下文看得到（若路由支持图像输入）、对话 UI 渲染图片、对话模型与路由均未改变
```

设计要点与约束（来自 Harness 的实际实现，非猜测）：

- **交付必须走 `agent/pre-step` 的消息重写**，而不是自己造事件：会话日志只认已知事件类型，插件新增
  event type 会让日志在重开时被拒（`unknown to this harness and not marked ignorable`），而 `Session.append`
  无法设置 `ignorable`。图片也必须挂在 durable 消息上才会被客户端渲染。
- **`agent/request` 不能用来传内容**（其文档明确 "cannot mutate messages"）；用户消息的附加只能走
  pre-step 决策或 inbox（`agent.steer/inject`）。
- **插件无法推送 assistant 消息**（inbox 与 pre-step 都只接受 `UserMessage`），所以图片以 user 消息形式进入
  当前步骤，这也是"不中断对话流程"的实现方式：模型在同一回合内继续作答。
- **`this` 不是 payload 字段**：`agent/pre-step` 的实际 dispatch 是 `{ messages, turn, step, signal }`，
  agent 挂在 `this` 上。本插件在 `agent/created` 里按 agent 注册监听并闭包捕获 agent，因此不依赖 dispatch 形状。
- **不引入宿主包依赖**：`@deepseek-ai/dsh-llm` / `dsh-tools` 只在安装目录里可解析，profile 里没有，
  引用它们会让插件在该 profile 无法装载。因此用户消息按文档形状自行构造（`{role, content, source, id}` 并冻结），
  工具按注册表接受的 `ToolDefinition` 形状直接书写（注册表自己校验 schema），参数在 `execute` 内自校验。
- **失败不打断对话**：传输类失败只记日志并原样返回决策；只有"需要用户去配置"的拒绝才作为一条消息呈现。
- **成本保护**：`autoGenerate` 默认开，但同一批消息只触发一次生成；`generate_image` 标记为不可并发。

## 4. 结构改造的边界（已选定方案 C）

模型设置页由 `@deepseek-ai/dsh-client-ui-settings-models` 提供，它对仓库外插件**只声明两个席位**：

- `settings.models.provider-card`（keyed）：渲染在**每一张**提供商卡片内部；
- `settings.models.footer`（list）：渲染在原生行与「添加模型提供商」之后。

页面**没有**「原生模型列表之前的头部席位」。因此在不修改原生包（要求：不改原生逻辑、不做破坏性改动）的前提下：

- 原生区块保持其自身的标题 `Models` 与说明文案，功能与交互 100% 不变 —— 即**方案 C**：现状交付，图像生成区靠顶部
  `border-top` 分隔线 + 独立标题/说明 + 空态卡片形成清晰物理分区；
- 「默认对话模型接入区」这一行**标签**因此不出现。要显示它需要上游新增一个列表前头部席位（方案 A，本次未实现，
  请求片段见 §8），或修改原生包（方案 B，不建议）。

## 5. 验证状态

已在本机会话中验证：

- Host 行已激活：`Config.listConfigs` 返回 `patchId: image-studio`，状态 `schema`，无 limitations；
- 生成的 JSON Schema 正确：`imageModels` 带 `x-cordis.volatile: true`，`apiKey` 带 `x-cordis.role: "secret"`；
- Client 半已执行并注册成功：`Slots.listSubTree('settings.models.footer')` 的 occupants 含
  `{ id: "image-models", order: 20, active: true }`（注册代码在 `apply` 内，能注册即说明 client bundle 已加载执行）；
- **离线真实渲染**：`node checks/render-section.mjs` 通过 —— 它按页面同样的 seam 加载 client bundle
  （捕获 `window.__ModuleLoader__.load`、`require('react')` 用装置自带的 React），伪造 slot props，
  并遍历元素树。这条检查在本轮抓到了**两个真实缺陷**：
  1. 发布的快照里没有 `models` 字段，而视图直接 `models.find(...)` —— 每次渲染都会抛错，被渲染器的
     error boundary 接住，于是整块贡献变成空白（这正是「设置-模型里看不到图像生成区」的原因）；
  2. 视图对快照字段假定过多，任何缺失都会整块崩溃。
     现在快照投影收敛为一个全量函数 `toSectionState()`，视图侧也全部改为安全读取（`Array.isArray` 等），
     并覆盖 `ready / 有记录 / 只读 / unavailable / error` 五种状态；
- **离线交互驱动**：`node checks/interactions.mjs` 通过 —— 它用一个带「跨渲染保留 hook 状态」的假根渲染组件，
  真正点击「添加图像生成模型」、改 Prompt 格式、填字段、点「保存」，并断言写出的路径操作。这条检查抓到了第三个缺陷：
  3. **「添加图像生成模型」点了没反应**：新增记录用的编辑器被渲染在 `if (models.length > 0) { models.map(...) }`
     分支内部，列表为空时根本没有承载它的 `<li>`，于是状态更新了却没有渲染分支。现在新增草稿有自己独立的卡片
     （在行列表分支之外），并顺带修正：草稿打开期间「添加」按钮锁定、编辑器字段 id 全部加 `dsh-img-` 前缀
     （避免与原生提供商卡片在同一文档里撞 id）、以及一处 React `key` 缺失；
- 原生页面未受影响：`settings.models.provider-card`、`settings.models.footer` 席位与其声明者 `mf` 均在，原生 slot 结构不变；
- 纯逻辑：`node smoke.mjs` 全部通过（schema 默认值/拒绝非法枚举/密钥角色/路径操作保密钥/删除即移除元素）；
- 文案键：`node checks/locale-keys.mjs` 通过（中英 79 键完全对齐，视图中 56 个字面键全部可解析）；
- **第二部分核心逻辑**（`checks/intent.mjs` 37 例、`checks/prompt.mjs`、`checks/adapters.mjs`、`checks/router.mjs`、
  `checks/generate.mjs`）全部通过，覆盖：能力提问/否定不触发、以 Skill 来源透传且不改写、格式匹配时正文逐字不变、
  强制透传/强制转换两档策略、尺寸与步数映射、HTTP 与解析失败路径、未配置时给出引导；
- **第二部分 Host 接线**（`node checks/host-wiring.mjs`）通过：用假运行时真正调用 `apply()`，断言工具定义形状、
  每个 agent 的 `agent/pre-step` 监听、图片消息（role/source/冻结状态）被追加进决策、无意图/未命中时决策对象原样返回、
  native 路由完全放行、未配置时引导消息、`autoGenerate:false` 关闭、拒绝决策不被改写、传输失败只记日志。
  这条检查在本轮抓到第四个缺陷：`generate_image` 工具取状态时没有把调用方 agent 传下去，导致 native 路由判断永远读不到当前模型。

一条命令跑全部：`node smoke.mjs && node checks/*.mjs`（或 `pnpm check`）。

> 关于「包替换后条目短暂 `active: false`」：重装插件包时观察到一次，重新触碰 bundle（触发 HMR 按
> mtime/size 重算修订号）后恢复 `active: true`。结论：**包替换会让客户端插件短暂重挂**，页面上看到空白时
> 刷新一次即可。

### 需求自检

第一部分：

| # | 需求 | 状态 | 依据 |
| --- | --- | --- | --- |
| 1 | 原生对话类模型配置全部保留、不改逻辑与交互 | 通过 | 只往 `settings.models.footer` 加注册，未覆盖任何原生 slot；原生席位与声明者 `mf` 不变 |
| 2-接入 | 自定义 API 接入任意图像生成模型（协议/base_url/密钥/模型标识/请求头/参数模板） | 通过 | `Config` schema 六类可配置项齐备；`smoke.mjs` 校验默认值与非法枚举拒绝 |
| 2-格式 | 每个模型独立 Prompt 格式预设 + 前置/负面默认词 | 通过 | `promptFormat` 三选一 + `promptPrefix`/`promptNegative`/`promptTemplate`；交互检查断言选择自定义后模板字段出现 |
| 2-多模型 | 添加 / 编辑 / 删除 | 通过 | 交互检查断言添加打开编辑器、保存写出记录；删除为 `unset` 路径操作（`smoke.mjs` 断言移除元素） |
| 2-默认值 | 任意一个设为全局默认，同一时间仅一个 | 通过 | 同一次 `mutate` 内目标置 `true`、其余置 `false`；`smoke.mjs` 断言旧默认被清除且两边密钥保留 |
| 2-持久化 | 随用户配置本地持久化，重启后自动加载 | 机制层通过 | 写入 profile 的 `cordis.patch.yml`；**重启后仍在需你随第二部分一起实测** |

第二部分：

| # | 需求 | 状态 | 依据 |
| --- | --- | --- | --- |
| 1 | 需求识别（对话 / Agent / Skill 全场景） | 通过（纯逻辑） | `checks/intent.mjs` 37 例：命令式/意愿句/动词+名词命中；能力提问、否定、仅提到图片均不命中；`hint` 与 Skill 来源可直通 |
| 2 | 能力校验 | 通过（纯逻辑 + 接线） | `checks/router.mjs` 13 例 + `host-wiring` 的 native 放行用例；**结论：DSH 目录无输出模态字段，只能显式声明**（见 §1 说明） |
| 3 | Prompt 转译：透传优先 / 最少修改 / 格式匹配 | 通过 | `checks/prompt.mjs` 断言格式匹配时 `resolved.prompt` 与输入**完全相等**、参数仍被映射；不匹配时才转换；三档策略各有用例 |
| 3 | Skill 来源标记「已优化」，关闭默认词与风格增强 | 通过 | `source:'skill'` 时无 prefix、无 negative、正文不变；`auto-optimized-hold` 用例断言格式不兼容时保留原文而非转换 |
| 4a | 对话模型自带图像生成能力 → 不切换 | 通过 | native 用例断言「不生成、不存储、决策对象原样返回」（`assert.equal(decision, original)`） |
| 4b | 无能力 → 无感调用全局默认图像生成模型，结果回到当前对话 | 通过（逻辑 + 接线） | 决策中追加带 `image` block 的 user 消息；对话模型/路由未改动；`host-wiring` 断言消息 role/source/冻结 |
| 4c | 未配置/未设默认 → 清晰友好引导 | 通过 | `routeRequest` 返回区分「无模型」与「无默认」两种文案，均指向设置页；接线用例断言该文案作为消息呈现 |
| 5 | 主链路可运行 | 通过（离线） | 真实 HTTP 请求经 stub 传输验证请求形状与解析；附件持久化经 stub 附件服务验证；**真实端点与真实 GUI 需你实测** |

尚未由本会话证实的两项（都需要真实重启/真实端点，本会话无法执行）：
**① 重启后配置仍在**；**② 用真实图像生成端点跑通一次端到端**（发一句"画一张猫"→ 图片出现在对话里）。

需要你在页面上确认的一项（本会话无浏览器控制权限，无法替代）：

1. 刷新 GUI 页面（**这一步是必须的**：上述修复都在 client bundle 里，不刷新页面就还在跑旧代码）；
2. 打开 设置 → 模型，滚到最底部，应看到「图像生成模型接入区」（英文界面为 “Image generation models”）；
3. 点「添加图像生成模型」，应展开编辑器（接入配置 / 格式配置 / 参数模板三组）；
4. 填一条（例如协议 `Stable Diffusion HTTP API`、接口地址 `http://127.0.0.1:7860`、模型标识 `sd_xl`、
   Prompt 格式选「Stable Diffusion 标签权重风格」、填前置/负面默认词）→ 保存，应出现一行卡片；
5. 「编辑 / 设为默认 / 删除」逐个试一次；重启应用后回到该页，记录应仍在。

## 6. 文件

```
dsh-image-studio/
├─ package.json              # 包清单：dsh.bundle.patch + dsh.client；仅依赖 schemastery（见 §7）
├─ cordis.patch.yml          # Loader 插入行：- id: image-studio / name: dsh-image-studio
├─ index.js                  # Host 半：Config schema（唯一数据权威）、工具/提示词注册、agent/pre-step 调度
├─ client.js                 # Client 半：图像生成区席位、内联编辑器（含透传模式）、mutate 写操作
├─ src/intent.mjs            # 需求识别（用户 / Agent / Skill 三源）
├─ src/params.mjs            # 参数提取与标准化：尺寸/比例/数量/风格/负面词 → API 字段
├─ src/resilience.mjs        # 韧性层：转译降级、Skill 优先级、请求限幅、异常分类
├─ src/prompt.mjs            # Prompt 转译：格式识别、透传决策、三档策略、参数映射
├─ src/adapters.mjs          # 协议适配：OpenAI Images / Edits、SD WebUI；请求构造与响应解析
├─ src/router.mjs            # 能力校验与路由：native / configured / unconfigured
├─ src/generate.mjs          # 唯一生成操作：路由→参数→转译(带降级)→HTTP→持久化；可追溯 trace
├─ src/tool.mjs              # generate_image 与 image_studio_status 工具定义（raw ToolDefinition）
├─ smoke.mjs                 # Host schema 与写策略的纯逻辑回归
├─ checks/intent.mjs         # 需求识别 37 例
├─ checks/params.mjs         # 参数提取：不损伤 Prompt、显式优先、比例换算
├─ checks/resilience.mjs     # 降级、Skill 避让、限幅、异常分类
├─ checks/prompt.mjs         # 转译与透传规则
├─ checks/adapters.mjs       # 协议请求/响应与失败路径
├─ checks/router.mjs         # 路由三态与引导文案
├─ checks/generate.mjs       # 编排层：消息检测与生成结果
├─ checks/host-wiring.mjs    # 用假运行时真正跑 apply()：工具、监听、消息注入
├─ checks/locale-keys.mjs    # 中英文案键与视图用键的一致性检查
├─ checks/render-section.mjs # 离线真实渲染：加载 client bundle 并断言五种状态
├─ checks/interactions.mjs   # 离线交互驱动：点添加/改格式/填字段/保存，断言写出的路径操作
├─ checks/secret-roundtrip.mjs # 密钥写入路径操作与真实脱敏投影
├─ checks/secret-persist.mjs # 真实的 strip + mergeLayers 持久化变换
├─ checks/settings-service.mjs # 真实 SettingsForms 服务（describe/mutate/脱敏）
├─ checks/secret-indicator.mjs # 「已保存/未保存」指示器（回归：secrets 只在镜像上）
├─ checks/save-secret-e2e.mjs  # 端到端：点添加→填密钥→保存→操作落地
├─ checks/live-config-read.mjs # 用真实 profile 那一行驱动 apply()；并校验磁盘行可重校验（不联网）
├─ checks/live-generate.mjs    # 走完整管线真实生成一张图（会消耗一次额度）
├─ checks/package.mjs          # 打包自测：files 白名单完整性、相对 import、裸依赖、exports
├─ checks/support/client-harness.mjs # 共享的客户端渲染/上下文测试装置
├─ icon.svg                  # 插件卡片图标
└─ locale/{en,zh}.json       # 插件卡片标题与描述
```

**关于曾被删掉的 `checks/patch-write.mjs`**：它想验证「写入真的落进 profile 的 YAML」，
为此必须把 launcher 整条链（Loader 行、`readProfilePatches`、`overlays`、根 `include` 行…）mock 出来，
而且随框架内部变化反复失效——测的其实是 DSH 自己的 writer，不是本插件。
现在改为在三个层次上覆盖同一件事，且**零框架 mock**：

| 层次 | 检查 | 断言什么 |
|---|---|---|
| 变换 | `secret-persist.mjs` | 真实的 `strip` + `mergeLayers` 变换 |
| 服务 | `settings-service.mjs` | 真实 `SettingsForms` 的 `mutate`/`describe`/脱敏，以及重启后重校验 |
| 磁盘 | `live-config-read.mjs` | **应用自己写出的真实 profile 行**能重新通过 `host.Config` 校验、密钥仍在、`name` 正确 |

### 密钥为什么"看起来没保存"（已修复的真实缺陷）

现象：保存后编辑器正常关闭，但重开编辑时提示「未保存 API 密钥」，界面像是没保存成功。

定位过程（每一步都是可复现的检查）：

1. **先看磁盘**：profile 的 `cordis.patch.yml` 里 `config.imageModels[0].apiKey` **一直都在**。
   所以持久化没问题——是页面**显示**错了。
2. **再看服务**：`checks/settings-service.mjs` 用真实 `SettingsForms` 跑 `mutate` + `describe`，
   密钥落盘、脱敏读回 `secrets[{path:['imageModels','0','apiKey'],set:true}]` 全部正确。
3. **找到了**：`ConfigFormController.derive()`（`dsh-client-ui-settings`）只把
   `revision / base / user / writable / value` 从 describe 镜像复制到快照上，
   **从不复制 `secrets`**。而我的页面从 `ctx.configForms.get(ns)` 的快照里读 `secrets`——
   于是永远读到 `undefined`，指示器永远显示「未保存」，与磁盘上的真实状态无关。
4. **修法**：`secrets` 实际挂在镜像的 namespace view 上，所以页面改为
   订阅 `ctx.configForms.describe()` 并从镜像读取该 namespace 的 `secrets`
   （新增 `secretsOf()`，与控制器快照合并进 `toSectionState()`）。
5. **防回归**：`checks/secret-indicator.mjs` 的假上下文**刻意复刻这个分裂**
   （控制器快照无 `secrets`、镜像 view 有 `secrets`）——一旦页面再回去读快照上的字段，该检查就会失败。

顺带修的一处相关体验：HTTP 错误现在会把**提供商自己的错误信息**解析成一行可读文本
（例如 `HTTP 429 ...: 1302: 您的账户已达到速率限制`），而不是把转义 JSON 直接丢给用户。

### 调度链路读不到已保存的模型（已修复的真实缺陷）

现象：设置页里模型和密钥都保存正常，但 `generate_image` 立刻返回
「needs an image model, but none is connected yet」——**不足一秒**就返回，说明根本没发请求。

根因有两个，叠在一起：

1. **读错了来源**：`currentConfig()` 只读 `ctx.fiber?.config`，读不到时回退到 `apply(ctx, config)`
   的**激活时快照**。本插件的设置行来自 **bundle 层**（`include:image-studio`），
   profile patch 里没有它的独立行；激活时那一刻 `imageModels` 还是空的，
   于是插件"看不到"后来保存的模型。设置页自己是从 `configEditor` 读的，所以它一切正常——
   两边读的不是同一个来源。
2. **volatile 被 JSON 抹掉**：`.volatile()` 字段校验后是**带 getter 的引用对象**，
   而 `JSON.stringify` 会把这个包装对象序列化成 `{}`。哪怕读对了来源，
   一次简单 `JSON.parse(JSON.stringify(config))` 也会把整个 `imageModels` 变成空对象。

修法（`index.js`）：

- **按权威顺序逐个候选**：`configEditor.entries()` 里本插件自己的行（设置页写入的地方）
  → `ctx.fiber.config`（volatile 提交后的活配置）→ 激活参数（在 patch 层配置的部署仍可用）。
  **每个候选各自过一遍 `Config` 校验**，一个被 schema 拒绝的候选（编辑中的行、标量字段里的
  `!!js` 表达式）不会遮蔽后面可用的候选。
- **`unwrapVolatile()`**：先把 `Symbol.for('cosmokit.volatile.write')` 标记的活引用递归展开，
  再 JSON 快照，`imageModels` 才不会变成 `{}`。
- **新增 `image_studio_status` 自查工具**：报告插件**实际解析到**的配置
  （模型列表、协议、端点、是否默认、密钥是否存在*仅以长度表示*、超时、是否可调用、
  声明的 native 路由、自动调度开关）。它用来一眼区分"页面存了但插件没看到"这类问题。
  密钥值永不回显。

防回归：`checks/host-wiring.mjs` 新增四例——volatile 字段校验后配置仍可读、
激活配置陈旧时以已保存行为准、被拒候选自动跳过、没有 configEditor 时回退仍可用；
`checks/live-config-read.mjs` 则直接用**真实 profile 里那一行**驱动 `apply()`，
断言模型可见、生成工具能发出带 `Authorization: Bearer` 的请求、且摘要里不出现密钥。

> **注意**：这个修复在 Host 半（`index.js` / `src/*.mjs`），
> **必须重启应用**才生效（HMR 不重新导入已装载的插件模块）。

### 补全阶段（第三部分）：参数透传、异常兜底与全链路校验

#### 1 参数透传：从自然语言到官方字段

`src/params.mjs` 把指令里的参数读出来并标准化，支配规则是**提取不得损伤 Prompt**：

| 输入 | 提取 | 真正发出的字段 |
|---|---|---|
| `画一张 16:9 的横版插画，一只橘猫…，不要模糊` | ratio `16:9`、negative `模糊` | `size: "1344x768"`（保留「横版插画」） |
| `生成 2 张图，1:1，水彩风格，不要文字` | count `2`、ratio `1:1`、style `watercolor` | `n: 2`、`size: "1024x1024"` |
| `draw 3 images of a cat, 1024x768, avoid blur` | count `3`、size `1024x768`、negative `blur` | `n: 3`、`size: "1024x768"` |

三条设计决定：

- **只删纯管道词**：像素对 `1024x768`、负面从句被消费掉；`横版`、`油画风格`**保留在 Prompt 里**——
  它们同时是画面内容，删掉会让出图更差。风格另以 `style` 上报，**并明确说明**"已支持的协议都没有 style 字段，因此作为 Prompt 提示携带"，而不是凭空编一个字段。
- **显式优先**：调用方（工具参数或 Skill 自己的字段）给的值永远压过文本解析。
- **比例先于尺寸回退**：显式 `ratio` 会先换算成像素对，否则模型存储尺寸（兜底值）会悄悄盖掉用户明确要的比例。
- 计数上限 4、尺寸上限 4096，在 `clampRequest` 统一限幅，越界值不会变成非法请求。

#### 2 控制与降级

- **总开关**：设置页「自动调度」面板提供 `图像生成自动调度`（总开关）、`在对话中播报生成结果`、
  `自动生成数量`、`自动生成宽高`。关闭总开关后调度入口完全不参与；`generate_image` 工具仍对模型与 Skill 可用。
- **全场景异常兜底**：`classifyFailure` 把失败分成 `auth / rate-limit / bad-request / server / timeout /
  network / bad-response / config / cancelled / internal`，每类给出可读文案并**保留提供商原文**
  （`HTTP 429 …: 1302: 您的账户已达到速率限制`）。调度入口只有"用户必须处理"的两类（未配置、不可调用）才发消息，
  其余写日志——不会把每次失败都变成对话噪音，更不会中断本轮。
- **降级**：`translateWithFallback` 包裹转译层。转译抛异常或被拒时，自动退化为**逐字透传**原始 Prompt
  （任何协议都接受），并在结果与摘要里标注 `degraded`，流程不中断。

#### 3 兼容性与优先级

- **原生兼容**：只用官方扩展点（Config / settings / tools / systemPrompt / `agent/pre-step`），
  不读不写核心源码；依赖仅 `@deepseek-ai/schemastery`，可在 profile 内解析。
- **Skill 透明**：不修改 Skill 注入的 Prompt，不介入对话模型输入侧逻辑。
- **优先级**：`skillOwnsImageGeneration` 检查本轮是否已有**其它插件**的生图工具调用
  （按工具名匹配 `generate|draw|create|render|image|picture` × `image|picture|draw|render|diffusion|stable|sdxl|comfy|flux|midjourney|seedream|dall`，
  本插件自己的工具排除在外）。命中即**完全避让**：不注入消息、不发起调用——Skill 的显式选择优先。
- **上下文隔离**：转译与 API 调用在后台完成；对话历史只多出一条带 `source.kind = 'image-studio'` 的图片消息
  （由 `detectRequestInMessages` 识别并跳过，因此不可能自触发），不向历史注入任何额外文本。

#### 4 实测与两位真实缺陷

`node checks/live-generate.mjs "画一张 16:9 的横版插画，一只橘猫坐在雨后窗台上，不要模糊"`：

```
fields sent: {"model":"glm-image","prompt":"画一张 横版插画，一只橘猫坐在雨后窗台上","size":"1344x768"}
parameters:  {"width":1344,"height":768,"ratio":"16:9","count":1,"negative":"模糊","matched":["16:9","不要模糊"]}
→ generated, image/jpeg 140 KB, name=GLM-Image.jpg, 60.5s
```

本轮修掉的两个真实缺陷（都是**测试先行的假绿**）：

1. **`index.js` 少了一个 import**：新增的 Skill 避让用了 `skillOwnsImageGeneration`，
   但 import 行只加了 `registerStatusTool`。结果该标识符是 `ReferenceError`——
   而调度入口**自带** `try/catch`（"调度失败绝不打断本轮"），把 `ReferenceError` 也吞成了
   `return decision`。表现是：**自动调度整条链路静默失效，日志里什么都没有**。
   修法：补上 `import { skillOwnsImageGeneration } from './src/resilience.mjs'`。
   > 教训记在这里：这个 catch 是必要的（调度器故障不该打断对话），但它会把**编码错误**伪装成"正常跳过"，
   > 所以它现在配套一条断言——见 `host-wiring` 的自动路径用例。
2. **API 的 `model` 字段发的是显示名**：`buildBody` 用 `resolved.modelName`（= `model.name`，设置页里给人看的
   `GLM-Image`），而提供商只认 `model.model`（`glm-image`）。原先测试夹具恰好把两者写成同一个值，
   所以缺陷被测试掩盖。修法：`resolved` 新增 `modelIdentifier: model.model`，适配器改用它；
   夹具改成**显示名与标识不同**，让这个错误不可能再被掩盖。
   > 实测：修正前后该端点都返回 200（提供商对未知模型有自己的容错），但发出的标识从
   > `"GLM-Image"` 变成 `"glm-image"`，这才是"参数透传映射到官方字段"的真实含义。
3. **用户写的数量被插件默认值悄悄盖掉**：参数来源优先级里，插件自己的默认值（设置页的
   `autoImageCount`）被塞进了"显式参数"槽位，于是 `生成 2 张图` 里的 `2` 被默认的 `1` 覆盖——
   用户明确要两张，实际只发 `n` 省略（= 一张）。修法：给插件默认值单独一个槽位
   （`request.defaultCount` → `resolveParameters` 的 `fallback`），优先级变为
   **调用方显式值 > 文本解析 > 设置页默认值 > 模型模板**。
   > 实测（`fields sent` 里能直接看到）：修复后 `n: 2` 才真正发出；同时该端点**只回 1 张**，
   > 因此新增"数量缺口"上报——`Note: the provider returned 1 of the 2 requested image(s)`，
   > 不再静默少给。

### 连通性与实测（GLM-Image）

- 直接探测 `https://open.bigmodel.cn/api/paas/v4/images/generations`：`HTTP 200`，
  返回 `data[0].url`（不是 `b64_json`），单张耗时 **52–92 秒**；
- `node checks/live-generate.mjs "<prompt>"` 用**插件自己的**管线（真实路由→参数提取→转译→HTTP→响应解析→
  URL 取回→媒体类型校验→附件保存）累计跑通多次：`generated`，`image/jpeg` 约 78–145 KB，魔数 `ffd8ffe0` 正确，
  Prompt 判定 `passThrough=true / auto-format-match / natural→natural`（逐字透传）；
  文件名按**实际收到的格式**命名（`GLM-Image.jpg`，此前一律写 `.png`）；
- 由此把**超时兜底从 120 s 提到 300 s**（`mapParams` 与 schema 默认值），并把
  **超时与取消分开报告**：超过截止时间报 `timeout` 并提示"可以在设置页调大该模型的超时"，
  用户主动取消才报 `aborted`——原先两者都会被误报成取消。


> 另注：当时的「无法调用模型」经实测是**提供商侧限流**（同一密钥对
> `open.bigmodel.cn/api/paas/v4/images/generations` 返回 `429 / code 1302`），不是插件缺陷。


## 7. 安装拓扑与迭代方式

`install_bundle` 把本包以 **junction（目录链接）** 装进 profile：

```
C:\Users\22448\.dsh\profiles\desktop\node_modules\dsh-image-studio
   → C:\Users\22448\Desktop\dsh-image\dsh-image-studio
```

由此带来的迭代特性：

- `client.js` 的修改**即时反映到工作区文件**，`dsh-client-modules` 的 HMR 监视会按 mtime/size 变化重算 bundle
  修订号；页面下次加载即取到新字节。浏览器端插件代码**始终需要重新加载页面**才会执行新版本。
- **Host 半（`index.js` / `src/*.mjs`）的修改需要重启应用**：HMR 只覆盖 `cordis.patch.yml` 的配置变更，
  不会重新导入已装载的插件模块。第二部分的调度逻辑因此必须重启后才生效。
- `package.json`（`dsh.client`、`exports`、依赖）只在进程启动时读一次，**改动需要重启应用**。
- **依赖只能是 profile 也能解析的包**：本插件仅依赖 `@deepseek-ai/schemastery`（公开包，pnpm 能装进 profile）。
  `@deepseek-ai/dsh-llm`、`dsh-tools` 等只存在于安装目录，引用它们会让插件在 profile 中无法装载
  （本轮实际踩到：`install_bundle` 报 `ambiguous-install`）。因此用户消息与工具定义都按文档形状自行构造。
- profile 的 `cordis.patch.yml` **会**被写入 `- id: image-studio` 行——由设置页的写入产生（保存模型/密钥时）。
  插件行本身来自 bundle 层（`include:image-studio`）；正因为该行不是 bundle 里的静态行，
  Host 半必须按 §6 的候选顺序去读**设置页写入的那一份**，而不能只信激活时的参数。
- 排查用命令：
  - `node checks/live-config-read.mjs` —— 用真实 profile 那一行驱动 `apply()`，验证插件能看到模型（不联网）；
  - `node checks/live-generate.mjs "prompt"` —— 走插件完整管线真实生成一张图（会消耗一次额度）；
  - 对话里调用 `image_studio_status` 工具 —— 让插件自报它当前解析到的配置。

## 8. 后续阶段与可选增强

- **第二阶段已完成**：调度（`agent/pre-step` 自动 + `generate_image` 工具）与 Prompt 转译层都已实现，
  并在纯逻辑、编排层、Host 接线三层有回归检查。后续可扩展方向：更多协议适配器（如
  OpenAI Images Edits 的 multipart 上传、Flux/ComfyUI 工作流端点）、按会话/按任务的图像生成策略
  （当前是全局开关）、生成结果的历史与重试记录。
- **「默认对话模型接入区」标签（方案 A，本次未实现）**：需要 `dsh-client-ui-settings-models` 上游新增一个列表前
  头部席位。可直接转交的请求：在 `settings.section` 的子席位里并列增加


  ```js
  children: {
    'settings.models.header': { kind: 'list', scope: 'root' },   // 新增
    'settings.models.provider-card': { kind: 'keyed', scope: 'root' },
    'settings.models.footer': { kind: 'list', scope: 'root' },
  }
  ```

  并在 `t('intro')` 之后、提供商 `<ul>` 之前渲染 `renderSlot('settings.models.header', {})`，语义与既有席位一致：
  **没有注册方时渲染空**（原生页面零行为变化）。席位落地后，本插件只需在 `apply` 里对该 key 做一次
  `ctx.slots.inject` + `register`（一句文案，走已有 locale 命名空间）即可显示标签。
- **密钥改走 credentials 服务**：当前密钥随 Config 存在 profile patch 里（已由 Settings 服务脱敏）。
  若要与原生提供商一致（密钥存入 credentials、Config 只留引用），可把 `apiKey` 换成 `apiKeyEnv`
  风格的引用字段 + `credentials.set`。
