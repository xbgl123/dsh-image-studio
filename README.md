# 图像生成模型扩展（dsh-image-studio）

在 DSH 的**模型设置页**接入任意兼容的图像生成模型，并让对话直接具备出图能力：
你说「画一张 16:9 的猫」，图片就出现在当前对话里，**对话模型不会被切换**，上下文也不中断。

- 独立的「图像生成模型接入区」，与原生对话模型区物理分隔，互不干扰
- 自定义 API 接入：OpenAI Images、OpenAI Images Edits、Stable Diffusion WebUI、自定义
- 从自然语言里解析尺寸 / 比例 / 数量 / 风格 / 负面词，映射为 API 官方字段
- 每个模型可单独设置 Prompt 格式预设与三档透传策略
- 生成结果标注模型名，并**如实展示实际发送的 Prompt**
- 全场景异常兜底与转译降级：失败只报告、不中断对话
- 对 Skill 完全透明；Skill 自己生图时插件自动避让

> 想看内部实现、数据模型、缺陷复盘与测试清单，见 [`design.md`](./design.md)。

---

## 目录

- [功能](#功能)
- [环境要求](#环境要求)
- [安装](#安装)
- [快速开始](#快速开始)
- [使用实例](#使用实例)
- [配置参考](#配置参考)
- [参数对照表](#参数对照表)
- [常见问题](#常见问题)
- [开发与测试](#开发与测试)

---

## 功能

### 1. 图像生成模型接入区

在「设置 → 模型」页面最底部新增一个独立区块（英文界面为 "Image generation models"），
带分隔线与独立标题，位于所有原生对话模型行之后。原生区块的标题、说明与交互**完全不变**。

支持多模型增删改：每行显示名称、协议、端点、模型标识、是否默认、密钥是否已保存，
展开即为内联编辑器（接入配置 / 格式配置 / 参数模板三组）。

### 2. 自定义 API 接入

| 协议 | 值 | 端点拼接 |
|---|---|---|
| OpenAI Images | `openai-images` | `POST {baseUrl}/images/generations` |
| OpenAI Images Edits | `openai-images-edits` | `POST {baseUrl}/images/edits` |
| Stable Diffusion WebUI | `stability-sd-webui` | `POST {baseUrl}/sdapi/v1/txt2img` |
| 自定义 | `custom` | 仅保存配置，本阶段不发起请求 |

每条记录包含：协议、接口地址、API 密钥、模型标识、自定义请求头、参数模板。
密钥按 `role('secret')` 处理 —— **保存后不可回显**，页面只显示「已保存 API 密钥」，
留空即保留原值，永远无法把密钥读到前端。

### 3. Prompt 格式预设与三档透传

每个模型可选 Prompt 风格（`natural` 自然语言 / `sd-tags` 标签权重 / `custom` 自定义模板），
并可设置前置默认词、负面默认词。

透传模式三档：

| 模式 | 行为 |
|---|---|
| `自动`（默认） | 格式匹配时**逐字透传**，仅在真正不兼容时才转换 |
| `强制透传` | 任何情况下都不改写 Prompt |
| `强制转换` | 总是转换成该模型可识别的格式 |

原则是「透传优先、最少修改、格式匹配」：原作者怎么写，就尽量怎么发。

### 4. 自动调度（可总开关）

开启后，对话中出现的图像生成需求会自动调用默认图像生成模型，**不切换当前对话模型、
不路由到第二个端点**；生成结果作为一条带图片的消息附加到当前步骤，对话继续。

设置页提供「自动调度」面板：

- `图像生成自动调度` —— **总开关**。关闭后调度入口完全不参与，仅在你或 Skill 显式调用工具时生图
- `在对话中播报生成结果` —— 关闭则只插入图片，不附加文字
- `自动生成数量`（1–4）、`自动生成宽高`（留空则用各模型自己的尺寸）

### 5. 参数透传

从用户指令或 Skill 输出里解析参数并标准化为 API 字段，见[参数对照表](#参数对照表)。

设计上遵守两条硬规则：

- **提取不得损伤 Prompt**。只消费纯管道词（像素数字、负面从句）；「横版」「油画风格」**保留在 Prompt 里**，
  因为它们同时是画面内容，删掉只会让出图更差。
- **显式优先**。调用方给的值 > 文本解析出的值 > 设置页默认值 > 模型存模板。

### 6. 结果可追溯

每张图的结果都带 trace：**用了哪个模型**（显示名 + 内部 id + 端点）、
**实际发送的 Prompt**，以及判定路径（透传 / 转换 / 降级、源格式 → 目标格式、解析到的参数）。
Prompt 会作为一个独立文本块出现在工具结果里，不需要翻日志。

### 7. 异常兜底与降级

失败按 `auth / rate-limit / bad-request / server / timeout / network / bad-response / config` 分类，
每类给出可读提示，并**保留提供商原文**（例如 `HTTP 429 …: 1302: 您的账户已达到速率限制`）。

- 调度入口只有「用户必须处理」的两类（未配置、不可调用）才发对话消息，其余只写日志 —— 不淹没对话
- **转译降级**：转译层抛异常或被拒时，自动退化为**逐字透传**原始 Prompt（任何协议都接受），
  并标注 `degraded`，流程不中断
- 限幅：数量上限 4、尺寸上限 4096，越界值不会变成非法请求
- 数量缺口会上报：`Note: the provider returned 1 of the 2 requested image(s)`

### 8. Skill 透明与优先级

- 不修改 Skill 注入的 Prompt，不介入对话模型输入侧逻辑
- 若本轮已有**其它插件**的生图工具调用，插件**完全避让**：不注入消息、不发起调用
  （本插件自己的工具不计入冲突）
- 不向对话历史注入额外文本；插件消息带 `source.kind = 'image-studio'`，
  自身识别并跳过，因此不可能自触发

---

## 环境要求

- **DSH Desktop 2.0.x**（`dsh` CLI ≥ 11.8）
- 需要一个可用的图像生成端点与 API 密钥（示例使用智谱 GLM-Image）

---

## 安装

> 仓库地址：<https://github.com/xbgl123/dsh-image-studio>

### 方式一：命令行（推荐，一条命令装源码）

```bash
dsh plugin --profile desktop add github:xbgl123/dsh-image-studio
```

等价写法（GitHub 地址直连）：

```bash
dsh plugin --profile desktop add https://github.com/xbgl123/dsh-image-studio.git
```

`dsh plugin` 是 profile 内 pnpm 的透传入口：它会把本仓库克隆到
`~/.dsh/profiles/<profile>/node_modules/dsh-image-studio`，并自动装上唯一依赖
`@deepseek-ai/schemastery`。本插件**没有构建步骤**（直接发布 `index.js` / `client.js` / `src/*.mjs`），
所以克隆下来即可运行，不需要 `npm run build`。

装完依赖后，还要把包名登记为 profile 的 bundle —— 编辑
`~/.dsh/profiles/<profile>/package.json`：

```json
{
  "dependencies": {
    "dsh-image-studio": "github:xbgl123/dsh-image-studio"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-image-studio"
      ]
    }
  }
}
```

然后**重启应用**。

> **为什么还要手动登记 `bundles`？** `dsh plugin` 只是 pnpm 透传，不碰 profile 的
> bundle 名单；只装依赖而不登记，插件不会被装载。应用内的插件管理器会自动做这两步，
> 所以如果你用方式二，可以省掉手工编辑。

### 方式二：应用内安装（自动登记 bundle）

在 DSH 的设置 → **插件管理** 中安装 `dsh-image-studio`（或从本仓库地址安装）。
这种方式会自动完成依赖安装与 bundle 注册两步，安装后重启应用即可。

### 方式三：本地目录（开发用）

```bash
git clone https://github.com/xbgl123/dsh-image-studio.git
dsh plugin --profile desktop add link:C:/path/to/dsh-image-studio
```

`link:` 会建立目录链接，改代码后刷新页面（`client.js`）或重启应用（Host 半）即可生效。

### 验证安装

- 设置 → 模型，滚到底部应出现「图像生成模型接入区」
- 在对话里问一句「`image_studio_status` 报告一下配置」，会返回插件**实际解析到**的模型列表、
  密钥是否存在（仅以长度表示）与端点可调用性
- 源码自带 19 个检查套件，可在克隆目录里跑 `npm run check` 自检

---

## 快速开始

三步接入第一个模型：

1. **打开页面**：设置 → 模型 → 滚动到底部的「图像生成模型接入区」
2. **添加模型**：点「添加图像生成模型」，填写

   | 字段 | 示例（GLM-Image） |
   |---|---|
   | 名称 | `GLM-Image` |
   | 接入协议 | `OpenAI Images 接口` |
   | 接口地址 | `https://open.bigmodel.cn/api/paas/v4` |
   | 模型标识名称 | `glm-image` |
   | API 密钥 | `xxxxxxxx.xxxxxxxx` |

   点「保存」。

3. **设为默认**：在该行点「设为默认」（全局只能有一个默认）

然后在对话里直接说：**「画一张猫」** —— 图片会出现在当前对话里。

---

## 使用实例

以下示例中的端点、耗时与返回格式均来自 **GLM-Image 实测**，你的提供商行为可能不同。

### 例 1：对话里直接要图（自动调度）

```
你：画一张橘色小猫坐在木质窗台上，窗外是雨后的黄昏
```

插件识别到生图需求 → 静默调用默认模型 → 插入图片，对话模型与路由都不变。

**实测输出**（约 80 秒，`image/jpeg`，108 KB）：

```
Generated 1 image at 1024x1024px with the model "GLM-Image" (openai-images).
Prompt passed through unchanged: auto-format-match, natural → natural.
The image is attached to this result and shown in the conversation.
Trace: model=GLM-Image id=img-mvamumxk-tcqgol endpoint=https://open.bigmodel.cn/api/paas/v4;
prompt sent = "一只橘色的小猫坐在木质窗台上，窗外是雨后的黄昏".
```

注意最后一行：**实际发送的 Prompt 逐字可见**，且判定为 `passThrough=true`（一个字都没改）。

### 例 2：参数写在句子里

```
你：生成 2 张图，16:9，水墨风格，一只猫在竹林中，不要文字
```

插件会解析出比例、数量、风格、负面词，并把它们从 Prompt 里剔干净：

**实测输出**（约 67 秒）：

```
fields sent: {"model":"glm-image","prompt":"生成图，水墨风格，一只猫在竹林中",
              "size":"1024x1024","n":2}
parameters:  {"width":1024,"height":1024,"ratio":"1:1","count":2,
              "style":"ink wash painting","negative":"文字",
              "matched":["1:1","2 张","水墨","不要文字"]}
```

要点：

- `2 张` → `n: 2`；`1:1` → `size`；`水墨` → 风格上报；`不要文字` → 负面词
- Prompt 里「水墨风格」**被保留**了 —— 它同时是画面内容
- 该端点实际只回 1 张，于是结果里出现 `Note: the provider returned 1 of the 2 requested image(s)`
  —— **不静默少给**

### 例 3：显式调用工具（可控参数）

当你想自己决定尺寸/数量，或让 Agent 精确调用时：

```json
{
  "prompt": "一只橘猫坐在雨后窗台上",
  "width": 1344,
  "height": 768,
  "count": 1,
  "negative": "模糊, 文字",
  "source": "user"
}
```

`generate_image` 的完整参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `prompt` | string（必填） | Prompt 原文，不要翻译或改写 |
| `model` | string | 指定某个模型的 id，省略则用默认 |
| `source` | `user` / `agent` / `skill` | 来源；`skill` 会保持 Prompt 逐字不变并关闭默认词补全 |
| `width` / `height` | integer | 覆盖句子里与模板里的尺寸 |
| `ratio` | string | 如 `"16:9"`；没给宽高时按比例换算 |
| `count` | integer 1–4 | 生成数量 |
| `style` | string | 风格提示（见下方说明） |
| `negative` | string | 负面提示词，协议支持时发送 |

> **关于 `style`**：目前支持的四个协议**都没有** style 字段，所以它作为 Prompt 提示携带，
> 并在结果里注明 —— 而不是凭空编一个 API 字段。

### 例 4：多个模型并存

再接一个 SD WebUI（本地）：

| 字段 | 值 |
|---|---|
| 名称 | `本地 SDXL` |
| 接入协议 | `Stable Diffusion WebUI` |
| 接口地址 | `http://127.0.0.1:7860` |
| 模型标识名称 | `sd_xl_base_1.0` |
| Prompt 格式预设 | `Stable Diffusion 标签权重风格` |
| 负面默认词 | `worst quality, blurry` |

两者并存、各自保存格式与参数，只有一个是全局默认。需要指定非默认模型时传 `model` 参数。

### 例 5：自查当前配置

```
你：image_studio_status 报告一下生图配置
```

返回插件**实际解析到**的配置（不是页面上存了什么）：

```
Image generation: 1 model(s) configured; conversation route deepseek-account/deepseek-flash;
declared image-capable routes: none; automatic scheduling on.
- GLM-Image [openai-images] https://open.bigmodel.cn/api/paas/v4 model=glm-image
  default=true key=set (49 chars) timeout=300000ms
```

密钥只以长度呈现，永不回显。这条在「页面明明存了，但插件好像没看到」时最好用。

### 例 6：关掉自动调度

设置 → 模型 →「自动调度」面板 → 取消勾选「图像生成自动调度」→ 保存调度设置。

之后对话里说「画一张猫」不会再自动出图，但 `generate_image` 工具仍然可用 ——
适合只想按需生图、避免误触费用的场景。

### 例 7：让 Skill 显式调用

Skill 里直接调 `generate_image` 并带 `"source": "skill"`：

- Prompt 会**逐字发送**，不追加任何默认词
- 若 Skill 用的是**别的插件**的生图工具，本插件检测到后**自动避让**，不会重复生成

---

## 配置参考

### 模型字段

| 页面字段 | 配置键 | 默认 | 说明 |
|---|---|---|---|
| 名称 | `name` | — | 仅用于本页面显示与结果标注 |
| 接入协议 | `protocol` | `openai-images` | 见上文协议表 |
| 接口地址 | `baseUrl` | — | 必须是 `http(s)://` |
| API 密钥 | `apiKey` | — | `secret`，不可回显；留空保留原值 |
| 模型标识名称 | `model` | — | 发给提供商的 `model` 字段（不是显示名） |
| 自定义请求头 | `headers` | `[]` | `{name, value}` 列表 |
| Prompt 格式预设 | `promptFormat` | `natural` | `natural` / `sd-tags` / `custom` |
| Prompt 透传模式 | `promptPassThrough` | `auto` | `auto` / `always` / `never` |
| 前置默认词 | `promptPrefix` | `""` | 加在每个提示词之前 |
| 负面默认词 | `promptNegative` | `""` | 协议支持时作为负面提示词发送 |
| 自定义模板 | `promptTemplate` | `""` | 支持 `{prompt}`、`{prefix}`、`{negative}` |
| 尺寸 | `params.size` | 协议默认 | 协议默认 / 1024×1024 / 768×1344 / 1344×768 / 1920×1080 / 自定义 |
| 宽 / 高 | `params.width` / `params.height` | `1024` | 像素 |
| 步数 | `params.steps` | `0` | 仅 SD 类端点使用 |
| 超时（毫秒） | `params.timeoutMs` | `300000` | 图像模型常需一分钟以上，默认给足 5 分钟 |
| 设为默认 | `isDefault` | `false` | 全局恰好一个 |

### 调度字段

| 页面字段 | 配置键 | 默认 | 说明 |
|---|---|---|---|
| 图像生成自动调度 | `autoGenerate` | `true` | 总开关 |
| 在对话中播报生成结果 | `announce` | `true` | 关则只插图片 |
| 自动生成数量 | `autoImageCount` | `1` | 1–4 |
| 自动生成宽 / 高 | `autoWidth` / `autoHeight` | `0` | `0` 表示用各模型自己的尺寸 |

### 声明式能力（无页面控件）

`nativeImageRoutes`：声明**对话模型自己就能生图**的路由，写成 `provider/model`
（单独写 model 或 provider 也能匹配）。命中这些路由时，插件直接放行 —— 不生成、不调用第二个端点。

它没有页面控件，只能写在 profile patch 里：

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: image-studio
  name: dsh-image-studio
  config:
    nativeImageRoutes:
      - deepseek-account/dall-e-3
```

---

## 参数对照表

自然语言 → 标准化参数的实测结果：

| 你说 | 解析出 | 发给 API |
|---|---|---|
| `16:9` / `横版` | `ratio: 16:9` | `size: "1344x768"` |
| `9:16` / `竖版` | `ratio: 9:16` | `size: "768x1344"` |
| `1:1` / `方图` | `ratio: 1:1` | `size: "1024x1024"` |
| `1024x768` | 宽高 | `size: "1024x768"` |
| `2 张` / `2 images` | `count: 2` | `n: 2`（=1 时省略） |
| `水墨` / `油画` | `style` | 作为 Prompt 提示（协议无此字段） |
| `不要文字` / `avoid blur` | `negative` | 协议支持时发送 |

比例会围绕模型存储的面积换算，并对齐到 64 的倍数。上限：数量 4、单边尺寸 4096。

---

## 常见问题

**Q：保存了密钥，但重开编辑器仍显示「未保存 API 密钥」？**
已修复。根因是设置页快照的投影不包含 `secrets` 字段，密钥实际一直存在磁盘上，只是指示器读错了来源。
若仍异常，用 `image_studio_status` 看 `key=set (N chars)` 即可确认真实状态。

**Q：调用返回 `HTTP 429` / `1302`？**
是**提供商侧限流**，不是插件问题。密钥有效、端点正确，等限流窗口过去或换模型即可。
错误提示会直接给出提供商的原文。

**Q：生图要等很久，会超时吗？**
图像模型常见 50–90 秒。默认超时是 **300 秒**，够用；如果换到更慢的提供商，
在模型编辑器的「超时（毫秒）」里调大即可。超时会明确报 `timeout` 并提示你调大超时
（与"用户取消"区分开）。

**Q：要了 2 张，只回了 1 张？**
插件确实按要求发了 `n: 2`，是端点只返回 1 张。结果里会出现
`Note: the provider returned 1 of the 2 requested image(s)`，不会静默少给。

**Q：模型标识名称填显示名可以吗？**
不可以。`模型标识名称` 是发给提供商的 `model` 字段（如 `glm-image`），
`名称` 只是页面显示（如 `GLM-Image`）。二者是不同字段。

**Q：会不会切换我的对话模型？**
不会。插件把生成结果作为一条带图片的消息附加到当前步骤，对话模型与路由都不变。
如果你的对话模型本身已声明可生图（`nativeImageRoutes`），插件会直接放行、完全不介入。

**Q：启用后在每个对话都会自动生图吗？**
只在**识别到图像生成意图**时触发；能力提问（"你能生图吗"）与否定（"不要画图"）都不会触发。
不放心就关掉`图像生成自动调度`总开关。

---

## 开发与测试

```bash
# 全部检查（离线 + 真实配置读取 + 打包自测，不联网）
npm run check

# 分组
npm run check:core      # 需求识别 / 参数 / 转译 / 适配 / 路由 / 编排 / 韧性
npm run check:host      # 真实驱动 apply()：工具、监听、消息注入
npm run check:ui        # 文案键、离线渲染、交互驱动
npm run check:secret    # 密钥写入、脱敏、持久化、指示器
npm run check:live      # 用真实 profile 那一行驱动 apply()
npm run check:package   # 打包自测：`files` 白名单是否完整、依赖是否可解析

# 打包（先跑打包自测，再产出 tgz）
npm run pack

# 真实生成一张图（会消耗一次提供商额度）
node checks/live-generate.mjs "一只猫坐在窗台上"
```

**打包自测**（`checks/package.mjs`）值得单独说一句：它不是"文件在不在"，
而是从 `files` 白名单推出**真正会发布的那批文件**，然后断言

- Host/client 必需的 14 个运行时文件都在白名单里
- 每个相对 import 都指向**另一个会被发布的文件**（否则装完才炸）
- 没有引用 `@deepseek-ai/dsh-llm` 这类只存在于安装目录的包
- 裸依赖恰好等于 `dependencies` + `peerDependencies` + 页面注入的 `react`
- `exports` 每个目标都真实存在

它也能对解包后的成品运行：`node checks/package.mjs <解包目录>`。

**改完必须重启应用**：`index.js` / `src/*.mjs` 属于 Host 半，HMR 只覆盖 `cordis.patch.yml`，
不会重新导入已装载的插件模块。`client.js` 改动只需刷新页面。

依赖纪律：本插件只依赖 `@deepseek-ai/schemastery`。`@deepseek-ai/dsh-llm`、`dsh-tools`
等包只存在于安装目录，引用它们会让插件在 profile 中无法装载。

架构、数据模型、缺陷复盘与逐条测试清单见 [`design.md`](./design.md)。
