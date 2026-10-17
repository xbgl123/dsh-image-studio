window.__ModuleLoader__.load({
  id: 'dsh-image-studio',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'image-studio'
    /**
     * Settings namespace owned by this plugin's Host half. Spelled here rather
     * than imported: a client bundle may not depend on a Host package.
     */
    const IMAGE_NS = 'image-studio'
    /** Slot seat: the ordered extension area after the provider rows and add controls. */
    const FOOTER_SLOT = 'settings.models.footer'
    /** Path of the stored model list inside the namespace section. */
    const MODELS_PATH = 'imageModels'

    const PROTOCOLS = ['openai-images', 'openai-images-edits', 'stability-sd-webui', 'custom']
    const PROMPT_FORMATS = ['natural', 'sd-tags', 'custom']
    /** Per-model pass-through policy; mirrors the Host union exactly. */
    const PASS_THROUGH_MODES = ['auto', 'always', 'never']

    /** The namespace's root scheduler fields, with the Host's own defaults. */
    const DEFAULT_SCHEDULER = {
      autoGenerate: true,
      announce: true,
      autoImageCount: 1,
      autoWidth: 0,
      autoHeight: 0,
    }

    /** Read the scheduler fields out of one namespace value. */
    function schedulerOf(value) {
      const source = value !== null && typeof value === 'object' ? value : {}
      return {
        autoGenerate: source.autoGenerate !== false,
        announce: source.announce !== false,
        autoImageCount: Number.isFinite(source.autoImageCount) ? Math.min(4, Math.max(1, source.autoImageCount)) : 1,
        autoWidth: Number.isFinite(source.autoWidth) ? Math.max(0, source.autoWidth) : 0,
        autoHeight: Number.isFinite(source.autoHeight) ? Math.max(0, source.autoHeight) : 0,
      }
    }

    const SIZE_PRESETS = [
      { key: 'auto', width: 0, height: 0 },
      { key: 'square', width: 1024, height: 1024 },
      { key: 'portrait', width: 768, height: 1344 },
      { key: 'landscape', width: 1344, height: 768 },
      { key: 'hd', width: 1920, height: 1080 },
    ]

    /** Copy dictionaries; the English set is the key-set source of truth. */
    const en = {
      title: 'Image generation models',
      intro:
        'Connect any endpoint that can generate images — OpenAI Images-compatible, Stable Diffusion HTTP API, or your own relay — and keep its prompt format beside it. Image generation itself is not wired up in this stage.',
      emptyTitle: 'No image generation model yet',
      emptyHint: 'Add one to store its endpoint, key, and prompt format. Nothing is called yet.',
      add: 'Add image model',
      edit: 'Edit',
      remove: 'Delete',
      setDefault: 'Set as default',
      isDefault: 'Default',
      save: 'Save',
      saving: 'Saving…',
      cancel: 'Cancel',
      collapse: 'Close',
      noDefault: 'No default image model is set.',
      defaultHint: 'Use as the global default image model.',
      apiKeySet: 'API key stored',
      apiKeyMissing: 'No API key stored',
      readOnly: 'The settings document is read-only in this deployment, so image models cannot be saved.',
      unavailable: 'Image model storage is unavailable in this deployment.',
      loadFailed: 'Image model settings could not be loaded',
      refused: 'The settings document refused this change',
      retry: 'Retry',
      conflict: 'These settings changed elsewhere. Reopen the editor to work on the current values.',
      basic: 'Connection',
      formatting: 'Prompt format',
      advanced: 'Parameters',
      fieldName: 'Name',
      fieldNameHint: 'Shown only in this page.',
      fieldProtocol: 'Protocol',
      protocolOpenai: 'OpenAI Images API',
      protocolOpenaiEdits: 'OpenAI Images edit API',
      protocolSd: 'Stable Diffusion HTTP API',
      protocolCustom: 'Custom protocol',
      fieldBaseUrl: 'Base URL',
      fieldApiKey: 'API key',
      apiKeyPlaceholder: 'Leave blank to keep the stored key',
      apiKeyPlaceholderNew: 'Paste the API key',
      fieldModel: 'Model identifier',
      fieldHeaders: 'Custom request headers',
      headerName: 'Header',
      headerValue: 'Value',
      addHeader: 'Add header',
      removeHeader: 'Remove header {name}',
      fieldFormat: 'Prompt format preset',
      formatNatural: 'OpenAI natural language',
      formatSdTags: 'Stable Diffusion tag weights',
      formatCustom: 'Custom template',
      fieldPassThrough: 'Prompt pass-through',
      passAuto: 'Automatic — decide from the prompt format',
      passAlways: 'Always pass through — never rewrite the prompt',
      passNever: 'Always convert — always adapt to this model',
      passHint: 'A matching prompt is passed through byte for byte; conversion runs only on a real format mismatch.',
      scheduler: 'Automatic scheduling',
      autoGenerate: 'Schedule image generation automatically',
      autoGenerateHint: 'When on, a request for a picture in the conversation calls the model below without switching the conversation model. When off, images are generated only when you or a skill call the tool explicitly.',
      announce: 'Announce the result in the conversation',
      announceHint: 'When off, only the image is inserted. That it came from a tool is still part of the image information.',
      autoImageCount: 'Images per automatic request',
      autoImageCountHint: 'How many images one automatic request produces (1–4).',
      autoSize: 'Automatic size',
      autoSizeHint: 'Leave blank to use each model\'s stored size; filling it in overrides.',
      autoWidth: 'Width (px)',
      autoHeight: 'Height (px)',
      schedulerSave: 'Save scheduling settings',
      schedulerSaved: 'Automatic scheduling settings saved.',
      schedulerFailed: 'Saving the scheduling settings failed',
      fieldPrefix: 'Prefix',
      prefixHint: 'Prepended to every prompt.',
      fieldNegative: 'Negative',
      negativeHint: 'Sent as the negative prompt where the protocol supports it.',
      fieldTemplate: 'Custom template',
      templateHint: 'Use {prompt}, {prefix}, and {negative}.',
      fieldSize: 'Size',
      sizeAuto: 'Protocol default',
      sizeSquare: 'Square 1024×1024',
      sizePortrait: 'Portrait 768×1344',
      sizeLandscape: 'Landscape 1344×768',
      sizeHd: 'Full HD 1920×1080',
      sizeDetail: 'Custom width and height',
      fieldWidth: 'Width',
      fieldHeight: 'Height',
      fieldSteps: 'Steps',
      fieldTimeout: 'Timeout (ms)',
      deleteTitle: 'Delete {name}?',
      deleteDescription: 'Its stored configuration and API key are removed from this profile.',
      deleteConfirm: 'Delete {name}',
      deleting: 'Deleting…',
      errorName: 'Enter a name.',
      errorBaseUrl: 'Enter an HTTP or HTTPS endpoint.',
      errorModel: 'Enter the model identifier.',
      errorTemplate: 'Enter the prompt template.',
      errorHeader: 'Every header row needs a name.',
      errorDuplicate: 'Another image model already uses this name.',
    }
    const zh = {
      title: '图像生成模型接入区',
      intro:
        '可接入任意具备图像生成能力的接口——兼容 OpenAI Images 规范、Stable Diffusion HTTP API，或自建中转——并为每个模型单独保存提示词格式。本阶段尚未接入实际图像生成调度。',
      emptyTitle: '还没有图像生成模型',
      emptyHint: '添加一个即可保存其接口、密钥与提示词格式；本阶段不会发起任何请求。',
      add: '添加图像生成模型',
      edit: '编辑',
      remove: '删除',
      setDefault: '设为默认',
      isDefault: '默认',
      save: '保存',
      saving: '保存中…',
      cancel: '取消',
      collapse: '收起',
      noDefault: '尚未设置默认图像生成模型。',
      defaultHint: '作为全局默认图像生成模型。',
      apiKeySet: '已保存 API 密钥',
      apiKeyMissing: '未保存 API 密钥',
      readOnly: '当前部署的设置文档为只读，无法保存图像生成模型。',
      unavailable: '当前部署无法保存图像生成模型配置。',
      loadFailed: '图像生成模型配置加载失败',
      refused: '设置文档拒绝了这次修改',
      retry: '重试',
      conflict: '设置已在别处被修改，请重新打开编辑器基于当前值编辑。',
      basic: '接入配置',
      formatting: '格式配置',
      advanced: '参数模板',
      fieldName: '名称',
      fieldNameHint: '仅用于本页面显示。',
      fieldProtocol: '接入协议',
      protocolOpenai: 'OpenAI Images 接口',
      protocolOpenaiEdits: 'OpenAI Images 编辑接口',
      protocolSd: 'Stable Diffusion HTTP API',
      protocolCustom: '自定义协议',
      fieldBaseUrl: '接口地址',
      fieldApiKey: 'API 密钥',
      apiKeyPlaceholder: '留空则保留已保存的密钥',
      apiKeyPlaceholderNew: '粘贴 API 密钥',
      fieldModel: '模型标识名称',
      fieldHeaders: '自定义请求头',
      headerName: '请求头',
      headerValue: '值',
      addHeader: '添加请求头',
      removeHeader: '删除请求头 {name}',
      fieldFormat: 'Prompt 格式预设',
      formatNatural: 'OpenAI 自然语言风格',
      formatSdTags: 'Stable Diffusion 标签权重风格',
      formatCustom: '自定义模板',
      fieldPassThrough: 'Prompt 透传模式',
      passAuto: '自动 —— 按 Prompt 格式判断（默认）',
      passAlways: '强制透传 —— 任何情况下都不改写 Prompt',
      passNever: '强制转换 —— 总是转换成该模型可识别的格式',
      passHint: '格式匹配时按原文逐字透传，仅在格式不兼容时才转换。',
      scheduler: '自动调度',
      autoGenerate: '图像生成自动调度',
      autoGenerateHint: '开启后，对话中出现图像生成需求时会自动调用下面的模型，且不切换当前对话模型。关闭后仅在你或 Skill 显式调用工具时生图。',
      announce: '在对话中播报生成结果',
      announceHint: '关闭后只插入图片本身，不附加文字；图片由工具生成这一事实仍体现在图片信息中。',
      autoImageCount: '自动生成数量',
      autoImageCountHint: '每次自动调度的图片数量（1–4）。',
      autoSize: '自动生成尺寸',
      autoSizeHint: '留空则使用每个模型自己保存的尺寸；填写后覆盖。',
      autoWidth: '宽（像素）',
      autoHeight: '高（像素）',
      schedulerSave: '保存调度设置',
      schedulerSaved: '自动调度设置已保存。',
      schedulerFailed: '自动调度设置保存失败',
      fieldPrefix: '前置默认词',
      prefixHint: '会加在每个提示词之前。',
      fieldNegative: '负面默认词',
      negativeHint: '协议支持时作为负面提示词发送。',
      fieldTemplate: '自定义模板',
      templateHint: '可使用 {prompt}、{prefix}、{negative}。',
      fieldSize: '尺寸',
      sizeAuto: '协议默认',
      sizeSquare: '正方形 1024×1024',
      sizePortrait: '竖版 768×1344',
      sizeLandscape: '横版 1344×768',
      sizeHd: '全高清 1920×1080',
      sizeDetail: '自定义宽高',
      fieldWidth: '宽',
      fieldHeight: '高',
      fieldSteps: '步数',
      fieldTimeout: '超时（毫秒）',
      deleteTitle: '删除 {name}？',
      deleteDescription: '其配置与 API 密钥将从当前 profile 中移除。',
      deleteConfirm: '删除 {name}',
      deleting: '删除中…',
      errorName: '请填写名称。',
      errorBaseUrl: '请填写 HTTP 或 HTTPS 接口地址。',
      errorModel: '请填写模型标识名称。',
      errorTemplate: '请填写提示词模板。',
      errorHeader: '每个请求头都需要名称。',
      errorDuplicate: '已有其它图像生成模型使用该名称。',
    }

    const PROTOCOL_LABEL = {
      'openai-images': 'protocolOpenai',
      'openai-images-edits': 'protocolOpenaiEdits',
      'stability-sd-webui': 'protocolSd',
      custom: 'protocolCustom',
    }
    const FORMAT_LABEL = {
      natural: 'formatNatural',
      'sd-tags': 'formatSdTags',
      custom: 'formatCustom',
    }
    const PASS_LABEL = {
      auto: 'passAuto',
      always: 'passAlways',
      never: 'passNever',
    }
    const SIZE_LABEL = {
      auto: 'sizeAuto',
      square: 'sizeSquare',
      portrait: 'sizePortrait',
      landscape: 'sizeLandscape',
      hd: 'sizeHd',
    }

    // ------------------------------------------------------------------ helpers

    /**
     * Translate a key, falling back to the key itself so a message can never
     * render as a blank seat.
     * @param t - bound translator.
     * @param key - dictionary key.
     * @param params - `{name}` substitutions.
     */
    function tr(t, key, params) {
      if (typeof t !== 'function') return key
      let value
      try {
        value = t(key, params)
      } catch (_failure) {
        return key
      }
      return typeof value === 'string' && value.length > 0 ? value : key
    }

    /** A minimal snapshot store: this bundle owns no other module. */
    function createStore(initial) {
      let state = initial
      const listeners = new Set()
      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        set(next) {
          state = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /** Coerce one stored record into the shape the editor works with. */
    function normalizeModel(input, index) {
      const source = input !== null && typeof input === 'object' ? input : {}
      const params = source.params !== null && typeof source.params === 'object' ? source.params : {}
      return {
        id: typeof source.id === 'string' && source.id.length > 0 ? source.id : `image-${index + 1}`,
        name: typeof source.name === 'string' ? source.name : '',
        protocol: PROTOCOLS.includes(source.protocol) ? source.protocol : 'openai-images',
        baseUrl: typeof source.baseUrl === 'string' ? source.baseUrl : '',
        apiKey: typeof source.apiKey === 'string' ? source.apiKey : '',
        model: typeof source.model === 'string' ? source.model : '',
        headers: Array.isArray(source.headers)
          ? source.headers.map((row) => ({
              name: row !== null && typeof row === 'object' && typeof row.name === 'string' ? row.name : '',
              value: row !== null && typeof row === 'object' && typeof row.value === 'string' ? row.value : '',
            }))
          : [],
        promptFormat: PROMPT_FORMATS.includes(source.promptFormat) ? source.promptFormat : 'natural',
        promptPassThrough: PASS_THROUGH_MODES.includes(source.promptPassThrough) ? source.promptPassThrough : 'auto',
        promptPrefix: typeof source.promptPrefix === 'string' ? source.promptPrefix : '',
        promptNegative: typeof source.promptNegative === 'string' ? source.promptNegative : '',
        promptTemplate: typeof source.promptTemplate === 'string' ? source.promptTemplate : '',
        params: {
          size: typeof params.size === 'string' ? params.size : '',
          width: Number.isFinite(params.width) ? params.width : 1024,
          height: Number.isFinite(params.height) ? params.height : 1024,
          steps: Number.isFinite(params.steps) ? params.steps : 0,
          timeoutMs: Number.isFinite(params.timeoutMs) ? params.timeoutMs : 300000,
        },
        isDefault: source.isDefault === true,
      }
    }

    /** A fresh, unsaved record for the add editor. */
    function blankModel() {
      return {
        id: '',
        name: '',
        protocol: 'openai-images',
        baseUrl: '',
        apiKey: '',
        model: '',
        headers: [],
        promptFormat: 'natural',
        promptPassThrough: 'auto',
        promptPrefix: '',
        promptNegative: '',
        promptTemplate: '',
        params: { size: '', width: 1024, height: 1024, steps: 0, timeoutMs: 300000 },
        isDefault: false,
      }
    }

    /** The stored list of one namespace snapshot value. */
    function modelsOf(value) {
      const list = value !== null && typeof value === 'object' ? value[MODELS_PATH] : undefined
      return Array.isArray(list) ? list.map(normalizeModel) : []
    }

    /**
     * The declared secret positions of this plugin's namespace.
     *
     * The describe mirror holds the Host's redacted value for every namespace,
     * including the `secrets` array that says which `role('secret')` positions are
     * filled. The per-namespace controller does not forward that field, so it is
     * read from the mirror directly.
     *
     * @param view - the mirror's `SettingsDescribeValue`, or undefined before the
     *   first answer.
     * @returns the namespace's secret positions, or an empty list.
     */
    function secretsOf(view) {
      const namespaces = view !== null && typeof view === 'object' ? view.namespaces : undefined
      if (!Array.isArray(namespaces)) return []
      const mine = namespaces.find((candidate) => candidate !== null && typeof candidate === 'object' && candidate.ns === IMAGE_NS)
      return mine !== undefined && Array.isArray(mine.secrets) ? mine.secrets : []
    }

    /**
     * Project one `ConfigFormController` snapshot into the state the card reads.
     * It is total on purpose: the controller publishes `status: 'unavailable'`
     * (non-loopback page), `'loading'`, `'ready'`, and `'error'`, and the card
     * must render in each without a field ever being absent.
     *
     * @param snapshot - the controller's snapshot, or undefined before it exists.
     * @param secrets - the namespace's secret positions, from the describe mirror.
     */
    function toSectionState(snapshot, secrets) {
      const source = snapshot !== null && typeof snapshot === 'object' ? snapshot : {}
      return {
        status: typeof source.status === 'string' ? source.status : 'loading',
        value: source.value,
        models: modelsOf(source.value),
        revision: source.revision,
        writable: source.writable === true,
        secrets: Array.isArray(secrets) ? secrets : [],
        scheduler: schedulerOf(source.value),
        error: source.error === undefined ? null : source.error,
      }
    }

    /** Whether the redacted snapshot says the record at `index` holds an API key. */
    function secretSetAt(secrets, index) {
      if (!Array.isArray(secrets)) return false
      return secrets.some(
        (entry) =>
          entry !== null &&
          typeof entry === 'object' &&
          Array.isArray(entry.path) &&
          entry.path[0] === MODELS_PATH &&
          String(entry.path[1]) === String(index) &&
          entry.set === true,
      )
    }

    /** Validate a draft. Returns a dictionary key or undefined. */
    function validateDraft(draft, models, editingIndex) {
      if (draft.name.trim().length === 0) return 'errorName'
      const duplicated = models.some((model, index) => index !== editingIndex && model.name.trim() === draft.name.trim())
      if (duplicated) return 'errorDuplicate'
      if (!/^https?:\/\//i.test(draft.baseUrl.trim())) return 'errorBaseUrl'
      if (draft.model.trim().length === 0) return 'errorModel'
      if (draft.promptFormat === 'custom' && draft.promptTemplate.trim().length === 0) return 'errorTemplate'
      if (draft.headers.some((row) => row.name.trim().length === 0 && row.value.trim().length > 0)) return 'errorHeader'
      return undefined
    }

    /**
     * The wire shape of a record: trimmed strings, dropped empty header rows, and
     * **no** `apiKey` member. The key is redacted on every read, so restating it
     * would erase the stored secret; callers add the path operation that writes a
     * key only when the user typed a new one.
     */
    function payloadOf(draft, fallbackId) {
      return {
        id: draft.id.length > 0 ? draft.id : fallbackId,
        name: draft.name.trim(),
        protocol: draft.protocol,
        baseUrl: draft.baseUrl.trim(),
        model: draft.model.trim(),
        headers: draft.headers
          .filter((row) => row.name.trim().length > 0)
          .map((row) => ({ name: row.name.trim(), value: row.value })),
        promptFormat: draft.promptFormat,
        promptPassThrough: draft.promptPassThrough,
        promptPrefix: draft.promptPrefix,
        promptNegative: draft.promptNegative,
        promptTemplate: draft.promptTemplate,
        params: {
          size: draft.params.size,
          width: Math.max(0, Math.trunc(draft.params.width) || 0),
          height: Math.max(0, Math.trunc(draft.params.height) || 0),
          steps: Math.max(0, Math.trunc(draft.params.steps) || 0),
          timeoutMs: Math.max(0, Math.trunc(draft.params.timeoutMs) || 0),
        },
        isDefault: draft.isDefault === true,
      }
    }

    /** A stable identity for a record the Host has not stored yet. */
    function mintId() {
      return `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    }

    // -------------------------------------------------------------------- styles

    const CSS = `
.dsh-img-section{box-sizing:border-box;max-width:720px;margin-top:32px;padding-top:24px;border-top:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}
.dsh-img-title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}
.dsh-img-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}
.dsh-img-notice{color:var(--dsw-alias-state-warn-primary);margin:0;font-size:12px;line-height:18px}
.dsh-img-error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:13px;line-height:20px}
.dsh-img-rows{flex-direction:column;gap:8px;margin:12px 0 0;padding:0;list-style:none;display:flex}
.dsh-img-card{border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl);flex-direction:column;gap:10px;padding:12px 14px;display:flex}
.dsh-img-head{align-items:center;gap:10px;display:flex}
.dsh-img-identity{align-items:center;gap:6px;min-width:0;display:inline-flex}
.dsh-img-field-name{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-img-tag{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-secondary);flex:none;padding:1px 6px;font-size:11px;line-height:16px}
.dsh-img-dot{border-radius:50%;flex:none;width:8px;height:8px;display:inline-block}
.dsh-img-dot-on{background:var(--dsw-alias-state-success-primary)}
.dsh-img-dot-off{background:var(--dsw-alias-state-idle-primary)}
.dsh-img-actions{align-items:center;gap:4px;margin-left:auto;display:inline-flex}
.dsh-img-meta{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px;word-break:break-all}
.dsh-img-editor{border-top:.5px solid var(--dsw-alias-border-l1);flex-direction:column;gap:16px;margin-top:4px;padding-top:14px;display:flex}
.dsh-img-group{flex-direction:column;gap:10px;display:flex}
.dsh-img-group-title{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;font-weight:500;line-height:18px}
.dsh-img-field{flex-direction:column;gap:6px;display:flex}
.dsh-img-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsh-img-hint{color:var(--dsw-alias-label-caption);margin:0;font-size:11px;line-height:16px}
.dsh-img-grid{flex-wrap:wrap;gap:10px;display:flex}
.dsh-img-grid > *{flex:1 1 160px;min-width:0}
.dsh-img-input,.dsh-img-select,.dsh-img-textarea{box-sizing:border-box;width:100%;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:0 10px;font-size:14px;line-height:22px;height:36px}
.dsh-img-textarea{resize:vertical;min-height:66px;padding:8px 10px;height:auto}
.dsh-img-input:disabled,.dsh-img-select:disabled,.dsh-img-textarea:disabled{color:var(--dsw-alias-label-dimmed);cursor:not-allowed}
.dsh-img-input:focus-visible,.dsh-img-select:focus-visible,.dsh-img-textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-img-header-row{align-items:center;gap:8px;display:flex}
.dsh-img-header-row .dsh-img-input{flex:1 1 0}
.dsh-img-primary,.dsh-img-secondary,.dsh-img-danger,.dsh-img-add{box-sizing:border-box;border-radius:var(--dsw-radius-md);height:36px;font:inherit;cursor:pointer;border:none;justify-content:center;align-items:center;gap:4px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}
.dsh-img-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dsh-img-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dsh-img-primary:disabled{background:var(--dsw-alias-button-primary-dimmed);cursor:not-allowed}
.dsh-img-secondary{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}
.dsh-img-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-img-secondary:disabled{cursor:not-allowed;color:var(--dsw-alias-label-dimmed)}
.dsh-img-danger{background:transparent;color:var(--dsw-alias-state-error-primary)}
.dsh-img-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-img-danger:disabled{cursor:not-allowed;color:var(--dsw-alias-label-dimmed)}
.dsh-img-add{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}
.dsh-img-add:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-img-add:disabled{cursor:not-allowed;color:var(--dsw-alias-label-dimmed)}
.dsh-img-link{background:transparent;border:none;color:var(--dsw-alias-link);cursor:pointer;padding:0;font:inherit;font-size:12px;line-height:18px;align-self:flex-start}
.dsh-img-link:hover:not(:disabled){text-decoration:underline}
.dsh-img-link:disabled{cursor:not-allowed;color:var(--dsw-alias-label-dimmed)}
.dsh-img-icon-button{box-sizing:border-box;width:28px;height:28px;border-radius:var(--dsw-radius-sm);border:none;cursor:pointer;color:var(--dsw-alias-label-secondary);background:transparent;justify-content:center;align-items:center;padding:0;font:inherit;font-size:16px;line-height:1;flex:none;display:inline-flex}
.dsh-img-icon-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-img-editor-actions{align-items:center;gap:8px;justify-content:flex-end;display:flex}
.dsh-img-empty{border:.5px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xl);flex-direction:column;gap:4px;margin-top:12px;padding:16px;display:flex}
.dsh-img-empty-title{color:var(--dsw-alias-label-primary);margin:0;font-size:14px;line-height:22px}
.dsh-img-checkbox-row{align-items:center;gap:8px;display:flex}
.dsh-img-scheduler{border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl);flex-direction:column;gap:8px;padding:12px 14px;display:flex}
`

    // ------------------------------------------------------------- view sections

    /** One labelled form field. */
    function Field(props) {
      return h('div', { className: 'dsh-img-field' }, [
        props.htmlFor === undefined
          ? h('span', { key: 'label', className: 'dsh-img-label' }, props.label)
          : h('label', { key: 'label', className: 'dsh-img-label', htmlFor: props.htmlFor }, props.label),
        // The control arrives from the caller without a key, and this array is a
        // list: cloning it with one keeps React's key warning honest.
        React.isValidElement(props.control) ? React.cloneElement(props.control, { key: 'control' }) : props.control,
        props.hint === undefined ? null : h('p', { key: 'hint', className: 'dsh-img-hint' }, props.hint),
      ])
    }

    /** The inline editor for one record. */
    function Editor(props) {
      const { t, draft, busy, secretSet, index, onPatch, onParams, onHeader, onSave, onCancel } = props
      const groups = []

      groups.push(
        h('div', { key: 'basic', className: 'dsh-img-group' }, [
          h('h3', { key: 'title', className: 'dsh-img-group-title' }, tr(t, 'basic')),
          h(Field, {
            key: 'name',
            htmlFor: 'dsh-img-field-name',
            label: tr(t, 'fieldName'),
            hint: tr(t, 'fieldNameHint'),
            control: h('input', {
              id: 'dsh-img-field-name',
              className: 'dsh-img-input',
              type: 'text',
              value: draft.name,
              disabled: busy,
              onChange: (event) => onPatch({ name: event.target.value }),
            }),
          }),
          h(Field, {
            key: 'protocol',
            htmlFor: 'dsh-img-field-protocol',
            label: tr(t, 'fieldProtocol'),
            control: h(
              'select',
              {
                id: 'dsh-img-field-protocol',
                className: 'dsh-img-select',
                value: draft.protocol,
                disabled: busy,
                onChange: (event) => onPatch({ protocol: event.target.value }),
              },
              PROTOCOLS.map((protocol) => h('option', { key: protocol, value: protocol }, tr(t, PROTOCOL_LABEL[protocol]))),
            ),
          }),
          h(Field, {
            key: 'url',
            htmlFor: 'dsh-img-field-url',
            label: tr(t, 'fieldBaseUrl'),
            control: h('input', {
              id: 'dsh-img-field-url',
              className: 'dsh-img-input',
              type: 'text',
              spellCheck: false,
              placeholder: 'https://api.example.com/v1',
              value: draft.baseUrl,
              disabled: busy,
              onChange: (event) => onPatch({ baseUrl: event.target.value }),
            }),
          }),
          h(Field, {
            key: 'key',
            htmlFor: 'dsh-img-field-key',
            label: tr(t, 'fieldApiKey'),
            hint: tr(t, secretSet ? 'apiKeySet' : 'apiKeyMissing'),
            control: h('input', {
              id: 'dsh-img-field-key',
              className: 'dsh-img-input',
              type: 'password',
              autoComplete: 'new-password',
              placeholder: tr(t, secretSet ? 'apiKeyPlaceholder' : 'apiKeyPlaceholderNew'),
              value: draft.apiKey,
              disabled: busy,
              onChange: (event) => onPatch({ apiKey: event.target.value }),
            }),
          }),
          h(Field, {
            key: 'model',
            htmlFor: 'dsh-img-field-model',
            label: tr(t, 'fieldModel'),
            control: h('input', {
              id: 'dsh-img-field-model',
              className: 'dsh-img-input',
              type: 'text',
              spellCheck: false,
              placeholder: 'dall-e-3',
              value: draft.model,
              disabled: busy,
              onChange: (event) => onPatch({ model: event.target.value }),
            }),
          }),
          h(
            'div',
            { key: 'headers', className: 'dsh-img-field' },
            [
              h('span', { key: 'label', className: 'dsh-img-label' }, tr(t, 'fieldHeaders')),
              ...draft.headers.map((row, headerIndex) =>
                h('div', { key: `header-${headerIndex}`, className: 'dsh-img-header-row' }, [
                  h('input', {
                    key: 'name',
                    className: 'dsh-img-input',
                    type: 'text',
                    spellCheck: false,
                    'aria-label': tr(t, 'headerName'),
                    value: row.name,
                    disabled: busy,
                    onChange: (event) => onHeader(headerIndex, { name: event.target.value }),
                  }),
                  h('input', {
                    key: 'value',
                    className: 'dsh-img-input',
                    type: 'text',
                    spellCheck: false,
                    'aria-label': tr(t, 'headerValue'),
                    value: row.value,
                    disabled: busy,
                    onChange: (event) => onHeader(headerIndex, { value: event.target.value }),
                  }),
                  h(
                    'button',
                    {
                      key: 'remove',
                      type: 'button',
                      className: 'dsh-img-icon-button',
                      disabled: busy,
                      'aria-label': tr(t, 'removeHeader', { name: row.name }),
                      onClick: () => props.onDropHeader(headerIndex),
                    },
                    '×',
                  ),
                ]),
              ),
              h(
                'button',
                { key: 'add', type: 'button', className: 'dsh-img-link', disabled: busy, onClick: props.onAddHeader },
                tr(t, 'addHeader'),
              ),
            ],
          ),
        ]),
      )

      groups.push(
        h('div', { key: 'format', className: 'dsh-img-group' }, [
          h('h3', { key: 'title', className: 'dsh-img-group-title' }, tr(t, 'formatting')),
          h(Field, {
            key: 'preset',
            htmlFor: 'dsh-img-field-preset',
            label: tr(t, 'fieldFormat'),
            control: h(
              'select',
              {
                id: 'dsh-img-field-preset',
                className: 'dsh-img-select',
                value: draft.promptFormat,
                disabled: busy,
                onChange: (event) => onPatch({ promptFormat: event.target.value }),
              },
              PROMPT_FORMATS.map((format) => h('option', { key: format, value: format }, tr(t, FORMAT_LABEL[format]))),
            ),
          }),
          h(Field, {
            key: 'passthrough',
            htmlFor: 'dsh-img-field-passthrough',
            label: tr(t, 'fieldPassThrough'),
            hint: tr(t, 'passHint'),
            control: h(
              'select',
              {
                id: 'dsh-img-field-passthrough',
                className: 'dsh-img-select',
                value: draft.promptPassThrough,
                disabled: busy,
                onChange: (event) => onPatch({ promptPassThrough: event.target.value }),
              },
              PASS_THROUGH_MODES.map((mode) => h('option', { key: mode, value: mode }, tr(t, PASS_LABEL[mode]))),
            ),
          }),
          h(Field, {
            key: 'prefix',
            htmlFor: 'dsh-img-field-prefix',
            label: tr(t, 'fieldPrefix'),
            hint: tr(t, 'prefixHint'),
            control: h('textarea', {
              id: 'dsh-img-field-prefix',
              className: 'dsh-img-textarea',
              value: draft.promptPrefix,
              disabled: busy,
              onChange: (event) => onPatch({ promptPrefix: event.target.value }),
            }),
          }),
          h(Field, {
            key: 'negative',
            htmlFor: 'dsh-img-field-negative',
            label: tr(t, 'fieldNegative'),
            hint: tr(t, 'negativeHint'),
            control: h('textarea', {
              id: 'dsh-img-field-negative',
              className: 'dsh-img-textarea',
              value: draft.promptNegative,
              disabled: busy,
              onChange: (event) => onPatch({ promptNegative: event.target.value }),
            }),
          }),
          draft.promptFormat === 'custom'
            ? h(Field, {
                key: 'template',
                htmlFor: 'dsh-img-field-template',
                label: tr(t, 'fieldTemplate'),
                hint: tr(t, 'templateHint'),
                control: h('textarea', {
                  id: 'dsh-img-field-template',
                  className: 'dsh-img-textarea',
                  value: draft.promptTemplate,
                  disabled: busy,
                  onChange: (event) => onPatch({ promptTemplate: event.target.value }),
                }),
              })
            : null,
        ]),
      )

      const standardSize = SIZE_PRESETS.some(
        (preset) => preset.key !== 'auto' && preset.key !== 'custom' && preset.width === draft.params.width && preset.height === draft.params.height,
      )
      const customSize = draft.params.size === 'custom' || (draft.params.size !== 'auto' && !standardSize)
      groups.push(
        h('div', { key: 'advanced', className: 'dsh-img-group' }, [
          h('h3', { key: 'title', className: 'dsh-img-group-title' }, tr(t, 'advanced')),
          h('div', { key: 'grid', className: 'dsh-img-grid' }, [
            h(Field, {
              key: 'size',
              htmlFor: 'dsh-img-field-size',
              label: tr(t, 'fieldSize'),
              control: h(
                'select',
                {
                  id: 'dsh-img-field-size',
                  className: 'dsh-img-select',
                  value: customSize ? 'custom' : draft.params.size === '' ? 'auto' : draft.params.size,
                  disabled: busy,
                  onChange: (event) => {
                    const next = event.target.value
                    const preset = SIZE_PRESETS.find((candidate) => candidate.key === next)
                    if (next === 'custom' || preset === undefined || next === 'auto') onParams({ size: next === 'auto' ? '' : next })
                    else onParams({ size: next, width: preset.width, height: preset.height })
                  },
                },
                [
                  ...SIZE_PRESETS.map((preset) => h('option', { key: preset.key, value: preset.key }, tr(t, SIZE_LABEL[preset.key]))),
                  h('option', { key: 'custom', value: 'custom' }, tr(t, 'sizeDetail')),
                ],
              ),
            }),
            h(Field, {
              key: 'steps',
              htmlFor: 'dsh-img-field-steps',
              label: tr(t, 'fieldSteps'),
              control: h('input', {
                id: 'dsh-img-field-steps',
                className: 'dsh-img-input',
                type: 'number',
                min: 0,
                step: 1,
                value: draft.params.steps,
                disabled: busy,
                onChange: (event) => onParams({ steps: Number(event.target.value) }),
              }),
            }),
          ]),
          customSize
            ? h('div', { key: 'wh', className: 'dsh-img-grid' }, [
                h(Field, {
                  key: 'width',
                  htmlFor: 'dsh-img-field-width',
                  label: tr(t, 'fieldWidth'),
                  control: h('input', {
                    id: 'dsh-img-field-width',
                    className: 'dsh-img-input',
                    type: 'number',
                    min: 0,
                    step: 1,
                    value: draft.params.width,
                    disabled: busy,
                    onChange: (event) => onParams({ width: Number(event.target.value) }),
                  }),
                }),
                h(Field, {
                  key: 'height',
                  htmlFor: 'dsh-img-field-height',
                  label: tr(t, 'fieldHeight'),
                  control: h('input', {
                    id: 'dsh-img-field-height',
                    className: 'dsh-img-input',
                    type: 'number',
                    min: 0,
                    step: 1,
                    value: draft.params.height,
                    disabled: busy,
                    onChange: (event) => onParams({ height: Number(event.target.value) }),
                  }),
                }),
              ])
            : null,
          h(Field, {
            key: 'timeout',
            htmlFor: 'dsh-img-field-timeout',
            label: tr(t, 'fieldTimeout'),
            control: h('input', {
              id: 'dsh-img-field-timeout',
              className: 'dsh-img-input',
              type: 'number',
              min: 0,
              step: 1000,
              value: draft.params.timeoutMs,
              disabled: busy,
              onChange: (event) => onParams({ timeoutMs: Number(event.target.value) }),
            }),
          }),
          h('div', { key: 'default', className: 'dsh-img-checkbox-row' }, [
            h('input', {
              key: 'box',
              id: 'dsh-img-field-isdefault',
              type: 'checkbox',
              checked: draft.isDefault,
              disabled: busy,
              onChange: (event) => onPatch({ isDefault: event.target.checked }),
            }),
            h('label', { key: 'label', className: 'dsh-img-hint', htmlFor: 'dsh-img-field-isdefault' }, tr(t, 'defaultHint')),
          ]),
        ]),
      )

      groups.push(
        h('div', { key: 'actions', className: 'dsh-img-editor-actions' }, [
          h('button', { key: 'cancel', type: 'button', className: 'dsh-img-secondary', disabled: busy, onClick: onCancel }, tr(t, 'cancel')),
          h('button', { key: 'save', type: 'button', className: 'dsh-img-primary', disabled: busy, onClick: onSave }, tr(t, busy ? 'saving' : 'save')),
        ]),
      )

      return h('div', { key: `editor-${index}`, className: 'dsh-img-editor' }, groups)
    }

    /**
     * The automatic-scheduling controls: the plugin's total switch for this
     * behavior, plus the defaults one automatic request uses.
     *
     * These are root fields of the namespace rather than per-model settings, so a
     * change writes single scalar paths and never touches a stored secret.
     *
     * @param props - `{ t, scheduler, writable, onSave }`.
     */
    function SchedulerPanel(props) {
      const { t, scheduler, writable, onSave } = props
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState('')
      const [saved, setSaved] = React.useState(false)

      const current = draft ?? scheduler
      const patch = (values) => {
        setSaved(false)
        setFailure('')
        setDraft((previous) => ({ ...(previous ?? scheduler), ...values }))
      }

      const commit = async () => {
        setBusy(true)
        setFailure('')
        const outcome = await onSave(current)
        setBusy(false)
        if (outcome !== undefined && outcome !== null && outcome.ok === true) {
          setDraft(null)
          setSaved(true)
          return
        }
        setFailure(
          `${tr(t, 'schedulerFailed')}: ${outcome !== undefined && outcome !== null && outcome.message !== undefined ? String(outcome.message) : ''}`,
        )
      }

      const toggle = (key) =>
        h('input', {
          key,
          id: `dsh-img-field-${key}`,
          type: 'checkbox',
          checked: current[key] === true,
          disabled: busy || !writable,
          onChange: (event) => patch({ [key]: event.target.checked }),
        })

      return h('div', { className: 'dsh-img-scheduler' }, [
        h('h3', { key: 'title', className: 'dsh-img-group-title' }, tr(t, 'scheduler')),
        h('div', { key: 'auto', className: 'dsh-img-checkbox-row' }, [
          toggle('autoGenerate'),
          h(
            'label',
            { key: 'label', className: 'dsh-img-label', htmlFor: 'dsh-img-field-autoGenerate' },
            tr(t, 'autoGenerate'),
          ),
        ]),
        h('p', { key: 'autohint', className: 'dsh-img-hint' }, tr(t, 'autoGenerateHint')),
        h('div', { key: 'announce', className: 'dsh-img-checkbox-row' }, [
          toggle('announce'),
          h('label', { key: 'label', className: 'dsh-img-label', htmlFor: 'dsh-img-field-announce' }, tr(t, 'announce')),
        ]),
        h('p', { key: 'announcehint', className: 'dsh-img-hint' }, tr(t, 'announceHint')),
        h('div', { key: 'numbers', className: 'dsh-img-grid' }, [
          h(Field, {
            key: 'count',
            htmlFor: 'dsh-img-field-autoImageCount',
            label: tr(t, 'autoImageCount'),
            hint: tr(t, 'autoImageCountHint'),
            control: h('input', {
              id: 'dsh-img-field-autoImageCount',
              className: 'dsh-img-input',
              type: 'number',
              min: 1,
              max: 4,
              value: current.autoImageCount,
              disabled: busy || !writable,
              onChange: (event) => patch({ autoImageCount: Math.max(1, Math.min(4, Number(event.target.value) || 1)) }),
            }),
          }),
          h(Field, {
            key: 'width',
            htmlFor: 'dsh-img-field-autoWidth',
            label: tr(t, 'autoWidth'),
            hint: tr(t, 'autoSizeHint'),
            control: h('input', {
              id: 'dsh-img-field-autoWidth',
              className: 'dsh-img-input',
              type: 'number',
              min: 0,
              step: 64,
              value: current.autoWidth,
              disabled: busy || !writable,
              onChange: (event) => patch({ autoWidth: Math.max(0, Number(event.target.value) || 0) }),
            }),
          }),
          h(Field, {
            key: 'height',
            htmlFor: 'dsh-img-field-autoHeight',
            label: tr(t, 'autoHeight'),
            control: h('input', {
              id: 'dsh-img-field-autoHeight',
              className: 'dsh-img-input',
              type: 'number',
              min: 0,
              step: 64,
              value: current.autoHeight,
              disabled: busy || !writable,
              onChange: (event) => patch({ autoHeight: Math.max(0, Number(event.target.value) || 0) }),
            }),
          }),
        ]),
        h(
          'div',
          { key: 'actions', className: 'dsh-img-editor-actions' },
          [
            failure.length > 0
              ? h('p', { key: 'failure', className: 'dsh-img-error', role: 'alert' }, failure)
              : saved
                ? h('p', { key: 'saved', className: 'dsh-img-hint', role: 'status' }, tr(t, 'schedulerSaved'))
                : null,
            h(
              'button',
              {
                key: 'save',
                type: 'button',
                className: 'dsh-img-secondary',
                disabled: busy || !writable || draft === null,
                onClick: commit,
              },
              tr(t, 'schedulerSave'),
            ),
          ],
        ),
      ])
    }

    /**
     * The image-generation model access area rendered at the foot of the Models
     * settings page, after the native conversation-model rows.
     *
     * @param props - slot props: `useSnapshot` (page state), `operations`, `t`.
     */
    function ImageModelsSection(props) {
      const snapshot = typeof props.useSnapshot === 'function' ? props.useSnapshot((state) => state) : undefined
      const operations = props.operations
      const t = props.t

      const [editingIndex, setEditingIndex] = React.useState(-1)
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState('')
      const [pendingDelete, setPendingDelete] = React.useState(-1)

      // Every read is total: a slot entry that throws is caught by the renderer's
      // error boundary and blanks the whole contribution, so the view never trusts
      // a field to exist — the snapshot it sees belongs to the framework's binding,
      // not to a shape this file can fully control.
      const status = snapshot === undefined || typeof snapshot.status !== 'string' ? 'loading' : snapshot.status
      const writable = snapshot !== undefined && snapshot.writable === true
      const models = snapshot !== undefined && Array.isArray(snapshot.models) ? snapshot.models : []
      const secrets = snapshot !== undefined && Array.isArray(snapshot.secrets) ? snapshot.secrets : []
      const revision = snapshot === undefined ? undefined : snapshot.revision
      const defaultModel = models.find((model) => model.isDefault === true)

      const patchDraft = (patch) => setDraft((previous) => (previous === null ? previous : { ...previous, ...patch }))
      const patchParams = (patch) => setDraft((previous) => (previous === null ? previous : { ...previous, params: { ...previous.params, ...patch } }))
      const patchHeader = (index, patch) =>
        setDraft((previous) =>
          previous === null ? previous : { ...previous, headers: previous.headers.map((row, at) => (at === index ? { ...row, ...patch } : row)) },
        )
      const dropHeader = (index) =>
        setDraft((previous) => (previous === null ? previous : { ...previous, headers: previous.headers.filter((_, at) => at !== index) }))
      const addHeader = () => setDraft((previous) => (previous === null ? previous : { ...previous, headers: [...previous.headers, { name: '', value: '' }] }))

      const openEditor = (index) => {
        setFailure('')
        setPendingDelete(-1)
        setEditingIndex(index)
        setDraft(index < 0 ? blankModel() : JSON.parse(JSON.stringify(models[index])))
      }
      const closeEditor = () => {
        setEditingIndex(-1)
        setDraft(null)
        setFailure('')
      }

      /**
       * The inline editor element for one draft, shared by a stored record's card
       * and the add card.
       *
       * @param index - the record being edited, or -1 for a new one.
       * @param secretSet - whether the record already stores an API key.
       */
      const editorNode = (index, secretSet) =>
        h(Editor, {
          key: 'editor',
          t,
          index,
          draft,
          busy,
          secretSet,
          onPatch: patchDraft,
          onParams: patchParams,
          onHeader: patchHeader,
          onAddHeader: addHeader,
          onDropHeader: dropHeader,
          onSave: save,
          onCancel: closeEditor,
        })

      /** Normalize a write answer into what the card renders. */
      const report = (outcome) => {
        if (outcome !== undefined && outcome !== null && outcome.ok === true) return true
        const message = outcome !== undefined && outcome !== null && outcome.message !== undefined ? String(outcome.message) : ''
        setFailure(
          outcome !== undefined && outcome !== null && outcome.conflict === true
            ? `${tr(t, 'conflict')} ${message}`.trim()
            : `${tr(t, 'refused')}: ${message}`,
        )
        return false
      }

      const save = async () => {
        if (draft === null || operations === undefined || operations === null) return
        const invalidField = validateDraft(draft, models, editingIndex)
        if (invalidField !== undefined) {
          setFailure(tr(t, invalidField))
          return
        }
        setBusy(true)
        setFailure('')
        const outcome = await operations.saveModel(editingIndex, draft, revision)
        setBusy(false)
        if (!report(outcome)) return
        closeEditor()
      }

      const remove = async (index) => {
        if (operations === undefined || operations === null) return
        setBusy(true)
        setFailure('')
        const outcome = await operations.removeModel(index, revision)
        setBusy(false)
        setPendingDelete(-1)
        report(outcome)
      }

      const makeDefault = async (index) => {
        if (operations === undefined || operations === null || !writable) return
        setFailure('')
        report(await operations.setDefault(index, revision))
      }

      const children = [
        h('style', { key: 'css' }, CSS),
        h('h2', { key: 'title', className: 'dsh-img-title' }, tr(t, 'title')),
        h('p', { key: 'intro', className: 'dsh-img-intro' }, tr(t, 'intro')),
        h(SchedulerPanel, {
          key: 'scheduler',
          t,
          scheduler: snapshot === undefined || snapshot.scheduler === undefined ? DEFAULT_SCHEDULER : snapshot.scheduler,
          writable,
          onSave: (values) => (operations === undefined || operations === null ? undefined : operations.saveScheduler(values, revision)),
        }),
      ]

      if (status === 'unavailable') {
        children.push(h('p', { key: 'unavailable', className: 'dsh-img-notice' }, tr(t, 'unavailable')))
      } else if (status === 'ready' && !writable) {
        children.push(h('p', { key: 'readonly', className: 'dsh-img-notice' }, tr(t, 'readOnly')))
      } else if (status === 'error') {
        children.push(
          h('p', { key: 'load-error', className: 'dsh-img-error' }, `${tr(t, 'loadFailed')}: ${snapshot.error === null ? '' : snapshot.error}`),
          h(
            'div',
            { key: 'retry-row', className: 'dsh-img-editor-actions' },
            h(
              'button',
              { type: 'button', className: 'dsh-img-secondary', onClick: () => operations !== undefined && operations !== null && operations.reload() },
              tr(t, 'retry'),
            ),
          ),
        )
      }

      if (status === 'ready' || status === 'loading') {
        children.push(
          h(
            'p',
            { key: 'default', className: 'dsh-img-meta' },
            defaultModel === undefined ? tr(t, 'noDefault') : `${tr(t, 'isDefault')}: ${defaultModel.name.length > 0 ? defaultModel.name : defaultModel.id}`,
          ),
        )
      }

      if (status === 'ready' && models.length === 0) {
        children.push(
          h('div', { key: 'empty', className: 'dsh-img-empty' }, [
            h('p', { key: 'title', className: 'dsh-img-empty-title' }, tr(t, 'emptyTitle')),
            h('p', { key: 'hint', className: 'dsh-img-hint' }, tr(t, 'emptyHint')),
          ]),
        )
      }

      if (models.length > 0) {
        children.push(
          h(
            'ul',
            { key: 'rows', className: 'dsh-img-rows' },
            models.map((model, index) => {
              const keySet = secretSetAt(secrets, index)
              const open = editingIndex === index
              const identity = [
                h('span', { key: 'name', className: 'dsh-img-field-name' }, model.name.length > 0 ? model.name : model.id),
                h('span', { key: 'protocol', className: 'dsh-img-tag' }, tr(t, PROTOCOL_LABEL[model.protocol] === undefined ? 'protocolCustom' : PROTOCOL_LABEL[model.protocol])),
              ]
              if (model.isDefault) identity.push(h('span', { key: 'default', className: 'dsh-img-tag' }, tr(t, 'isDefault')))
              identity.push(
                h('span', {
                  key: 'credential',
                  className: `dsh-img-dot ${keySet ? 'dsh-img-dot-on' : 'dsh-img-dot-off'}`,
                  role: 'img',
                  'aria-label': tr(t, keySet ? 'apiKeySet' : 'apiKeyMissing'),
                  title: tr(t, keySet ? 'apiKeySet' : 'apiKeyMissing'),
                }),
              )

              const actions = [
                h(
                  'button',
                  { key: 'edit', type: 'button', className: 'dsh-img-secondary', disabled: !writable, onClick: () => (open ? closeEditor() : openEditor(index)) },
                  tr(t, open ? 'collapse' : 'edit'),
                ),
              ]
              if (!model.isDefault) {
                actions.push(
                  h(
                    'button',
                    { key: 'default', type: 'button', className: 'dsh-img-secondary', disabled: !writable || busy, onClick: () => makeDefault(index) },
                    tr(t, 'setDefault'),
                  ),
                )
              }
              actions.push(
                h(
                  'button',
                  {
                    key: 'remove',
                    type: 'button',
                    className: 'dsh-img-danger',
                    disabled: !writable || busy,
                    onClick: () => setPendingDelete(pendingDelete === index ? -1 : index),
                  },
                  tr(t, 'remove'),
                ),
              )

              const body = [
                h('div', { key: 'head', className: 'dsh-img-head' }, [
                  h('span', { key: 'identity', className: 'dsh-img-identity' }, identity),
                  h('span', { key: 'actions', className: 'dsh-img-actions' }, actions),
                ]),
              ]
              const meta = [model.model, model.baseUrl].filter((part) => part.length > 0).join(' · ')
              if (meta.length > 0) body.push(h('p', { key: 'meta', className: 'dsh-img-meta' }, meta))
              if (pendingDelete === index) {
                body.push(
                  h('div', { key: 'delete', className: 'dsh-img-group' }, [
                    h('p', { key: 'title', className: 'dsh-img-error' }, tr(t, 'deleteTitle', { name: model.name })),
                    h('p', { key: 'description', className: 'dsh-img-hint' }, tr(t, 'deleteDescription')),
                    h('div', { key: 'actions', className: 'dsh-img-editor-actions' }, [
                      h('button', { key: 'cancel', type: 'button', className: 'dsh-img-secondary', onClick: () => setPendingDelete(-1) }, tr(t, 'cancel')),
                      h('button', { key: 'confirm', type: 'button', className: 'dsh-img-danger', disabled: busy, onClick: () => remove(index) }, tr(t, busy ? 'deleting' : 'deleteConfirm', { name: model.name })),
                    ]),
                  ]),
                )
              }
              if (open && draft !== null) body.push(editorNode(index, keySet))
              return h('li', { key: `${model.id}-${index}`, className: 'dsh-img-card' }, body)
            }),
          ),
        )
      }

      // A draft that is not editing a stored record gets its own card. It must
      // live OUTSIDE the rows branch above: with no stored records there is no
      // `<li>` to host it, and the add control would otherwise open nothing.
      if (editingIndex < 0 && draft !== null) {
        children.push(h('div', { key: 'draft-card', className: 'dsh-img-card' }, editorNode(-1, false)))
      }

      children.push(
        h(
          'div',
          { key: 'add' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-img-add',
              // One draft at a time: the add card is the only way to open a new
              // record, so it is locked while any draft is open (an existing
              // record's editor included) and unlocked again when it closes.
              disabled: !writable || draft !== null,
              onClick: () => openEditor(-1),
            },
            `+ ${tr(t, 'add')}`,
          ),
        ),
      )

      if (failure.length > 0) children.push(h('p', { key: 'failure', className: 'dsh-img-error', role: 'alert' }, failure))

      return h('section', { className: 'dsh-img-section', 'aria-label': tr(t, 'title') }, children)
    }

    // ------------------------------------------------------------------ mounting

    /** Required client services (cordis fiber inject). */
    const inject = ['slots', 'locale', 'configForms', 'remote.settings']

    /**
     * Mount the image-generation model access area in the Models settings page.
     *
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'image-studio: dictionaries')

      // The stylesheet rides the section as a child: this bundle is hand written
      // plain JavaScript, it declares no `styles` service in `inject`, and a
      // component-owned <style> element is removed by React on unmount — no
      // separate style lifecycle to keep correct.
      const scope = ctx.configForms.get(IMAGE_NS)
      const store = createStore(toSectionState(undefined))
      ctx.effect(() => {
        const publish = () => {
          // The Host reports a `role('secret')` position as a `secrets` entry, never
          // as a value. `ConfigFormController.getSnapshot()` drops that field — it
          // copies revision, base, user, writable and the decoded value only — so the
          // positions are read from the shared describe mirror the controller derives
          // from. Without this the key indicator could only ever say "not saved".
          const mirrored = ctx.configForms.describe()
          store.set(toSectionState(scope.getSnapshot(), secretsOf(mirrored.getSnapshot().view)))
        }
        const unsubscribe = scope.subscribe(publish)
        const unsubscribeMirror = ctx.configForms.describe().subscribe(publish)
        publish()
        return () => {
          unsubscribe()
          unsubscribeMirror()
        }
      }, 'image-studio: settings mirror')

      /** Bind one write answer into the shape the card renders. */
      const settle = (promise) =>
        Promise.resolve(promise).then(
          (ok) => ({ ok: ok === true }),
          (error) => ({
            ok: false,
            message: error !== undefined && error !== null && error.message !== undefined ? String(error.message) : String(error),
          }),
        )

      /** Read the current list through the scope's own last value. */
      const currentModels = () => modelsOf(scope.getSnapshot().value)

      const operations = {
        /**
         * Store one record. `apiKey` never rides a whole-record write: the value
         * the page holds is the redacted placeholder, so restating it would erase
         * the secret. The key is written as its own path operation, and only when
         * the user typed a new one.
         *
         * @param index - index being edited, or -1 for a new record.
         * @param draft - the editor's draft.
         * @param revision - revision the editor read.
         */
        async saveModel(index, draft, revision) {
          const payload = payloadOf(draft, mintId())
          const typedApiKey = typeof draft.apiKey === 'string' ? draft.apiKey : ''
          const target = index < 0 ? currentModels().length : index
          const ops = []
          if (index < 0) {
            ops.push({ op: 'set', path: [MODELS_PATH, String(target)], value: payload })
            if (typedApiKey.length > 0) {
              ops.push({ op: 'set', path: [MODELS_PATH, String(target), 'apiKey'], value: typedApiKey })
            }
          } else {
            for (const [key, value] of Object.entries(payload)) {
              if (key === 'isDefault') continue
              ops.push({ op: 'set', path: [MODELS_PATH, String(target), key], value })
            }
            ops.push({ op: 'set', path: [MODELS_PATH, String(target), 'isDefault'], value: payload.isDefault })
            if (typedApiKey.length > 0) {
              ops.push({ op: 'set', path: [MODELS_PATH, String(target), 'apiKey'], value: typedApiKey })
            }
          }
          if (payload.isDefault) {
            currentModels().forEach((model, at) => {
              if (at === target || !model.isDefault) return
              ops.push({ op: 'set', path: [MODELS_PATH, String(at), 'isDefault'], value: false })
            })
          }
          return settle(scope.mutate(ops, revision))
        },
        async removeModel(index, revision) {
          return settle(scope.mutate([{ op: 'unset', path: [MODELS_PATH, String(index)] }], revision))
        },
        /**
         * Store the automatic-scheduling controls.
         *
         * These are root scalars: each one is written as its own path so a stored
         * model record (and every stored key inside it) is never restated.
         *
         * @param values - `{ autoGenerate, announce, autoImageCount, autoWidth, autoHeight }`.
         * @param revision - revision the page read.
         */
        async saveScheduler(values, revision) {
          const ops = [
            { op: 'set', path: ['autoGenerate'], value: values.autoGenerate === true },
            { op: 'set', path: ['announce'], value: values.announce === true },
            { op: 'set', path: ['autoImageCount'], value: Math.max(1, Math.min(4, Math.trunc(values.autoImageCount) || 1)) },
            { op: 'set', path: ['autoWidth'], value: Math.max(0, Math.trunc(values.autoWidth) || 0) },
            { op: 'set', path: ['autoHeight'], value: Math.max(0, Math.trunc(values.autoHeight) || 0) },
          ]
          return settle(scope.mutate(ops, revision))
        },
        async setDefault(index, revision) {
          const ops = []
          currentModels().forEach((model, at) => {
            const wanted = at === index
            if (model.isDefault !== wanted) ops.push({ op: 'set', path: [MODELS_PATH, String(at), 'isDefault'], value: wanted })
          })
          if (ops.length === 0) return { ok: true }
          return settle(scope.mutate(ops, revision))
        },
        reload() {
          const mirror = ctx.configForms.describe()
          if (mirror !== undefined && mirror !== null && typeof mirror.load === 'function') return mirror.load()
          return undefined
        },
      }

      ctx.effect(
        () =>
          ctx.slots.inject(FOOTER_SLOT, () =>
            ctx.slots.register(
              {
                name: FOOTER_SLOT,
                id: 'image-models',
                order: 20,
                label: () => tr(t, 'title'),
                locale: NS,
                inject: () => ({ hooks: { snapshot: store }, operations }),
              },
              ImageModelsSection,
            ),
          ),
        'image-studio: image model section',
      )
    }

    return { inject, apply }
  },
})
