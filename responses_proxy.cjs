const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

(function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    try {
        if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, 'utf-8');
            for (const line of content.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) continue;
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx === -1) continue;
                const key = trimmed.substring(0, eqIdx).trim();
                let value = trimmed.substring(eqIdx + 1).trim();
                if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1);
                }
                if (key && !process.env[key]) {
                    process.env[key] = value;
                }
            }
        }
    } catch (_) {}
})();

const NVIDIA_HOST = 'integrate.api.nvidia.com';
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;

// 上游请求专用的 HTTPS agent，刻意禁用 keep-alive。
//
// 为什么不用默认的全局 agent：Node 19 起 `http.globalAgent.keepAlive` 默认为 true
// （本机 Node v24 实测确认），响应结束后 socket 会被放回连接池供下次复用。而 NIM
// 边缘节点在上一个响应结束时就关闭了这条连接，于是紧跟着的下一个请求会**毫秒级复用
// 一条半开（half-open）的 socket**：本地写入不报错、对端永不回 ACK，TCP 重传耗尽
// 大约 40 秒后才抛 `read ECONNRESET`。
//
// 日志实锤（一次 6 轮搜索回合）：只有"紧接上一轮"的 5~6 次首尝试全部在 40.0~40.9s
// 被掐，重试换成新连接后即使 prefill 花 70s 也能成功——说明 40s 不是 NIM 的固定
// 上限，而是那条被复用的死连接本身的问题；间隔 98s 后才发的 R0（连接已被 agent
// 回收）则一次成功。白白拖慢每一轮约 40 秒。
//
// `keepAlive: false` 让每次请求都新建 TCP/TLS 连接，从根上消除复用；代价仅一次
// 握手（百毫秒级），相对每轮 40~70s 的排队+prefill 可忽略。
const NVIDIA_AGENT = new https.Agent({ keepAlive: false });
const PROXY_PORT = 15721;
const CONFIG_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '~', '.codex', 'config.toml');
const MODEL_STATE_PATH = path.join(__dirname, 'model_state.json');
const MODEL_LIST_PATH = path.join(__dirname, 'models.json');
const MODEL_BLACKLIST_PATH = path.join(__dirname, 'model_blacklist.json');
const MODEL_CATALOG_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '~', '.codex', 'model-catalog.json');
const DEBUG = (process.env.DEBUG || '').toLowerCase() === 'true';

const PROXY_API_BASE = 'http://127.0.0.1:15721/v1';

// 单轮对话里最多允许模型发起多少次联网搜索。流式与非流式两条路径共用同一个
// 预算，避免两边行为不一致。
const MAX_HOSTED_WEB_SEARCH_ROUNDS = 6;

// 顶层由代理负责写入/清理的键（不属于任何 [section]）。
// 清理时只对这些键动手，绝不改动用户自己定义的其它 provider 段。
//
// 但这几个键是 Codex 的"单选"键：代理运行期间必须占用（model_provider 指向
// nvidia-proxy、model 是我们提供的 slug），而它们的原值很可能是别的工具写的
// ——实测 cc-switch 的 Nvidia 预设在顶层写 model_provider="custom"、
// model="z-ai/glm-5.3-flash"、model_catalog_json="cc-switch-model-catalog.json"、
// model_reasoning_effort="medium"，全部命中下面这份名单。因此启动时要先把原值
// 抄进 model_state.json，退出时再原样还回去；否则用户原先选中的 provider 会被
// 永久抹掉（表现为"换过 provider 之后 Codex 不认原有的历史线程"）。
const PROXY_TOP_KEY_NAMES = [
    'api_base_url', 'model_provider', 'model', 'model_catalog_json',
    'model_context_window', 'model_auto_compact_token_limit',
    'model_reasoning_effort', 'model_reasoning_summary',
    'model_supports_reasoning_summaries', 'show_raw_agent_reasoning',
    'hide_agent_reasoning'
];
const PROXY_TOP_KEYS = new RegExp('^(' + PROXY_TOP_KEY_NAMES.join('|') + ')\\s*=');
const PROXY_PROVIDER_SECTION = 'model_providers.nvidia-proxy';

// 上下文窗口（token）——只收录经官网核实过的值，未列出的模型一律保守按 128K。
// 宁可让 Codex 提前压缩，也不能让它以为窗口很大而一直不压缩（那正是之前会话
// 撑到几百 MB 才被 413 拦下的根源）。
const CONTEXT_WINDOWS = [
    [/glm-5\.3/, 1048576],   // build.nvidia.com/z-ai/glm-5-3-flash: Context Length 1M
    [/kimi-k2/, 262144]      // Kimi K2 官方 256K
];
const DEFAULT_CONTEXT_WINDOW = 131072;
const AUTO_COMPACT_RATIO = 0.7; // 压缩阈值取窗口的 70%，给压缩摘要留出生成空间

function contextWindowFor(modelId) {
    const hit = CONTEXT_WINDOWS.find(([re]) => re.test(modelId));
    return hit ? hit[1] : DEFAULT_CONTEXT_WINDOW;
}

function isThinkingModel(modelId) {
    return /thinking|deepseek-v4-pro|kimi-k2/.test(modelId);
}

// 从 TOML 内容中移除代理写入的配置：
// - 整段删除 [model_providers.nvidia-proxy]（含 header 与段内所有键）
// - 删除顶层（尚未进入任何 [section]）的代理键
// 其余内容（例如用户自定义的 [model_providers.custom] 等）原样保留，
// 这样历史线程引用的其它 provider 名不会因代理启动/退出而被破坏。
function removeProxyConfig(content, restoreLines) {
    const lines = content.split(/\r?\n/);
    const out = [];
    let currentSection = null;
    for (const line of lines) {
        const secHeader = line.match(/^\s*\[([^\]]*)\]\s*$/);
        if (secHeader) {
            currentSection = secHeader[1].trim();
            if (currentSection === PROXY_PROVIDER_SECTION) {
                // 跳过 nvidia-proxy 段 header 及其后所有键
                continue;
            }
            out.push(line);
            continue;
        }
        if (currentSection === PROXY_PROVIDER_SECTION) {
            // 跳过 nvidia-proxy 段内部所有键
            continue;
        }
        out.push(line);
    }
    // 删除顶层代理键（仅在文件开头、任何 [section] 之前出现）
    const result = [];
    let inSection = false;
    for (const line of out) {
        if (/^\s*\[([^\]]*)\]\s*$/.test(line)) {
            inSection = true;
            result.push(line);
            continue;
        }
        if (!inSection && PROXY_TOP_KEYS.test(line)) {
            continue;
        }
        result.push(line);
    }
    // 把启动时抄下的原顶层键放回文件最前面。必须是 unshift 而不是 push：顶层键
    // 只能出现在任何 [section] 之前，追加到末尾会被 TOML 并入最后一个 section。
    // 这些键在同一函数的前一段循环里已被整行删除，所以不会与残留行重复。
    if (Array.isArray(restoreLines) && restoreLines.length > 0) {
        result.unshift(...restoreLines);
    }
    return result.join('\n');
}

// 读/合并写 model_state.json。用合并写（而不是整份覆盖）是为了让 restoreTopKeys
// 与 model 两个字段互不覆盖——两处调用点各自只知道自己那一个字段。
function readState() {
    try {
        if (fs.existsSync(MODEL_STATE_PATH)) {
            return JSON.parse(fs.readFileSync(MODEL_STATE_PATH, 'utf-8')) || {};
        }
    } catch (e) {}
    return {};
}

function writeState(patch) {
    try {
        fs.writeFileSync(MODEL_STATE_PATH, JSON.stringify(Object.assign(readState(), patch)), 'utf-8');
    } catch (e) {}
}

// 抄取"第一个 [section] 之前"的顶层键原始行，只留代理会占用的那些。
// 只认 `key = value` 行：注释行不复制，以免把别人的注释也一并搬来搬去。
function captureTopLevelKeys(content) {
    const captured = [];
    for (const line of content.split(/\r?\n/)) {
        if (/^\s*\[([^\]]*)\]\s*$/.test(line)) break;
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (m && PROXY_TOP_KEY_NAMES.includes(m[1])) {
            captured.push(line);
        }
    }
    return captured;
}

// 把"别人写的"顶层键原值登记进 state，供退出时还原。**必须在真正删除键之前调用**
// ——一旦删掉，原值就再也找不回来。第一版把它放在删除之后的 writeProxyConfig 里，
// 测试实测 state 存下来的是空数组、退出后原值全丢，因此改到本节。
// 已经是我们写的值（文件里有标志行）不登记，否则会把我们自己的 slug 当原值存起来。
//
// 反向也要管：既没有标志行、又抄不到任何键时，说明当前配置已被别的工具整份重写
// 过（实测 cc-switch 会按自己的模板重写 config.toml），上一次登记的原值已经过期
// ——清掉它，否则下次退出会把过期的原值"复活"到别人刚写好的配置上。
function noteOriginals(content) {
    if (/^\s*model_provider\s*=\s*"nvidia-proxy"/m.test(content)) return;
    const captured = captureTopLevelKeys(content);
    if (captured.length > 0) writeState({ restoreTopKeys: captured });
    else if (readState().restoreTopKeys) writeState({ restoreTopKeys: null });
}

// `restore` 为 true 时把 state 里登记的原值还原回文件并清空登记（退出路径）；
// 为 false 时只做清理（启动路径：上一轮若已正常退出，原值早就还原过了，再还原
// 一次反而会把用户后来手动改的值顶掉）。
function stripProxyConfig(restore) {
    try {
        if (!fs.existsSync(CONFIG_PATH)) return;
        const before = fs.readFileSync(CONFIG_PATH, 'utf-8');
        noteOriginals(before);
        const state = readState();
        const restoreLines = restore && Array.isArray(state.restoreTopKeys) ? state.restoreTopKeys : [];
        const content = removeProxyConfig(before, restoreLines).trimEnd();
        if (content !== before.trimEnd()) {
            fs.writeFileSync(CONFIG_PATH, content ? content + '\n' : '', 'utf-8');
        }
        if (restore && restoreLines.length > 0) {
            writeState({ restoreTopKeys: null });
        }
    } catch (e) {
        console.warn('[Proxy] Failed to strip proxy config:', e.message);
    }
}

function writeProxyConfig(modelId) {
    try {
        let content = '';
        if (fs.existsSync(CONFIG_PATH)) {
            content = fs.readFileSync(CONFIG_PATH, 'utf-8');
        }
        // 这里刻意**不再**登记原值：登记只能在"我们动这个文件之前"做一次，
        // stripProxyConfig 已经做过。启动流程是 strip 在前、writeProxyConfig 在后，
        // 此时文件里的顶层键正是被我们上一步删掉的，再登记一次只会看到"没有标志
        // 行、也抄不到键"，反过来把上一步刚登记的原值判成过期清掉（实测 5 个用例
        // 里 3 个因此还原失败）。
        // 先移除旧的代理配置，但保留用户自定义的其它 provider 段（如 custom）
        content = removeProxyConfig(content).trim();

        // 顶层键必须写在任何 [section] header 之前，否则 TOML 作用域会出错
        // （写在末尾会被并入最后一个 section，Codex 会读不到）。
        let topKeys = 'model_provider = "nvidia-proxy"\n' +
            'model = "' + modelId + '"\n' +
            'model_catalog_json = "model-catalog.json"\n';
        // 显式告知 Codex 该模型的上下文窗口与自动压缩阈值。没有这两项时，
        // Codex 桌面版对自定义 provider 不会触发自动压缩，会话上下文会一直
        // 膨胀到几百 MB 才被代理的 413 拦下（实测教训）。阈值取窗口的 70%：
        // 给压缩摘要的生成本身留出空间（官方模板的 1M 窗口也是配 900K 阈值）。
        const contextWindow = contextWindowFor(modelId);
        topKeys += 'model_context_window = ' + contextWindow + '\n';
        topKeys += 'model_auto_compact_token_limit = ' + Math.floor(contextWindow * AUTO_COMPACT_RATIO) + '\n';
        const isThinking = isThinkingModel(modelId);
        if (isThinking) {
            topKeys += 'model_reasoning_effort = "high"\n';
        }
        // Any NIM model may stream `reasoning_content`, and Codex only renders
        // reasoning summaries when the model is declared to support them — so the
        // summary switches are written for every model. Same set DeepSeek's
        // official Codex integration writes for its third-party models.
        // `hide_agent_reasoning = false` is set explicitly: the desktop UI hides
        // reasoning outright when it is on, and its default differs per client.
        topKeys += 'model_reasoning_summary = "detailed"\nmodel_supports_reasoning_summaries = true\nshow_raw_agent_reasoning = true\nhide_agent_reasoning = false\n';

        const providerSection = '[model_providers.nvidia-proxy]\n' +
            'name = "NVIDIA NIM Proxy"\n' +
            'base_url = "http://127.0.0.1:15721/v1"\n' +
            'wire_api = "responses"\n';

        // 段写在文件末尾，不紧跟顶层键：若写在前头，用户原本位于顶层的其它键
        // （实测 cc-switch 写的 disable_response_storage = true）会被挤到我们那段
        // header 之后、变成"我们段内的键"，退出时按段整段删除就把用户的键永久
        // 吃掉了。段放末尾则用户的顶层键仍留在任何 header 之前，TOML 语义不变
        // （section 之间顺序无关），也不会被当成我们的键删掉。
        // 顶层键与用户第一行之间不插空行：退出时我们把顶层键整行删掉，若中间有
        // 空行它会被留下，还原出来的文件就比原文件多一行空行（实测 diff 噪音）。
        content = topKeys + content + '\n' + providerSection;

        fs.writeFileSync(CONFIG_PATH, content, 'utf-8');
    } catch (e) {
        console.warn('[Proxy] Failed to write proxy config:', e.message);
    }
}

function writeModelCatalog(models) {
    try {
        // Codex model catalog schema — keep the field set minimal to avoid
        // pulling in nested required fields such as
        // `auto_compact_fallback_prompt`.
        //
        // `tool_mode` must be "direct" for a third-party OpenAI-compatible
        // provider (NVIDIA NIM). `code_mode_only` makes Codex collapse the whole
        // tool surface into a single `exec` freeform tool that is executed by the
        // `codex-code-mode-host` companion binary and is only understood by
        // OpenAI's native code-mode models. Non-native models given
        // `code_mode_only` receive no usable tool schemas, so they answer with
        // text and never emit a function call.
        //
        // `shell_type` only has two effective states: `unified_exec` and
        // `disabled` (`default`/`local`/`shell_command` are deserialization
        // aliases of `unified_exec`), so it is not the trigger for tools being
        // dropped; `tool_mode` is.
        let list = (models && models.length > 0) ? models : (MODELS.length > 0 ? MODELS : BUILTIN_MODELS);
        // Drop blacklisted models (e.g. returned 404 / unavailable for this
        // account) so the desktop picker and CLI `/model` don't keep offering them.
        list = list.filter(m => m && !isBlacklisted(m.id));
        // Ensure the currently-selected model is present, otherwise Codex won't
        // find a matching slug and silently drops tools.
        if (currentModel && !isBlacklisted(currentModel) && !list.some(x => x.id === currentModel)) {
            list = [{ id: currentModel, name: currentModel, desc: '' }].concat(list);
        }
        const data = list.map(m => {
            const isThinking = isThinkingModel(m.id);
            const isVision = isVisionModel(m.id);
            const contextWindow = contextWindowFor(m.id);
            return {
                slug: m.id,
                display_name: m.name,
                description: m.desc || m.name,
                default_reasoning_level: isThinking ? 'high' : 'low',
                supported_reasoning_levels: isThinking
                    ? [
                        { effort: 'low', description: 'Fast responses with lighter reasoning' },
                        { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
                        { effort: 'high', description: 'Greater reasoning depth for complex problems' }
                    ]
                    : [
                        { effort: 'low', description: 'Fast responses with lighter reasoning' },
                        { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
                        { effort: 'high', description: 'Greater reasoning depth for complex problems' }
                    ],
                shell_type: 'unified_exec',
                tool_mode: 'direct',
                visibility: 'list',
                supported_in_api: true,
                priority: 0,
                base_instructions: '',
                supports_reasoning_summaries: true,
                reasoning_summary_format: 'experimental',
                default_reasoning_summary: 'none',
                support_verbosity: false,
                apply_patch_tool_type: 'freeform',
                truncation_policy: { mode: 'bytes', limit: 10000 },
                context_window: contextWindow,
                max_context_window: contextWindow,
                effective_context_window_percent: 95,
                supports_parallel_tool_calls: true,
                experimental_supported_tools: [],
                input_modalities: isVision ? ['text', 'image'] : ['text'],
                supports_image_detail_original: isVision
            };
        });
        fs.writeFileSync(MODEL_CATALOG_PATH, JSON.stringify({ models: data }, null, 2), 'utf-8');
        console.log('[Proxy] Model catalog written:', data.length, 'models');
    } catch (e) {
        console.warn('[Proxy] Failed to write model catalog:', e.message);
    }
}

process.on('SIGINT', () => {
    stripProxyConfig(true);
    process.exit(0);
});
process.on('SIGTERM', () => {
    stripProxyConfig(true);
    process.exit(0);
});

if (!NVIDIA_API_KEY) {
    console.error('[Proxy] ERROR: NVIDIA_API_KEY environment variable is required.');
    console.error('[Proxy] Copy .env.example to .env and set your NVIDIA NIM API key.');
    process.exit(1);
}

function loadModelsFromFile() {
    try {
        if (fs.existsSync(MODEL_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(MODEL_LIST_PATH, 'utf-8'));
        }
    } catch (e) {
        console.warn('[Proxy] Failed to load models.json, using built-in fallback:', e.message);
    }
    return [];
}

// A model that returns 404 is not necessarily gone for good: NIM lists models it
// will not serve for a given account, and availability can change. Remember the
// rejection for a bounded window instead of banning the model forever, so a
// temporarily unavailable model becomes selectable again on its own.
const BLACKLIST_TTL_MS = 24 * 60 * 60 * 1000;

function loadBlacklist() {
    const entries = new Map();
    try {
        if (fs.existsSync(MODEL_BLACKLIST_PATH)) {
            const raw = JSON.parse(fs.readFileSync(MODEL_BLACKLIST_PATH, 'utf-8'));
            const now = Date.now();
            if (Array.isArray(raw)) {
                // Legacy format: a plain list with no timestamps. Keep each entry
                // for one more TTL window instead of dropping it outright.
                for (const id of raw) {
                    if (typeof id === 'string') entries.set(id, now + BLACKLIST_TTL_MS);
                }
            } else if (raw && typeof raw === 'object') {
                for (const [id, expiresAt] of Object.entries(raw)) {
                    if (typeof expiresAt === 'number' && expiresAt > now) entries.set(id, expiresAt);
                }
            }
        }
    } catch (e) {
        console.warn('[Proxy] Failed to load blacklist:', e.message);
    }
    return entries;
}

function saveBlacklist(blacklist) {
    try {
        fs.writeFileSync(MODEL_BLACKLIST_PATH, JSON.stringify(Object.fromEntries(blacklist), null, 2) + '\n', 'utf-8');
    } catch (e) {
        console.warn('[Proxy] Failed to save blacklist:', e.message);
    }
}

// Expiry is checked on read, so a model whose window has passed becomes usable
// again without restarting the proxy.
function isBlacklisted(modelId) {
    const expiresAt = BLACKLISTED_MODELS.get(modelId);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
        BLACKLISTED_MODELS.delete(modelId);
        saveBlacklist(BLACKLISTED_MODELS);
        console.warn('[Proxy] Blacklist expired, model available again:', modelId);
        return false;
    }
    return true;
}

function blacklistModel(modelId) {
    if (!isBlacklisted(modelId)) {
        BLACKLISTED_MODELS.set(modelId, Date.now() + BLACKLIST_TTL_MS);
        saveBlacklist(BLACKLISTED_MODELS);
        console.warn('[Proxy] Blacklisted model for 24h:', modelId);
        // Rewrite the catalog so the desktop picker / CLI `/model` stop
        // offering the blacklisted model immediately (they read the catalog
        // file on disk, not the in-memory list).
        writeModelCatalog();
    }
}

let BLACKLISTED_MODELS = loadBlacklist();

// 兜底模型列表：只在拉不到实时列表时使用（models.json 缺失/损坏，或启动拉取失败）。
// 必须与 models.json 保持完全一致——两边是同一份数据的手工副本，改一处就要改另一处。
// 内容对齐 README「支持的模型」表里 2026-10 实测在售的代表性模型。
const BUILTIN_MODELS = [
    { id: 'deepseek-ai/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', desc: 'Fast responses for everyday coding and quick fixes', tags: ['coding', 'fast', 'agent'] },
    { id: 'moonshotai/kimi-k3', name: 'Kimi K3', desc: 'Large-repo reading and long-context tasks', tags: ['coding', 'reasoning'] },
    { id: 'z-ai/glm-5.3', name: 'GLM-5.3', desc: 'Chinese-friendly reasoning and agentic workflows', tags: ['coding', 'agent', 'reasoning'] },
    { id: 'z-ai/glm-5.3-flash', name: 'GLM-5.3 Flash', desc: 'Lightweight Chinese-friendly model, fast responses', tags: ['fast', 'agent', 'reasoning'] },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b', name: 'Nemotron 3 Ultra 550B', desc: 'NVIDIA flagship for complex reasoning', tags: ['reasoning', 'agent'] },
    { id: 'nvidia/nemotron-3-super-120b-a12b', name: 'Nemotron 3 Super 120B', desc: 'Balanced general purpose, stable tool calling', tags: ['agent', 'reasoning', 'tool-calling'] },
    { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', name: 'Nemotron 3.5 Lightning 30B', desc: 'Light and fast, enough for simple tasks', tags: ['fast', 'general'] },
    { id: 'google/gemma-4-31b-it', name: 'Gemma 4 31B', desc: 'Google general-purpose model', tags: ['general', 'coding'] },
    { id: 'mistralai/mistral-large-2-instruct', name: 'Mistral Large 2', desc: 'Mistral flagship, strong coding & tool calling', tags: ['coding', 'agent', 'tool-calling'] },
    { id: 'openai/gpt-oss-20b', name: 'gpt-oss 20B', desc: 'OpenAI open-weight model', tags: ['general', 'reasoning'] },
    { id: 'meta/llama-3.2-90b-vision-instruct', name: 'Llama 3.2 90B Vision', desc: 'Vision-capable, can read screenshots', tags: ['vision', 'general'] }
];

let MODELS = loadModelsFromFile();
if (MODELS.length === 0) {
    MODELS = BUILTIN_MODELS;
    console.warn('[Proxy] No models found in models.json, using built-in fallback list.');
}

function log(...args) {
    if (DEBUG) {
        const ts = new Date().toISOString();
        console.log('[Proxy ' + ts + ']', ...args);
    }
}

// 存亡兜底：代理以裸进程方式跑在用户终端里，"它怎么没的"必须能查。
// proxy-crash.log 记录进程一生中的全部存亡事件——启动 START、收到信号 SIGNAL、
// 退出 EXIT（带退出码与存活时长），以及 uncaughtException / unhandledRejection
// 的完整堆栈。appendFileSync 是同步写，进程即将消失的那一刻也能落盘。
// 判读方式：有 START 无 EXIT = 被硬杀（关终端窗口 / SIGKILL）；
// 有 SIGNAL = Ctrl+C 之类；只有 EXIT code=0 = 正常收尾。
// （Node 15+ 对未处理的 rejection 默认就是崩溃，这里保持等价行为，只是留档。）
const CRASH_LOG_PATH = require('path').join(__dirname, 'proxy-crash.log');
const PROCESS_STARTED_AT = Date.now();
function appendCrashLog(line) {
    try {
        const fs = require('fs');
        // 正常启停也会写日志，加个尺寸上限，避免长期反复重启把文件撑成巨型。
        try { if (fs.statSync(CRASH_LOG_PATH).size > 256 * 1024) fs.unlinkSync(CRASH_LOG_PATH); } catch (e) {}
        fs.appendFileSync(CRASH_LOG_PATH, line);
    } catch (e) {}
}
function recordCrash(kind, err) {
    const detail = (err && (err.stack || err.message)) || String(err);
    appendCrashLog('[' + new Date().toISOString() + '] ' + kind + ' pid=' + process.pid + ':\n' + detail + '\n\n');
    console.error('[Proxy] FATAL ' + kind + ' (also written to proxy-crash.log):\n' + detail);
}
process.on('uncaughtException', (err) => { recordCrash('uncaughtException', err); process.exit(1); });
process.on('unhandledRejection', (reason) => { recordCrash('unhandledRejection', reason); process.exit(1); });
appendCrashLog('[' + new Date().toISOString() + '] START pid=' + process.pid + ' node=' + process.version + '\n');
process.on('SIGINT', () => { appendCrashLog('[' + new Date().toISOString() + '] SIGNAL SIGINT pid=' + process.pid + ' (Ctrl+C)\n'); process.exit(130); });
process.on('SIGTERM', () => { appendCrashLog('[' + new Date().toISOString() + '] SIGNAL SIGTERM pid=' + process.pid + '\n'); process.exit(143); });
// 退出码/时长与 START 配对即可还原进程一生（崩溃路径也会走到这里，因为崩溃处理里同样 process.exit）。
process.on('exit', (code) => { appendCrashLog('[' + new Date().toISOString() + '] EXIT code=' + code + ' pid=' + process.pid + ' uptime=' + Math.round((Date.now() - PROCESS_STARTED_AT) / 1000) + 's\n'); });

let currentModel = getCurrentModelFromFile();

// 启动时不还原原值（restore=false），只登记 + 清理；原值的还原统一由退出路径负责。
stripProxyConfig(false);

// Write the proxy config synchronously right after stripping so config.toml
// is never left provider-less (a concurrently starting Codex could otherwise
// read an empty config during the async fetch window below).
if (!currentModel && MODELS.length > 0) {
    currentModel = MODELS[0].id;
}
if (currentModel) {
    writeProxyConfig(currentModel);
}

// Refresh the model list from NIM on every startup so the catalog that feeds
// both the desktop picker and the CLI `/model` command stays current
// (models.json is only a stale fallback). A stale saved model is corrected
// here; a failed fetch never clobbers the saved choice.
function applyStartupModels(models, live) {
    if (Array.isArray(models) && models.length > 0) {
        MODELS = models;
    }
    if (live && (!currentModel || !MODELS.some(m => m.id === currentModel))) {
        // Saved model is no longer offered by NIM; default to the first live
        // chat model instead of leaving a dead slug in config.toml.
        currentModel = MODELS.length > 0 ? MODELS[0].id : null;
        if (currentModel) {
            writeState({ model: currentModel });
            writeProxyConfig(currentModel);
        }
    }
    writeModelCatalog();
}

fetchNvidiaModels()
    .then(models => applyStartupModels(models, true))
    .catch(e => {
        console.warn('[Proxy] Failed to fetch models on startup:', e.message);
        writeModelCatalog();
    });

function getCurrentModelFromFile() {
    try {
        const state = readState();
        if (state.model && typeof state.model === 'string') {
            return state.model;
        }
    } catch (e) {}
    try {
        const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
        const match = content.match(/^model\s*=\s*"([^"]+)"/m);
        return match ? match[1] : null;
    } catch (e) {
        return null;
    }
}

function generateTags(modelId, ownedBy) {
    const lower = modelId.toLowerCase();
    const tags = [];
    const add = (tag) => { if (!tags.includes(tag)) tags.push(tag); };

    if (/thinking|reasoning|r1-|deepseek-r1/.test(lower)) {
        add('thinking');
    }
    if (/coder|coding|code(mistral|stral|gemma|llama)|starcoder/.test(lower)) {
        add('coding');
    }
    if (/instruct|agent|-it\b/.test(lower)) {
        add('agent');
    }
    if (/flash|mini|small|nano|tiny/.test(lower) || /(?:^|[^0-9])([12378])b(?:$|[^0-9a-z])/.test(lower)) {
        add('fast');
    }
    if (isVisionModel(lower)) {
        add('vision');
    }
    if (/moe|a\d+b|mixtral/.test(lower)) {
        add('MoE');
    }
    if (/embed|retriev|bge|embedqa|nv-embed/.test(lower)) {
        add('embed');
    }
    if (/guard|safety|shield|pii|content-safety/.test(lower)) {
        add('guard');
    }
    if (/nemotron|llama-4|deepseek-v4|kimi-k2|glm-?5|qwen3\.5|qwen3-next|qwen3-coder|mistral-medium|mistral-large|gemma-[34]|minimax-m2/.test(lower)) {
        add('coding');
    }
    if (/nemotron|llama-4|deepseek-v4|kimi-k2|glm-?5|qwen3\.5|qwen3-next|qwen3-coder|mistral-medium|mistral-large|gemma-[34]|yi-large|gpt-oss|palmyra|sarvam|llama-?2|llama-?3[^.]|mixtral|dbrx|jamba|command-r|seed-oss|colosseum|italia|marin|breeze|swallow|baichuan|sea-lion|dracarys|minimax-m2/.test(lower)) {
        add('general');
    }

    return tags;
}

const PROVIDER_PRIORITY = {
    'deepseek-ai': 1, 'qwen': 2, 'moonshotai': 3, 'z-ai': 4,
    'minimaxai': 5, 'meta': 6, 'mistralai': 7, 'nvidia': 8,
    'microsoft': 9, 'google': 10, 'anthropic': 11, 'openai': 12,
    'stepfun-ai': 13, 'bytedance': 14, '01-ai': 15, 'ibm': 16,
    'writer': 17, 'snowflake': 18, 'sarvamai': 19
};

function modelSortKey(model) {
    const provider = model.id.split('/')[0];
    const priority = PROVIDER_PRIORITY[provider] || 99;
    return priority;
}

// `integrate.api.nvidia.com` exposes no modality metadata: `/v1/models`,
// `/v1/models?verbose=true` and `/v1/models/{id}` all return only
// id/object/created/owned_by. Capability therefore has to be inferred from the
// model id — glm-5.3 is listed here because NIM accepts image content for
// `z-ai/glm-5.3-flash` (checked: an image-bearing chat/completions request
// returns 200 with content, not an error). This single predicate drives both the
// catalog's `input_modalities` (which gates the desktop "attach image" button)
// and image handling in outgoing requests — they must agree, otherwise the client
// accepts an image the proxy then silently strips.
const VISION_MODEL_RE = /vision|vl\b|multimodal|omni|glm-5\.3|image|video|ocr|deplot|kosmos|neva|nvclip|vila|fuyu|paligemma/;

function isVisionModel(modelId) {
    if (!modelId) return false;
    return VISION_MODEL_RE.test(String(modelId).toLowerCase());
}

// `/v1/models` lists every model the key can access — embeddings, rerankers,
// guardrails, parsers, translators, and other non-chat models can't be used
// through the Chat Completions API that Codex talks to. The response has no
// `type` field, so we drop them with an id-keyword heuristic.
function isChatModel(id, ownedBy) {
    const lower = (id || '').toLowerCase();
    return !/embed|retriev|rerank|guard|safety|shield|pii|nemoguard|content-safety|parse|translate|tts|asr|ocr|detector|calibration|reward|cosmos|muse-glimmer|diffusiongemma|synthetic-video|ising|chatqa|nvclip|neva|deplot|kosmos|fuyu|paligemma|vila/.test(lower);
}

function fetchNvidiaModels() {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: NVIDIA_HOST,
            port: 443,
            path: '/v1/models',
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + NVIDIA_API_KEY,
            },
            timeout: 15000
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    const seen = new Set();
                    const models = (parsed.data || [])
                        .filter(m => {
                            if (seen.has(m.id)) return false;
                            seen.add(m.id);
                            return true;
                        })
                        .filter(m => isChatModel(m.id, m.owned_by))
                        .map(m => ({
                            id: m.id,
                            name: m.id.split('/').pop(),
                            desc: m.owned_by || '',
                            tags: generateTags(m.id, m.owned_by)
                        })).sort((a, b) => modelSortKey(a) - modelSortKey(b));
                    log('Fetched', models.length, 'models from NVIDIA NIM');
                    resolve(models);
                } catch (e) {
                    reject(new Error('Parse error: ' + e.message));
                }
            });
        });

        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.on('error', e => reject(e));
        req.end();
    });
}

// Codex sends rich content as an array of parts using its own type names
// (`input_text` / `input_image` / `output_image`), while Chat Completions wants
// `text` / `image_url`. Forwarding the Codex names verbatim makes NIM reject the
// whole request — "data did not match any variant of untagged enum
// ChatCompletionRequestToolMessageContent" — which is what happened to
// `view_image` results that came back as `function_call_output` with an
// `input_image` part.
function normalizeContentParts(content) {
    const textParts = [];
    const imageParts = [];
    for (const c of content) {
        if (c.type === 'input_text' || c.type === 'output_text') {
            textParts.push(c.text);
        } else if (c.type === 'input_image' || c.type === 'output_image') {
            const imgUrl = c.image_url || (c.source && c.source.url) || '';
            if (imgUrl) {
                imageParts.push({ type: 'image_url', image_url: { url: imgUrl } });
            }
        }
    }
    if (imageParts.length === 0) {
        return textParts.join('');
    }
    const parts = [];
    if (textParts.length > 0) {
        parts.push({ type: 'text', text: textParts.join('') });
    }
    parts.push(...imageParts);
    return parts;
}

// Codex's freeform tool channel — `apply_patch`, the only `custom` tool in the
// surface — surfaces as `custom_tool_call` / `custom_tool_call_output` instead
// of the `function_call` pair, so history replay used to lose the whole
// exchange. (MCP tools are ordinary `function` tools nested in a `namespace`,
// so they replay as `function_call`.) NIM accepts
// `tool_calls` entries that reference tools it was never offered, so no
// declaration is needed. Chat Completions wants `arguments` to be a JSON string,
// but a custom call carries the raw payload the model produced — anything that
// isn't already JSON gets wrapped instead of passed through raw.
function toToolArguments(input) {
    if (typeof input !== 'string') {
        return JSON.stringify(input == null ? {} : input);
    }
    try {
        JSON.parse(input);
        return input;
    } catch (e) {
        return JSON.stringify({ input });
    }
}

// Debug aid. Codex keeps growing tool types this proxy doesn't know about
// (`custom`, `namespace`, ...) and each new one silently disappears from the
// request, so the real shape can only be learned from the client itself. Dump
// the raw tool surface whenever it changes so it can be inspected directly
// instead of guessed at (and instead of copying it out of a terminal by hand).
// DEBUG-gated: it is a debugging aid, not something to leave behind in the
// project directory on every run.
const TOOL_DUMP_PATH = path.join(__dirname, 'tool_dump.json');
let lastToolDump = '';
function dumpToolSurface(tools) {
    if (!DEBUG) return;
    try {
        const json = JSON.stringify(tools, null, 2);
        if (json === lastToolDump) return;
        lastToolDump = json;
        fs.writeFileSync(TOOL_DUMP_PATH, json + '\n', 'utf-8');
    } catch (e) {
        console.warn('[Proxy] Failed to write tool dump:', e.message);
    }
}

// Chat Completions only understands flat `function` tools, while Codex groups
// related tools under a `namespace`: every tool of one MCP server lands under
// `mcp__<server>`, and the sub-agent tools under `multi_agent_v1`. Lift each
// sub-tool to the top level and qualify its name with the namespace so it stays
// unique — `mcp__hello` + `say_hello` becomes `mcp__hello__say_hello`, which is
// exactly Codex's own `mcp__<server>__<tool>` naming.
function toChatTool(t) {
    if (!t || typeof t !== 'object') return null;
    if (t.type === 'function') {
        const { type, ...rest } = t;
        return { type: 'function', function: { ...(t.function || rest) } };
    }
    if (t.type === 'web_search_preview' || t.type === 'web_search') {
        return {
            type: 'function',
            function: {
                name: 'web_search',
                description: 'Search the web for public internet information. Prefer this over shell, curl, wget, Invoke-WebRequest, Python requests, or browser scraping when answering weather, news, prices, sports, travel, or other real-time web questions.',
                parameters: {
                    type: 'object',
                    properties: {
                        searchTerm: { type: 'string', description: 'The search query' }
                    },
                    required: ['searchTerm']
                }
            }
        };
    }
    // `custom` tools (`apply_patch`) are freeform: Codex has no JSON schema for
    // them, and its router only accepts the call back as a `custom_tool_call`
    // carrying the raw text in `input`. Chat Completions needs a schema, so the
    // freeform body rides in a single `input` string field and is unwrapped
    // again by toResponseCallItem.
    if (t.type === 'custom' && typeof t.name === 'string') {
        FREEFORM_TOOLS.add(t.name);
        return {
            type: 'function',
            function: {
                name: t.name,
                description: (t.description ? t.description + ' ' : '')
                    + 'The tool input is freeform text, not structured JSON: pass it verbatim as the `input` string field.',
                parameters: {
                    type: 'object',
                    properties: {
                        input: { type: 'string', description: 'The raw freeform input for this tool.' }
                    },
                    required: ['input'],
                    additionalProperties: false
                }
            }
        };
    }
    return null;
}

// Codex resolves a tool call through the `(namespace, name)` pair its router
// builds (`ToolName::new(namespace, name)`), and a tool grouped under a
// `namespace` only matches when that namespace comes back with it. Chat
// Completions has no such field, so remember how each flattened name maps back
// and split it apart again on the way out.
const NAMESPACED_TOOLS = new Map();
// Custom (freeform) tool names, e.g. `apply_patch`.
const FREEFORM_TOOLS = new Set();
function toolNameFields(flatName) {
    const original = NAMESPACED_TOOLS.get(flatName);
    return original
        ? { name: original.name, namespace: original.namespace }
        : { name: flatName };
}

// The model answers a freeform tool with `{"input": "<raw text>"}`; Codex wants
// the bare text back in `input`.
function freeformInput(argumentsText) {
    if (!argumentsText) return '';
    try {
        const parsed = JSON.parse(argumentsText);
        if (parsed && typeof parsed.input === 'string') return parsed.input;
    } catch (e) { /* not JSON — hand the raw text straight through */ }
    return argumentsText;
}

function toResponseCallItem(id, name, callId, argumentsText, status) {
    if (FREEFORM_TOOLS.has(name)) {
        return {
            id,
            type: 'custom_tool_call',
            call_id: callId,
            name,
            input: freeformInput(argumentsText),
            status
        };
    }
    return {
        id,
        type: 'function_call',
        ...toolNameFields(name),
        call_id: callId,
        arguments: argumentsText,
        status
    };
}

function expandToolList(tools) {
    const expanded = [];
    const drop = (t) => {
        log('Warning: dropped unsupported tool type:', t && t.type);
        log('DROPPED TOOL FULL:', JSON.stringify(t).substring(0, 4000));
    };
    for (const t of tools) {
        if (t && t.type === 'namespace' && Array.isArray(t.tools)) {
            for (const sub of t.tools) {
                const converted = toChatTool(sub);
                if (!converted) {
                    drop(sub);
                    continue;
                }
                if (sub.type === 'function') {
                    const flat = t.name + '__' + converted.function.name;
                    NAMESPACED_TOOLS.set(flat, { namespace: t.name, name: converted.function.name });
                    converted.function.name = flat;
                }
                expanded.push(converted);
            }
            continue;
        }
        const converted = toChatTool(t);
        if (!converted) {
            drop(t);
            continue;
        }
        expanded.push(converted);
    }
    return expanded;
}

function convertRequest(responsesBody) {
    const chatBody = { ...responsesBody };
    if (DEBUG) {
        log('RAW request keys:', Object.keys(responsesBody).join(','));
        log('RAW tools:', responsesBody.tools ? JSON.stringify(responsesBody.tools).substring(0, 800) : 'none');
    }
    const hasWebSearchTool = Array.isArray(chatBody.tools) && chatBody.tools.some(
        t => t && (t.type === 'web_search' || t.type === 'web_search_preview')
    );

    if (chatBody.input && Array.isArray(chatBody.input)) {
        const messages = [];
        for (const item of chatBody.input) {
            if (item.type === 'function_call' || item.type === 'custom_tool_call') {
                messages.push({
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: item.call_id || item.id || '',
                        type: 'function',
                        function: {
                            // Codex hands a namespaced call back as `namespace`
                            // plus a bare `name`, but NIM only ever saw the
                            // flattened form that expandToolList declared.
                            name: item.namespace && item.name
                                ? item.namespace + '__' + item.name
                                : (item.name || ''),
                            // `function_call` carries a JSON argument string, while
                            // `custom_tool_call` carries the freeform payload the
                            // model produced (e.g. a raw patch).
                            arguments: item.type === 'function_call'
                                ? (item.arguments || '{}')
                                : toToolArguments(item.input)
                        }
                    }]
                });
                continue;
            }
            if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
                let output = item.output;
                if (Array.isArray(output)) {
                    output = normalizeContentParts(output);
                } else if (output && typeof output === 'object') {
                    output = JSON.stringify(output);
                }
                messages.push({
                    role: 'tool',
                    tool_call_id: item.call_id,
                    content: output || ''
                });
                continue;
            }
            if (item.type === 'web_search_call' && item.results) {
                const results = item.results.map((r, i) =>
                    `[${i + 1}] ${r.title || ''}\n${r.url || ''}\n${(r.text || r.snippet || '').substring(0, 500)}`
                ).join('\n\n');
                messages.push({
                    role: 'system',
                    content: 'Web search results:\n\n' + results
                });
                continue;
            }
            // Codex sends its skills and instruction blocks as `developer`
            // messages. NIM only knows `system`, which carries the same
            // authority, so the role is mapped across instead of the whole
            // message being dropped.
            const role = item.role === 'developer' ? 'system' : item.role;
            if (role === 'system' || role === 'user' || role === 'assistant') {
                const msg = { role };
                if (typeof item.content === 'string') {
                    msg.content = item.content;
                } else if (Array.isArray(item.content)) {
                    msg.content = normalizeContentParts(item.content);
                }
                if (item.tool_calls) {
                    msg.tool_calls = item.tool_calls;
                }
                if (item.tool_call_id) {
                    msg.tool_call_id = item.tool_call_id;
                }
                messages.push(msg);
                continue;
            }
            // Anything reaching here used to fall through silently, which is how
            // protocol drift stayed invisible: images started arriving inside
            // `function_call_output` and the proxy quietly forwarded them in a
            // shape NIM rejects. `reasoning` items are intentionally not replayed
            // (NIM regenerates its own), everything else is worth a warning.
            if (item.type !== 'reasoning') {
                const kind = item.type || (item.role ? 'role:' + item.role : 'unknown');
                console.warn('[Proxy] Ignoring unsupported input item [' + kind + ']: ' + JSON.stringify(item).substring(0, 400));
            }
        }
        chatBody.messages = messages;
        delete chatBody.input;
    }

    if (chatBody.messages) {
        for (const msg of chatBody.messages) {
            if (msg.tool_calls && msg.tool_calls.length === 0) {
                delete msg.tool_calls;
            }
        }
    }

    if (chatBody.instructions && (!chatBody.messages || !chatBody.messages.some(m => m.role === 'system'))) {
        if (!chatBody.messages) chatBody.messages = [];
        chatBody.messages.unshift({ role: 'system', content: chatBody.instructions });
    }
    delete chatBody.instructions;

    if (hasWebSearchTool) {
        if (!chatBody.messages) chatBody.messages = [];
        chatBody.messages.unshift({
            role: 'system',
            content: 'When the user needs public internet information such as weather, news, prices, sports, travel, or reference pages, prefer the web_search tool. Do not use shell, curl, wget, PowerShell Invoke-WebRequest, Python requests, or other command execution tools to fetch public web content unless the user explicitly asks for a command or local script.'
        });
    }

    if (chatBody.tools && Array.isArray(chatBody.tools)) {
        dumpToolSurface(chatBody.tools);
        chatBody.tools = expandToolList(chatBody.tools);
        if (chatBody.tools && chatBody.tools.length > 0) {
            chatBody.tool_choice = 'auto';
        } else {
            delete chatBody.tool_choice;
        }
    } else {
        delete chatBody.tool_choice;
    }

    if (chatBody.max_output_tokens !== undefined) {
        chatBody.max_tokens = chatBody.max_output_tokens;
        delete chatBody.max_output_tokens;
    }

    delete chatBody.store;
    delete chatBody.metadata;
    delete chatBody.previous_response_id;
    delete chatBody.truncation;
    delete chatBody.include;
    delete chatBody.prompt;
    delete chatBody.text;
    delete chatBody.reasoning;
    delete chatBody.top_logprobs;
    delete chatBody.prompt_cache_key;
    delete chatBody.client_metadata;

    return chatBody;
}

function forwardRequest(req, bodyStr) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const options = {
            hostname: NVIDIA_HOST,
            port: 443,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + NVIDIA_API_KEY,
            },
            // 禁用连接复用，见 NVIDIA_AGENT 处的说明：复用 NIM 已关闭的 socket 会
            // 让下一次请求在 40s 后才报 ECONNRESET。
            agent: NVIDIA_AGENT,
            timeout: 300000
        };

        log('Forwarding to NVIDIA, body length:', bodyStr.length);

        const proxyReq = https.request(options, (proxyRes) => {
            // TTFB 观测：大上下文时这段是"排队 + prefill"，是请求耗时的大头
            log('NVIDIA response received, status:', proxyRes.statusCode, 'ttfb:', (Date.now() - start) + 'ms');
            resolve({ stream: true, response: proxyRes });
        });

        proxyReq.on('timeout', () => {
            proxyReq.destroy();
            reject(new Error('Upstream timeout'));
        });
        proxyReq.on('error', (e) => reject(e));
        proxyReq.write(bodyStr);
        proxyReq.end();
    });
}

function formatSearchResponse(query, results, fallbackMessage, provider) {
    const trimmedResults = (results || []).slice(0, 5);
    const formatted = trimmedResults.map((r, i) =>
        `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.text || ''}`
    ).join('\n\n');

    return {
        query,
        provider,
        results: trimmedResults,
        formatted: formatted || fallbackMessage || 'No search results found.'
    };
}

function fetchHttpsText(options) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => resolve({
                statusCode: res.statusCode || 0,
                headers: res.headers || {},
                body
            }));
        });

        req.on('timeout', () => {
            req.destroy(new Error('timeout'));
        });
        req.on('error', reject);
        req.end();
    });
}

function decodeXmlEntities(text) {
    return (text || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function stripTags(text) {
    return decodeXmlEntities((text || '').replace(/<[^>]+>/g, '')).trim();
}

async function searchBingRss(query) {
    const start = Date.now();
    const response = await fetchHttpsText({
        hostname: 'cn.bing.com',
        port: 443,
        path: '/search?format=rss&q=' + encodeURIComponent(query),
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 8000
    });

    if (response.statusCode !== 200) {
        throw new Error('bing status ' + response.statusCode);
    }

    const items = [];
    const itemRe = /<item\b[\s\S]*?<\/item>/gi;
    let itemMatch;
    while ((itemMatch = itemRe.exec(response.body)) !== null) {
        const itemXml = itemMatch[0];
        const title = stripTags((itemXml.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
        const url = decodeXmlEntities(((itemXml.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || '').trim());
        const text = stripTags((itemXml.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || '');
        if (title && url) items.push({ title, url, text });
    }

    log('SEARCH:', 'provider=bing', 'query=' + query, 'results=' + items.length, 'ms=' + (Date.now() - start));
    return formatSearchResponse(query, items, 'No search results found.', 'bing');
}

async function searchDuckDuckGoLite(query) {
    const start = Date.now();
    const response = await fetchHttpsText({
        hostname: 'lite.duckduckgo.com',
        port: 443,
        path: '/lite?q=' + encodeURIComponent(query),
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 8000
    });

    if (response.statusCode !== 200) {
        throw new Error('duckduckgo status ' + response.statusCode);
    }

    const results = [];
    const linkRe = /<a[^>]*href="([^"]+)"[^>]*class="result-link"[^>]*>([^<]+)<\/a>/gi;
    const snippetRe = /<td[^>]*class="result-snippet"[^>]*>([^<]+)<\/td>/gi;
    let m;
    while ((m = linkRe.exec(response.body)) !== null) {
        const url = m[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, '');
        const title = m[2].replace(/<[^>]+>/g, '').trim();
        results.push({ title, url: decodeURIComponent(url), text: '' });
    }
    const snippets = [];
    while ((m = snippetRe.exec(response.body)) !== null) {
        snippets.push(m[1].replace(/<[^>]+>/g, '').trim());
    }
    results.forEach((r, i) => { r.text = snippets[i] || ''; });

    log('SEARCH:', 'provider=duckduckgo', 'query=' + query, 'results=' + results.length, 'ms=' + (Date.now() - start));
    return formatSearchResponse(query, results, 'No search results found.', 'duckduckgo');
}

async function executeWebSearch(query) {
    const providers = [
        ['bing', searchBingRss],
        ['duckduckgo', searchDuckDuckGoLite]
    ];
    const errors = [];

    for (const [name, fn] of providers) {
        try {
            const result = await fn(query);
            if (result.results.length > 0) return result;
            errors.push(name + ':empty');
        } catch (e) {
            log('SEARCH:', 'provider=' + name, 'query=' + query, 'error=' + e.message);
            errors.push(name + ':' + e.message);
        }
    }

    const fallback = errors.some(err => /timeout/i.test(err))
        ? 'Search timed out.'
        : 'Search failed: ' + errors.join('; ');

    return formatSearchResponse(query, [], fallback, 'fallback');
}

function readIncomingMessage(incoming) {
    return new Promise((resolve, reject) => {
        let data = '';
        incoming.on('data', chunk => data += chunk);
        incoming.on('end', () => resolve(data));
        incoming.on('error', reject);
    });
}

// DeepSeek models sometimes leak their internal tool-call markup into the text
// channel when the serving layer fails to strip its own special tokens. It then
// reaches Codex as an ordinary assistant message ("<...> calls") with no tool
// call attached, which is meaningless to the user. The delimiters are U+FF5C
// (fullwidth vertical line); they are written as escapes because the literal
// sequence is itself unstable in some pipelines.
const PRIVATE_MARKUP = new RegExp('<\uFF5C[^\\n]{0,200}>', 'g');
function stripPrivateMarkup(text) {
    if (!text || typeof text !== 'string') return text;
    const cleaned = text.replace(PRIVATE_MARKUP, '');
    if (cleaned !== text) {
        console.warn('[Proxy] Stripped model-internal markup that leaked into the text channel');
    }
    return cleaned;
}

// 流式净化专用：判断 text 末尾是否是"可能还没收齐的内部标记开头"。
// NIM 会把标记分片下发（例如把 `<\uFF5CDSML\uFF5C calls>` 拆成 `\n\n<｜DSML｜`
// 和 ` calls>\n`），逐 delta 做正则替换时两片都不完整、谁都匹配不上，标记就漏进
// 正文（用户会看到一行 `<tool calls>`）。返回应当扣住（暂不发送）的起始下标：
// 若尾部是孤立的 `<`（分片边界可能正好切在 `<\uFF5C` 之间），或是 `<\uFF5C` 开头
// 的片段，就从那里扣住；否则整段都可以安全发出（返回 text.length）。
function privateMarkupHoldStart(text) {
    const lt = text.lastIndexOf('<');
    if (lt === -1) return text.length;
    const tail = text.slice(lt);
    if (tail === '<' || tail.startsWith('<\uFF5C')) return lt;
    return text.length;
}

function extractTextContent(content) {
    if (typeof content === 'string') return stripPrivateMarkup(content);
    if (Array.isArray(content)) {
        return stripPrivateMarkup(content
            .filter(part => part && (part.type === 'text' || part.type === 'output_text' || part.type === 'input_text'))
            .map(part => part.text || '')
            .join(''));
    }
    return '';
}

function extractReasoningText(message) {
    return stripPrivateMarkup(message.reasoning || message.reasoning_content || '');
}

function normalizeToolCalls(toolCalls) {
    return (toolCalls || []).map((tc, index) => ({
        index: tc.index !== undefined ? tc.index : index,
        id: tc.id || '',
        name: (tc.function && tc.function.name) || '',
        arguments: (tc.function && tc.function.arguments) || ''
    }));
}

// Codex reads token counts from the Responses `usage` object, while NIM reports
// them in Chat-Completions shape (prompt/completion plus nested details). Keep a
// running total and translate it at the end so the numbers — including the
// cached and reasoning sub-counts the CLI shows — match a native session.
function emptyUsageTotals() {
    return { input_tokens: 0, output_tokens: 0, total_tokens: 0, cached_tokens: 0, reasoning_tokens: 0 };
}

function addUsageTotals(totals, usage) {
    if (!usage) return;
    totals.input_tokens += usage.prompt_tokens || 0;
    totals.output_tokens += usage.completion_tokens || 0;
    totals.total_tokens += usage.total_tokens || 0;
    totals.cached_tokens += (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
    totals.reasoning_tokens += (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) || 0;
}

function usageFromTotals(totals) {
    if (!totals || totals.total_tokens <= 0) return undefined;
    const usage = {
        input_tokens: totals.input_tokens,
        output_tokens: totals.output_tokens,
        total_tokens: totals.total_tokens
    };
    if (totals.cached_tokens > 0) {
        usage.input_tokens_details = { cached_tokens: totals.cached_tokens };
    }
    if (totals.reasoning_tokens > 0) {
        usage.output_tokens_details = { reasoning_tokens: totals.reasoning_tokens };
    }
    return usage;
}

function nimUsageToResponse(usage) {
    if (!usage) return undefined;
    const totals = emptyUsageTotals();
    addUsageTotals(totals, usage);
    return usageFromTotals(totals);
}

function cloneToolCallForMessage(tc) {
    return {
        id: tc.id || '',
        type: 'function',
        function: {
            name: (tc.function && tc.function.name) || '',
            arguments: (tc.function && tc.function.arguments) || ''
        }
    };
}

function buildResponseObjectFromState(state) {
    const output = [];
    const responseId = state.responseId || 'resp_proxy';
    const combinedReasoning = state.reasoningParts.filter(Boolean).join('\n\n').trim();

    if (combinedReasoning) {
        // 双通道 hedge：Codex 官方内核的事件名表（codex-api/src/sse/responses.rs）
        // 只认识 response.reasoning_summary_text.* 与 response.reasoning_summary_part.*，
        // 整份二进制里根本不存在 response.reasoning_text；UI 侧读的也是推理条目的
        // summary 数组，所以只有 summary 会被真正渲染出来。因此同一个 reasoning 条目
        // 同时带 summary（给 Codex 桌面端看）和 content（给会读原始思维链的客户端看），
        // 换客户端也不用再改格式。
        output.push({
            type: 'reasoning',
            id: responseId + '_think',
            summary: [{ type: 'summary_text', text: combinedReasoning }],
            content: [{ type: 'reasoning_text', text: combinedReasoning }]
        });
    }

    for (const searchEvent of state.searchEvents) {
        output.push({
            id: searchEvent.id,
            type: 'web_search_call',
            status: 'completed',
            action: { type: 'search', queries: [searchEvent.query] },
            results: searchEvent.results
        });
    }

    for (const tc of state.functionCalls) {
        output.push(toResponseCallItem(
            responseId + '_fc_' + (tc.index || 0), tc.name || '', tc.id || '', tc.arguments || '', 'completed'
        ));
    }

    if (state.answerText && state.answerText.trim()) {
        output.push({
            type: 'message',
            id: responseId + '_msg',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: state.answerText }]
        });
    }

    // Nothing the user can act on came back (no answer, no tool call).
    if (!output.some(o => o.type === 'message' || o.type === 'function_call' || o.type === 'custom_tool_call')) {
        output.push({
            type: 'message',
            id: responseId + '_empty',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: emptyReplyText(state.model) }]
        });
    }

    return {
        id: responseId,
        object: 'response',
        status: 'completed',
        output,
        usage: usageFromTotals(state.usageTotals)
    };
}

async function requestChatCompletionJson(chatBody) {
    const requestBody = { ...chatBody, stream: false };
    // `stream_options` is only valid alongside `stream: true`; a non-streaming
    // request that still carries it is rejected by NIM (HTTP 400).
    delete requestBody.stream_options;
    const result = await forwardRequestWithRetry(null, JSON.stringify(requestBody));
    const raw = await readIncomingMessage(result.response);

    if (result.response.statusCode !== 200) {
        const err = new Error('NVIDIA NIM returned ' + result.response.statusCode);
        err.statusCode = result.response.statusCode;
        err.body = raw;
        throw err;
    }

    try {
        return JSON.parse(raw);
    } catch (e) {
        const err = new Error('Failed to parse upstream JSON: ' + e.message);
        err.body = raw.substring(0, 500);
        throw err;
    }
}

async function resolveHostedResponse(chatBody) {
    return await resolveHostedResponseCore(chatBody, null, 0);
}

async function resolveHostedResponseStreaming(res, chatBody, endpoint) {
    const tempState = {
        responseId: 'resp_' + Date.now(),
        reasoningParts: [],
        searchEvents: [],
        functionCalls: [],
        answerText: '',
        usageTotals: emptyUsageTotals(),
        seq: 0,
        clientGone: false,
        upstream: null,
        model: chatBody.model,
        // 原生 Responses 对象带 created_at（unix 秒）。Codex 回看会话时按它渲染
        // 每回合的耗时徽章；此前我们不发这个字段，回看里的 working 时长就是空的。
        createdAt: Math.floor(Date.now() / 1000)
    };

    const workingChatBody = JSON.parse(JSON.stringify(chatBody));
    workingChatBody.stream = true;
    // Ask NIM to attach token usage to the final stream chunk, so the proxy can
    // report real counts in `response.completed` instead of leaving them at zero.
    workingChatBody.stream_options = { include_usage: true };
    workingChatBody.messages = Array.isArray(workingChatBody.messages) ? workingChatBody.messages : [];

    // 「分层报错」第 2 层：开流之前先探一次上游。
    // 只要失败发生在流开始前（上游 401/402/403/404/429/5xx，或压根连不上），
    // 我们还能返回一个**真实的 HTTP 状态码 + JSON**，让 Codex 渲染它自己的原生
    // 错误卡片——没有 "Reconnecting N/5"，也没有 "stream disconnected before
    // completion:" 前缀。一旦 writeHead(200) 写出去，就只剩 SSE 一条路了。
    let firstResponse;
    try {
        const opened = await forwardRequestWithRetry(null, JSON.stringify(workingChatBody));
        firstResponse = opened.response;
    } catch (e) {
        // 重试耗尽仍连不上上游：这是"流开始前"的失败，回 502。
        log('STREAM_MAIN: upstream unreachable before stream start:', e.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(codexErrorEnvelope(502, e, chatBody.model, endpoint)));
        return;
    }

    const firstStatus = firstResponse.statusCode || 200;
    if (firstStatus !== 200) {
        let raw = '';
        try { raw = await readIncomingMessage(firstResponse); } catch (e) {}
        log('STREAM_MAIN: upstream HTTP ' + firstStatus + ' before stream start, body:', (raw || '').substring(0, 300));
        if (firstStatus === 404) blacklistModel(chatBody.model);
        res.writeHead(codexHttpStatus(firstStatus), { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(codexErrorEnvelope(firstStatus, { message: raw, body: raw }, chatBody.model, endpoint)));
        return;
    }

    // 上游已就绪（200）——此刻才真正开流。
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    if (res.socket) { res.socket.setNoDelay(true); }

    await writeSseLine(res, JSON.stringify({
        type: 'response.created',
        response: { id: tempState.responseId, status: 'in_progress', output: [], created_at: tempState.createdAt },
        sequence_number: tempState.seq++
    }));
    await writeSseLine(res, JSON.stringify({
        type: 'response.in_progress',
        response: { id: tempState.responseId, status: 'in_progress', output: [], created_at: tempState.createdAt },
        sequence_number: tempState.seq++
    }));
    await new Promise(r => setTimeout(r, 100));

    const heartbeat = setInterval(() => {
        try {
            if (res.writable && !res.destroyed) {
                res.write(': heartbeat\n\n');
            }
        } catch (e) {}
    }, 3000);

    // Desktop "pause" / window close aborts the HTTP request. Tear the stream down
    // for real: stop the heartbeat, abort the upstream NIM stream (so reasoning
    // deltas stop being produced and logged), and mark the client as gone.
    const onClientClose = () => {
        tempState.clientGone = true;
        clearInterval(heartbeat);
        if (tempState.upstream) {
            try { tempState.upstream.destroy(); } catch (e) {}
        }
    };
    res.on('close', onClientClose);

    let firstRoundResult;
    try {
        // 复用上面已经建好并校验过状态码的第 0 轮上游连接（preOpenedResponse）。
        firstRoundResult = await streamSingleRound(res, workingChatBody, tempState, 0, firstResponse);
    } catch (e) {
        clearInterval(heartbeat);
        throw e;
    }
    log('STREAM_MAIN: firstRoundResult=' + (firstRoundResult ? ('wsCalls=' + firstRoundResult.webSearchCalls.length + ', seEvents=' + firstRoundResult.searchEvents.length) : (tempState.streamFailed ? 'failed' : 'null')));
    if (!firstRoundResult) {
        log('STREAM_MAIN: first round returned null (' + (tempState.streamFailed ? 'response failed' : 'external tool calls') + '), finishing');
        clearInterval(heartbeat);
        await finishSseIfOpen(res);
        return;
    }

    if (tempState.clientGone) {
        log('STREAM_MAIN: client disconnected, abandoning round');
        clearInterval(heartbeat);
        return;
    }

    if (firstRoundResult.webSearchCalls.length === 0) {
        log('STREAM_MAIN: no web search calls, finishing. contentItemAdded was in streamSingleRound');
        clearInterval(heartbeat);
        await finishSseIfOpen(res);
        return;
    }

    tempState.searchEvents = firstRoundResult.searchEvents;
    const updatedBody = firstRoundResult.updatedChatBody;

    // 搜索之后的收尾轮继续走流式，而不是像以前那样发一个非流式请求、等整段答案
    // 生成完再一次性补发事件。旧写法在那段等待里只会发 `: heartbeat` 注释行，而
    // Codex 的 SSE 空闲计时器不认注释 —— 实测它会在第 300 秒判定流已断开并重试
    // 整个回合（日志里是 `idle timeout waiting for SSE`）。改成流式后，推理、正文
    // 和工具调用都随 token 实时流出，静默期只剩下游首字延迟。
    try {
        let roundBody = updatedBody;
        let roundResult = null;
        for (let round = 1; round < MAX_HOSTED_WEB_SEARCH_ROUNDS; round++) {
            roundResult = await streamSingleRound(res, roundBody, tempState, round);

            if (!roundResult) {
                // 这一轮把外部工具调用交还给了 Codex，或已发 response.failed 终止；
                // 两种情况回合都在 streamSingleRound 里收尾了。
                log('STREAM_MAIN: round ' + round + ' ended the stream (' + (tempState.streamFailed ? 'response failed' : 'external tool calls') + ')');
                return;
            }

            if (tempState.clientGone) {
                log('STREAM_MAIN: client disconnected during round ' + round);
                return;
            }

            tempState.searchEvents = tempState.searchEvents.concat(roundResult.searchEvents);

            if (roundResult.webSearchCalls.length === 0) {
                // 最终答案（或空回合提示）已经流出，completed 也发过了。
                log('STREAM_MAIN: round ' + round + ' produced the final answer');
                return;
            }

            roundBody = roundResult.updatedChatBody;
        }

        // 每一轮都还在要搜索，说明预算用完了。这时不再直接失败，而是去掉搜索工具再
        // 追问最后一次，逼模型用手上已有的信息作答。
        log('HOSTED SEARCH:', 'round budget exhausted, forcing a final answer');
        const finalBody = JSON.parse(JSON.stringify(roundBody));
        delete finalBody.tools;
        delete finalBody.tool_choice;
        finalBody.messages.push({
            role: 'system',
            content: 'Web search budget exhausted. Answer the user now with the information already gathered.'
        });
        await streamSingleRound(res, finalBody, tempState, MAX_HOSTED_WEB_SEARCH_ROUNDS);
    } finally {
        // finally 同时覆盖正常返回与中途抛错，避免心跳定时器泄漏。
        clearInterval(heartbeat);
        await finishSseIfOpen(res);
    }
}

function finishSseIfOpen(res) {
    if (res && !res.writableEnded) {
        try { res.end(); } catch (e) {}
    }
}

// Codex does not render `type: 'error'` SSE events, so proxy-side notices (empty
// turn, web-search budget exhausted) are delivered as ordinary assistant
// messages. Quoting them with a bold header keeps them visually distinct from
// real model replies. Hard failures no longer use this path — they go out as
// HTTP errors / response.failed so Codex renders its own native error card.
function errorReply(title, detail) {
    return '> **' + title + '**\n>\n> ' + detail;
}

// Structured single-line failure description, in the shape of a system log:
// "NIM proxy failed while handling /responses. Provider: NVIDIA NIM; model:
// <m>; upstream_status: HTTP <n>; cause: <...>. <advice>". Rendered by Codex
// as its native error card (via response.failed / HTTP error status), so the
// wording stays machine-formal rather than sounding like a model reply.
// statusCode 0 means "never got a response" (network failure after retries).
function upstreamErrorDetail(statusCode, err, model) {
    const raw = ((err && err.message) || 'unknown error').replace(/\s+/g, ' ').trim();
    let cause;
    let advice;
    if (statusCode === 404) {
        cause = 'NVIDIA NIM does not serve "' + (model || '') + '" for this account (removed from the model list)';
        advice = 'Switch to another model.';
    } else if (statusCode === 402) {
        cause = 'the free quota for this NVIDIA account is used up';
        advice = 'Use a different API key or a paid endpoint — switching models will not help.';
    } else if (statusCode === 401 || statusCode === 403) {
        cause = 'NVIDIA refused the API key';
        advice = 'Check NVIDIA_API_KEY in .env and restart the proxy.';
    } else if (statusCode === 429) {
        cause = 'NVIDIA is throttling this key (free tier RPM limit)';
        advice = 'Wait a moment and retry, or switch to another model.';
    } else if (statusCode === 500 && !(err && err.body)) {
        cause = 'internal proxy error: ' + raw;
        advice = 'This is a bug in the proxy itself — restart it; if it keeps happening, please report the message above.';
    } else if (statusCode >= 500) {
        cause = 'NVIDIA returned a server error: ' + raw;
        advice = 'Try again in a moment, or switch models.';
    } else if (statusCode === 0) {
        cause = 'upstream unreachable after retries: ' + raw;
        advice = 'Check network connectivity, then retry.';
    } else if (statusCode === 413) {
        // 本地护栏（不是上游错误）：请求体超过代理上限。此时重试与换模型都
        // 无济于事——问题出在 Codex 这一次请求本身的大小（会话上下文失控）。
        cause = 'the request itself exceeds the proxy body limit (256MB)' + (raw ? ': ' + raw : '');
        advice = 'This conversation context has grown too large — start a new session instead of retrying; retrying or switching models cannot shrink it.';
    } else {
        cause = 'upstream error: ' + raw;
        advice = 'Try again or switch models.';
    }
    return 'NIM proxy failed while handling /responses. Provider: NVIDIA NIM; model: '
        + (model || 'unknown') + '; upstream_status: HTTP ' + (statusCode || 'unreachable')
        + '; cause: ' + cause + '. ' + advice;
}

// HTTP 错误响应的 body。字段刻意对齐 CC Switch 本地代理的信封：
//   {"error": {message, type, code, param, provider, model, endpoint, upstream_status}}
// 而不是最小化的 {"error": {code, message}}。原因是 Codex 对两者的处理不同——
// 最小信封会让它套上 "unexpected status <code> <reason>: <body>, url: <url>"
// 的外壳，并把这一轮当"意外状态码"重采样 5 次（UI 上就是 "Reconnecting 5/5"）；
// 带 type/param/provider/... 的完整信封则只显示 error.message，不加壳也不重试。
// 这层信封是 Codex 客户端的展示行为，代理这边唯一能控制的就是把它喂成它认得的形状。
function codexErrorEnvelope(statusCode, err, model, endpoint) {
    const envelope = {
        message: upstreamErrorDetail(statusCode, err, model),
        type: 'proxy_error',
        code: 'nim_proxy_error',
        param: null,
        provider: 'NVIDIA NIM',
        model: model || 'unknown',
        endpoint: endpoint || '/responses'
    };
    if (statusCode) {
        envelope.upstream_status = statusCode;
    }
    return { error: envelope };
}

// 发给 Codex 的 HTTP 状态码。404 与 413 必须改报 400：对 Codex 而言这些状态码
// 走的是"意外状态码"兜底路（由本机 logs_2.sqlite 对照证实——同一个 Codex，CC
// Switch 返回 400 时零重试、Turn error 记录原始 JSON、卡片只显示 error.message；
// 我们返回 404/413 时无论错误体是最小信封还是完整信封，都会被套上 "unexpected
// status ... : <body>, url: <url>" 外壳并重采样 5 次，即 UI 上的 "Reconnecting
// 5/5"；413 的重试文案甚至是 "Reconnecting... waiting for network"）。也就是说
// Codex 把 400 当"请求本身有问题"（不重试，直接把 body 当错误信息），把其余没
// 专门处理的状态码当"可重试的意外"（显示时套壳）。上游 404 的语义（该模型对这
// 台账号不可用）与本地 413 的语义（请求体超上限，重试无益）对 Codex 来说恰好
// 都是"你这次请求本身有问题"，报 400 不算谎报；真实状态码仍写在 message 的
// upstream_status 字段里，信息一点不丢。其余状态码一律原样透传。
function codexHttpStatus(upstreamStatus) {
    return upstreamStatus === 404 || upstreamStatus === 413 ? 400 : upstreamStatus;
}

// Terminate a streaming turn with the Responses protocol's failure event so
// the client renders its own native error UI. Codex maps response.failed to
// an error card showing error.message; it does not render type:'error' SSE
// events, and a fake assistant message hides the failure from the client.
async function emitResponseFailed(res, responseId, seqRef, message) {
    await writeSseLine(res, JSON.stringify({
        type: 'response.failed',
        response: {
            id: responseId,
            status: 'failed',
            error: { code: 'nim_proxy_error', message }
        },
        sequence_number: seqRef.seq++
    }));
    // 失败流到此为止，绝不能再补 Chat Completions 的 `data: [DONE]` 哨兵。
    // Responses API 没有 [DONE]；Codex 的响应解析器会把这 6 个字节记成
    // "Failed to parse SSE event error_category=Syntax error_line=1 error_column=2
    // payload_bytes=6"，进而把整条失败流误判为传输层断流，UI 显示
    // "Reconnecting 1/5" 重试，而不是渲染 response.failed 的原生错误卡片。
    // （成功流也是读到 response.completed 即停、永远看不到尾部的 [DONE]，
    // 所以只有失败轮会中招——Codex 日志里该解析错误只出现在失败轮。）
    // 同时必须立刻 end：否则连接悬挂，客户端一直等不到流结束。
    try { res.end(); } catch (e) {}
}

// A turn that yields no text, no tool call and no thinking is nothing the user
// can act on. That happens when the model emits only its internal markup (which
// is stripped on the way out) or returns empty content — say so instead of
// leaving a silently empty turn.
function emptyReplyText(model) {
    return errorReply('NIM proxy: empty reply from the model',
        (model ? '"' + model + '" ' : '') + 'returned no text, no tool call and no reasoning this turn — usually because it emitted only its internal markup, which is filtered out. Retry once, or switch to another model.');
}

// Emit a complete assistant-message item without ending the stream, so callers
// can keep going (used to report an otherwise-empty turn before completing).
async function writeAssistantMessageEvents(res, itemId, text, outputIndex, state) {
    await writeSseLine(res, JSON.stringify({
        type: 'response.output_item.added',
        item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
        output_index: outputIndex,
        sequence_number: state.seq++
    }));
    await writeSseLine(res, JSON.stringify({
        type: 'response.content_part.added',
        part: { id: itemId + '_part0', type: 'output_text', text: '' },
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        sequence_number: state.seq++
    }));
    await writeSseLine(res, JSON.stringify({
        type: 'response.output_text.delta',
        delta: text,
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        sequence_number: state.seq++
    }));
    await writeSseLine(res, JSON.stringify({
        type: 'response.output_text.done',
        text,
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        sequence_number: state.seq++
    }));
    await writeSseLine(res, JSON.stringify({
        type: 'response.content_part.done',
        part: { id: itemId + '_part0', type: 'output_text', text },
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        sequence_number: state.seq++
    }));
    await writeSseLine(res, JSON.stringify({
        type: 'response.output_item.done',
        item: { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] },
        output_index: outputIndex,
        sequence_number: state.seq++
    }));
}

async function resolveHostedResponseCore(chatBody, sharedState, startRound) {
    const workingChatBody = JSON.parse(JSON.stringify(chatBody));
    workingChatBody.stream = false;
    // The hosted-search follow-up rounds are non-streaming, so drop the
    // `stream_options` the streaming round added — NIM rejects it with a 400
    // when `stream` is false.
    delete workingChatBody.stream_options;
    workingChatBody.messages = Array.isArray(workingChatBody.messages) ? workingChatBody.messages : [];

    const state = sharedState || {
        responseId: '',
        reasoningParts: [],
        searchEvents: [],
        functionCalls: [],
        answerText: '',
        usageTotals: emptyUsageTotals()
    };
    state.model = chatBody.model;

    for (let round = startRound; round < MAX_HOSTED_WEB_SEARCH_ROUNDS; round++) {
        const chatResp = await requestChatCompletionJson(workingChatBody);
        if (!state.responseId && chatResp.id) state.responseId = chatResp.id;
        addUsageTotals(state.usageTotals, chatResp.usage);

        const choice = (chatResp.choices && chatResp.choices[0]) || {};
        const message = choice.message || {};
        const reasoningText = extractReasoningText(message);
        if (reasoningText) state.reasoningParts.push(reasoningText);

        const answerText = extractTextContent(message.content);
        const toolCalls = normalizeToolCalls(message.tool_calls);
        const webSearchCalls = toolCalls.filter(tc => tc.name === 'web_search');
        const externalToolCalls = toolCalls.filter(tc => tc.name !== 'web_search');

        if (webSearchCalls.length === 0) {
            state.functionCalls = externalToolCalls;
            state.answerText = answerText;
            return buildResponseObjectFromState(state);
        }

        if (externalToolCalls.length > 0) {
            log('HOSTED SEARCH:', 'mixed tool calls detected, returning tool calls to Codex');
            state.functionCalls = toolCalls;
            state.answerText = answerText;
            return buildResponseObjectFromState(state);
        }

        workingChatBody.messages.push({
            role: 'assistant',
            content: answerText || null,
            tool_calls: message.tool_calls.map(cloneToolCallForMessage)
        });

        for (const tc of message.tool_calls) {
            const fn = tc.function || {};
            let args = {};
            try { args = JSON.parse(fn.arguments || '{}'); } catch (e) { args = {}; }

            const query = args.searchTerm || args.query || args.q || '';
            if (!query) {
                const fallbackText = 'Search failed: missing search query.';
                workingChatBody.messages.push({ role: 'tool', tool_call_id: tc.id || '', content: fallbackText });
                state.searchEvents.push({
                    id: tc.id || (state.responseId + '_ws_' + state.searchEvents.length),
                    query: '',
                    results: []
                });
                continue;
            }

            log('HOSTED SEARCH:', 'executing DuckDuckGo search for:', query);
            const search = await executeWebSearch(query);
            workingChatBody.messages.push({ role: 'tool', tool_call_id: tc.id || '', content: search.formatted });
            state.searchEvents.push({
                id: tc.id || (state.responseId + '_ws_' + state.searchEvents.length),
                query,
                results: search.results
            });
        }
    }

    // Every round up to the budget asked for more searches. Rather than failing
    // the turn, ask one last time with the search tools removed so the model has
    // to answer with the information it already gathered.
    log('HOSTED SEARCH:', 'round budget exhausted, forcing a final answer');
    const finalBody = JSON.parse(JSON.stringify(workingChatBody));
    delete finalBody.tools;
    delete finalBody.tool_choice;
    finalBody.messages.push({
        role: 'system',
        content: 'Web search budget exhausted. Answer the user now with the information already gathered.'
    });
    const finalResp = await requestChatCompletionJson(finalBody);
    addUsageTotals(state.usageTotals, finalResp.usage);
    const finalChoice = (finalResp.choices && finalResp.choices[0]) || {};
    const finalMessage = finalChoice.message || {};
    const finalReasoning = extractReasoningText(finalMessage);
    if (finalReasoning) state.reasoningParts.push(finalReasoning);
    state.functionCalls = [];
    state.answerText = extractTextContent(finalMessage.content)
        || errorReply('NIM proxy: web search limit reached',
            'No final answer was produced before the search budget ran out. Try rephrasing the question, or provide the details you already have.');
    return buildResponseObjectFromState(state);
}

async function processResponseIncremental(response, onDelta) {
    await new Promise((resolve, reject) => {
        let buffer = '';
        let pendingCount = 0;
        let streamEnded = false;
        // Deltas are executed one after another: two chunks that arrive in the
        // same tick used to run concurrently, and their awaits could interleave
        // so downstream events (e.g. reasoning summary deltas) came out reversed.
        let tail = Promise.resolve();

        function checkComplete() {
            if (streamEnded && pendingCount === 0) {
                resolve();
            }
        }

        function enqueueDelta(delta, usage, finishReason) {
            pendingCount++;
            tail = tail.then(() => onDelta(delta, usage, finishReason));
            tail.then(
                () => { pendingCount--; checkComplete(); },
                (err) => { reject(err); }
            );
        }

        response.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data: ')) continue;
                const data = trimmed.slice(6).trim();
                if (data === '[DONE]') continue;
                let parsed;
                try { parsed = JSON.parse(data); } catch (e) { continue; }
                const choice = (parsed.choices && parsed.choices[0]) || {};
                const delta = choice.delta || {};
                enqueueDelta(delta, parsed.usage, choice.finish_reason || null);
            }
        });
        response.on('end', () => {
            const trimmed = buffer.trim();
            if (trimmed && trimmed.startsWith('data: ') && trimmed.slice(6).trim() !== '[DONE]') {
                let parsed;
                try { parsed = JSON.parse(trimmed.slice(6).trim()); } catch (e) {}
                if (parsed) {
                    const delta = (parsed.choices && parsed.choices[0] && parsed.choices[0].delta) || {};
                    enqueueDelta(delta, parsed.usage);
                }
            }
            streamEnded = true;
            checkComplete();
        });
        // The upstream stream is destroyed when the client disconnects. Node emits
        // 'close' (not 'end') in that case, so settle the promise here — otherwise
        // the round would hang forever and leak the heartbeat timer.
        response.on('close', () => {
            streamEnded = true;
            checkComplete();
        });
        response.on('error', reject);
    });
}

async function streamSingleRound(res, chatBody, state, roundIndex, preOpenedResponse) {
    let response;
    if (preOpenedResponse) {
        // 第 0 轮的上游连接已在开流前建好、并且确认过 200（见
        // resolveHostedResponseStreaming），这里直接复用，不再重复请求——
        // 也就不用再序列化一次请求体（开流前那次 stringify 已经发过了）。
        response = preOpenedResponse;
    } else {
        const bodyStr = JSON.stringify(chatBody);
        let result;
        try {
            result = await forwardRequestWithRetry(null, bodyStr);
        } catch (e) {
            // 重试耗尽仍连不上上游：发 response.failed 让 Codex 渲染原生错误卡片，
            // 而不是把网络故障伪装成一条模型回复。
            log('STREAM_R' + roundIndex + ': upstream unreachable after retries:', e.message);
            state.streamFailed = true;
            await emitResponseFailed(res, state.responseId, state, upstreamErrorDetail(0, e, chatBody.model));
            return null;
        }
        response = result.response;
        const statusCode = response.statusCode || 200;

        if (statusCode !== 200) {
            const raw = await readIncomingMessage(response);
            log('STREAM_R' + roundIndex + ': upstream HTTP ' + statusCode + ', body:', (raw || '').substring(0, 300));
            if (statusCode === 404) blacklistModel(chatBody.model);
            state.streamFailed = true;
            await emitResponseFailed(res, state.responseId, state, upstreamErrorDetail(statusCode, { message: raw, body: raw }, chatBody.model));
            return null;
        }
    }

    // Hand the upstream stream to the shared client-close handler (registered in
    // resolveHostedResponseStreaming) so a disconnect can abort it immediately.
    state.upstream = response;
    if (state.clientGone) {
        try { response.destroy(); } catch (e) {}
    }

    let fullContent = '';
    let fullReasoning = '';
    let finishReason = null;
    let webSearchCalls = [];
    let searchEvents = [];
    const wsCallMap = new Map();

    let contentItemAdded = false;
    let reasonItemAdded = false;
    let contentIndex = 0;
    // output_index 用全局递增槽位计数器分配：静态"每轮 2 槽"公式在轮内出现
    // 搜索/工具条目时会溢出到下一轮的槽位造成撞 index，这里每发一个条目取一个新槽。
    // tempState 跨轮共享，前一轮用掉的槽位自动累计。
    let nextSlot = state.nextSlot || 0;
    let reasonIndex = nextSlot;
    let functionCallItemsAdded = new Set();

    // 思考分段状态：NIM 的思维链是原始大块文本，没有 OpenAI 那种现成的多段摘要。
    // 这里按换行（整段超长时按句界兜底）切成多个 summary part，**整段缓冲、段落
    // 成形才一次性发出**。刻意不做段内打字机流式：原生摘要每段只有一句话，打字机
    // 一行瞬间完成；NIM 的"段"比原生句子长得多，逐字流式会让一行灰字持续增长
    // （观感就是"超长行+…"闪烁），整段蹦出反而与原生"逐行出现"的观感一致。
    // partBuffer 是还没凑成段的部分；summaryParts 收集已闭合的段，供
    // output_item.done 的 summary 数组使用；summaryIndex 是下一段的序号。
    let partBuffer = '';
    const summaryParts = [];
    let summaryIndex = 0;
    const thinkItemId = state.responseId + '_think_r' + roundIndex;

    // 正文流式净化的尾缓冲（配合 privateMarkupHoldStart）。contentHold 暂存那些
    // "可能是内部标记开头、但还没收齐"的尾部片段，等后续 delta 到齐再判定：
    // 确实是标记就丢弃，只是普通文本（如 `a <` 这种代码）就原样补发。正常文本
    // 最多只被扣 1 个字符（孤立的 `<`），不影响流式观感。
    let contentHold = '';
    const feedContent = (delta) => {
        if (!delta) return '';
        contentHold = (contentHold + delta).replace(PRIVATE_MARKUP, '');
        const cut = privateMarkupHoldStart(contentHold);
        const safe = contentHold.slice(0, cut);
        contentHold = contentHold.slice(cut);
        return safe;
    };
    // 流结束时调用：把尾缓冲里剩下的东西吐出来。若剩下的仍像是没闭合的标记
    // （上游被掐断），宁可丢弃也不显示给用户。
    const flushContent = () => {
        const tail = contentHold.replace(PRIVATE_MARKUP, '');
        contentHold = '';
        return privateMarkupHoldStart(tail) === tail.length ? tail : '';
    };

    // 把一段已净化的正文增量发给客户端：懒创建 assistant 气泡，再写 delta。
    // 正常路径每个 delta 调一次；流末尾再用它补发尾缓冲。
    const emitContentDelta = async (textDelta) => {
        if (!textDelta) return;
        fullContent += textDelta;
        // A reply whose only content was model-internal markup leaves just
        // whitespace behind — don't open a bubble for it.
        if (!contentItemAdded && fullContent.trim()) {
            contentIndex = nextSlot++;
            contentItemAdded = true;
            const itemId = state.responseId + '_msg_r' + roundIndex;
            await writeSseLine(res, JSON.stringify({
                type: 'response.output_item.added',
                item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
                output_index: contentIndex,
                sequence_number: state.seq++
            }));
            await writeSseLine(res, JSON.stringify({
                type: 'response.content_part.added',
                part: { id: itemId + '_part0', type: 'output_text', text: '' },
                item_id: itemId,
                output_index: contentIndex,
                content_index: 0,
                sequence_number: state.seq++
            }));
        }
        if (contentItemAdded) {
            await writeSseLine(res, JSON.stringify({
                type: 'response.output_text.delta',
                delta: textDelta,
                item_id: state.responseId + '_msg_r' + roundIndex,
                output_index: contentIndex,
                content_index: 0,
                sequence_number: state.seq++
            }));
        }
    };

    const messages = chatBody.messages;

    log('STREAM_R' + roundIndex + ': starting to process incremental response');

    // 把一段已成形的思考文本作为一个 summary part 整体发出：
    // part.added → delta → done → part.done，一口气四连。
    const emitSummaryPart = async (text, idx) => {
        await writeSseLine(res, JSON.stringify({
            type: 'response.reasoning_summary_part.added',
            part: { type: 'summary_text', text: '' },
            item_id: thinkItemId,
            output_index: reasonIndex,
            summary_index: idx,
            sequence_number: state.seq++
        }));
        await writeSseLine(res, JSON.stringify({
            type: 'response.reasoning_summary_text.delta',
            delta: text,
            item_id: thinkItemId,
            output_index: reasonIndex,
            summary_index: idx,
            sequence_number: state.seq++
        }));
        await writeSseLine(res, JSON.stringify({
            type: 'response.reasoning_summary_text.done',
            text: text,
            item_id: thinkItemId,
            output_index: reasonIndex,
            summary_index: idx,
            sequence_number: state.seq++
        }));
        await writeSseLine(res, JSON.stringify({
            type: 'response.reasoning_summary_part.done',
            part: { type: 'summary_text', text: text },
            item_id: thinkItemId,
            output_index: reasonIndex,
            summary_index: idx,
            sequence_number: state.seq++
        }));
        summaryParts.push(text);
    };

    await processResponseIncremental(response, async (delta, usage, finish) => {
        if (usage) addUsageTotals(state.usageTotals, usage);
        // 记录上游停止原因：stop=模型自己停完；tool_calls=要调工具（进入下一轮）；
        // length=输出被截断——截断时模型可能"话没说完、工具没发全"，必须如实上报
        // incomplete，否则 Codex 会把一次被掐断的回合当成正常完成。
        if (finish) finishReason = finish;
        const reasoning = extractReasoningText(delta);
        // 走尾缓冲版净化：内部标记可能分片到达，逐 delta 直接正则替换会漏掉
        // （见 privateMarkupHoldStart 的注释）。
        const textDelta = feedContent(delta.content || '');
        const tcDeltas = normalizeToolCalls(delta.tool_calls);

        // Log first few deltas to debug model output format
        if (state.seq < 15) {
            const keys = Object.keys(delta).filter(k => delta[k] !== undefined && delta[k] !== '' && delta[k] !== null);
            const tcInfo = tcDeltas.length > 0 ? ' tc=[' + tcDeltas.map(t => t.name || '(no name)').join(',') + ']' : '';
            log('STREAM_R' + roundIndex + ': delta keys=[' + keys.join(',') + ']' + (textDelta ? ' content="' + textDelta.substring(0, 80).replace(/\n/g, '\\n') + '"' : '') + (reasoning ? ' reasoning="' + reasoning.substring(0, 80).replace(/\n/g, '\\n') + '"' : '') + tcInfo);
        }

        if (DEBUG) {
            const deltaKeys = [];
            if (reasoning) deltaKeys.push('reasoning:' + reasoning.length);
            if (textDelta) deltaKeys.push('content:' + textDelta.length);
            if (tcDeltas.length > 0) deltaKeys.push('tool_calls:' + tcDeltas.length);
            if (deltaKeys.length > 0) log('STREAM_R' + roundIndex + ': delta ' + deltaKeys.join(', '));
        }

        for (const tc of tcDeltas) {
            const existing = wsCallMap.get(tc.index);
            if (existing) {
                if (tc.name && !existing.name) existing.name = tc.name;
                if (tc.arguments) existing.arguments = (existing.arguments || '') + (tc.arguments || '');
                if (tc.id && !existing.id) existing.id = tc.id;
            } else {
                wsCallMap.set(tc.index, {
                    index: tc.index,
                    id: tc.id || '',
                    name: tc.name || '',
                    arguments: tc.arguments || '',
                    type: 'function'
                });
            }
        }

        if (reasoning) {
            fullReasoning += reasoning;
            if (!reasonItemAdded) {
                reasonIndex = nextSlot++;
                reasonItemAdded = true;
                // 发一个原生 `reasoning` 条目，让 Codex 用自己的"思考"样式渲染思维链，
                // 而不是当成普通回答正文。
                //
                // 双通道 hedge：Codex 内核的事件名表只认
                // response.reasoning_summary_text.* / response.reasoning_summary_part.*，
                // 根本没有 response.reasoning_text（会被记成 "unhandled responses
                // event"），所以真正能显示出来的是 summary 通道；而 content 通道留给
                // 会读原始思维链的客户端。条目本身两边都带上，谁都能解析。
                await writeSseLine(res, JSON.stringify({
                    type: 'response.output_item.added',
                    item: { id: thinkItemId, type: 'reasoning', summary: [], content: [] },
                    output_index: reasonIndex,
                    sequence_number: state.seq++
                }));
            }
            // 原始通道照旧逐块流式：Codex 不渲染 reasoning_text 事件，
            // 这里是留给会读原始思维链的其他客户端的。
            await writeSseLine(res, JSON.stringify({
                type: 'response.reasoning_text.delta',
                delta: reasoning,
                item_id: thinkItemId,
                output_index: reasonIndex,
                content_index: 0,
                sequence_number: state.seq++
            }));

            // summary 通道分段：攒进 partBuffer，凑出一段就整体发出（emitSummaryPart）。
            // 切段规则：遇到换行就切；一直没有换行且攒过 200 字符时，从头部往后找
            // 第一个句界兜底切一刀——否则"没有换行的思维链"会退化回单个巨长 part，
            // 显示上又回到折叠的"第一行+…"。guard 只是防御性上限，正常到不了。
            partBuffer += reasoning;
            let guard = 0;
            while (guard++ < 64) {
                let segText = null;
                const nl = partBuffer.search(/\r?\n/);
                if (nl !== -1) {
                    segText = partBuffer.slice(0, nl);
                    partBuffer = partBuffer.slice(nl).replace(/^[ \t]*\r?\n/, '');
                } else if (partBuffer.length > 200) {
                    const end = firstSentenceEnd(partBuffer, 80);
                    if (end !== -1) {
                        segText = partBuffer.slice(0, end + 1);
                        partBuffer = partBuffer.slice(end + 1);
                    }
                }
                if (segText === null) break;
                if (!segText.trim()) continue;
                await emitSummaryPart(segText.trim(), summaryIndex++);
            }
        }

        // 如实输出：即使是发起 web_search 的中间轮，模型说的话也照常转发。
        // 旧版刻意吞掉搜索轮的文本（初版就有的取舍，当时没写理由）：动机是那轮
        // 文本几乎总是"我来搜一下X"式过渡语，模型拿到结果后会重新表述一遍，显示
        // 出来显得重复。但吞显示的代价是 Codex 里操作与解说失去交错感，用户也无从
        // 知道模型那轮说了什么。文本本来就会进对话历史（见下方 updatedChatBody 的
        // assistant 消息），所以这里只是放开显示，模型上下文不受影响。
        await emitContentDelta(textDelta);
    });

    // 流结束：把尾缓冲里扣住的普通文本补发出去（若它其实是没收齐的内部标记，
    // flushContent 会返回空串，直接丢弃）。
    await emitContentDelta(flushContent());

    if (reasonItemAdded) {
        log('STREAM_R' + roundIndex + ': reasonItemAdded, fullReasoning=' + fullReasoning.length
            + ' chars, summaryParts=' + (summaryParts.length + (partBuffer.trim() ? 1 : 0)));
        // 收尾：把还没凑成段的尾巴也作为最后一段发出去——不足一段也照发，
        // 否则这段思考就只留在上下文里、用户看不到。
        if (partBuffer.trim()) {
            await emitSummaryPart(partBuffer.trim(), summaryIndex++);
        }
        partBuffer = '';
        await writeSseLine(res, JSON.stringify({
            type: 'response.reasoning_text.done',
            text: fullReasoning,
            item_id: thinkItemId,
            output_index: reasonIndex,
            content_index: 0,
            sequence_number: state.seq++
        }));
        await writeSseLine(res, JSON.stringify({
            type: 'response.output_item.done',
            item: {
                id: thinkItemId,
                type: 'reasoning',
                // summary 数组就是逐段发出去的那些段：原生客户端按段渲染成
                // 多行灰字，回看时是多行列表而不是折叠的"第一行+…"。
                summary: summaryParts.map(text => ({ type: 'summary_text', text })),
                content: [{ type: 'reasoning_text', text: fullReasoning }]
            },
            output_index: reasonIndex,
            sequence_number: state.seq++
        }));
        if (!state.streamedReasoningIndexes) state.streamedReasoningIndexes = new Set();
        state.streamedReasoningIndexes.add(roundIndex);
        state.reasoningParts[roundIndex] = fullReasoning;
    }

    if (contentItemAdded) {
        log('STREAM_R' + roundIndex + ': contentItemAdded, fullContent=' + fullContent.length + ' chars');
        const itemId = state.responseId + '_msg_r' + roundIndex;
        await writeSseLine(res, JSON.stringify({
            type: 'response.output_text.done',
            text: fullContent,
            item_id: itemId,
            output_index: contentIndex,
            content_index: 0,
            sequence_number: state.seq++
        }));
        await writeSseLine(res, JSON.stringify({
            type: 'response.content_part.done',
            part: { id: itemId + '_part0', type: 'output_text', text: fullContent },
            item_id: itemId,
            output_index: contentIndex,
            content_index: 0,
            sequence_number: state.seq++
        }));
        await writeSseLine(res, JSON.stringify({
            type: 'response.output_item.done',
            item: { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: fullContent }] },
            output_index: contentIndex,
            sequence_number: state.seq++
        }));
    }

    const allToolCalls = Array.from(wsCallMap.values()).sort((a, b) => a.index - b.index);
    webSearchCalls = allToolCalls.filter(tc => tc.name === 'web_search');
    const externalToolCalls = allToolCalls.filter(tc => tc.name !== 'web_search');

    log('STREAM_R' + roundIndex + ': totalToolCalls=' + allToolCalls.length + ', webSearch=' + webSearchCalls.length + ', external=' + externalToolCalls.length);

    if (externalToolCalls.length > 0) {
        for (const tc of externalToolCalls) {
            // 每个工具调用取自己的新槽位，避免多个工具共用同一个 output_index。
            const fcIndex = nextSlot++;
            const itemId = state.responseId + '_fc_r' + roundIndex + '_' + tc.index;
            await writeSseLine(res, JSON.stringify({
                type: 'response.output_item.added',
                item: toResponseCallItem(itemId, tc.name, tc.id, tc.arguments, 'in_progress'),
                output_index: fcIndex,
                sequence_number: state.seq++
            }));
            if (!FREEFORM_TOOLS.has(tc.name)) {
                await writeSseLine(res, JSON.stringify({
                    type: 'response.function_call_arguments.done',
                    arguments: tc.arguments,
                    item_id: itemId,
                    output_index: fcIndex,
                    sequence_number: state.seq++
                }));
            }
            await writeSseLine(res, JSON.stringify({
                type: 'response.output_item.done',
                item: toResponseCallItem(itemId, tc.name, tc.id, tc.arguments, 'completed'),
                output_index: fcIndex,
                sequence_number: state.seq++
            }));
        }
        await writeSseLine(res, JSON.stringify({
            type: 'response.completed',
            response: finishReason === 'length'
                ? {
                    id: state.responseId,
                    // 上游按长度截断：如实上报 incomplete，Codex 才不会把
                    // "话没说完、工具没发全"的回合当成正常完成。
                    status: 'incomplete',
                    incomplete_details: { reason: 'max_output_tokens' },
                    output: [],
                    created_at: state.createdAt,
                    usage: usageFromTotals(state.usageTotals)
                }
                : { id: state.responseId, status: 'completed', output: [], created_at: state.createdAt, usage: usageFromTotals(state.usageTotals) },
            sequence_number: state.seq++
        }));
        log('STREAM_R' + roundIndex + ': finished, finish_reason=' + finishReason + ', content=' + fullContent.length + 'ch, reasoning=' + fullReasoning.length + 'ch');
        await writeSseRaw(res, 'data: [DONE]\n\n');
        state.nextSlot = nextSlot;
        return null;
    }

    let updatedChatBody = null;
    if (webSearchCalls.length > 0) {
        updatedChatBody = JSON.parse(JSON.stringify(chatBody));
        updatedChatBody.messages.push({
            role: 'assistant',
            content: fullContent || null,
            tool_calls: allToolCalls.filter(tc => tc.name === 'web_search').map(tc => ({
                id: tc.id,
                type: 'function',
                function: { name: 'web_search', arguments: tc.arguments }
            }))
        });

        for (const tc of webSearchCalls) {
            const fn = tc.function || {};
            let args = {};
            try { args = JSON.parse(tc.arguments || '{}'); } catch (e) { args = {}; }
            const query = args.searchTerm || args.query || args.q || '';

            const wsItemId = tc.id || (state.responseId + '_ws_' + searchEvents.length);
            const wsIndex = nextSlot++;
            await writeSseLine(res, JSON.stringify({
                type: 'response.output_item.added',
                item: { id: wsItemId, type: 'web_search_call', status: 'in_progress', action: { type: 'search', queries: [query] } },
                output_index: wsIndex,
                sequence_number: state.seq++
            }));

            if (!query) {
                const fallbackText = 'Search failed: missing search query.';
                updatedChatBody.messages.push({ role: 'tool', tool_call_id: tc.id || '', content: fallbackText });
                searchEvents.push({ id: wsItemId, query: '', results: [] });
                await writeSseLine(res, JSON.stringify({
                    type: 'response.output_item.done',
                    item: { id: wsItemId, type: 'web_search_call', status: 'completed', action: { type: 'search', queries: [] }, results: [] },
                    output_index: wsIndex,
                    sequence_number: state.seq++
                }));
                continue;
            }

            log('HOSTED SEARCH:', 'executing DuckDuckGo search for:', query);
            const search = await executeWebSearch(query);
            updatedChatBody.messages.push({ role: 'tool', tool_call_id: tc.id || '', content: search.formatted || search.formatted });

            const se = { id: wsItemId, query, results: search.results || [] };
            searchEvents.push(se);

            await writeSseLine(res, JSON.stringify({
                type: 'response.output_item.done',
                item: { id: wsItemId, type: 'web_search_call', status: 'completed', action: { type: 'search', queries: [query] }, results: se.results },
                output_index: wsIndex,
                sequence_number: state.seq++
            }));
        }
    }

    const streamResult = webSearchCalls.length > 0
        ? { webSearchCalls, searchEvents, updatedChatBody }
        : { webSearchCalls: [], searchEvents: [] };

    if (webSearchCalls.length === 0) {
        // Nothing the user can act on came back (no answer, no tool call) — e.g.
        // the model emitted only its internal markup, which was stripped. Report
        // it instead of completing a silently empty turn.
        if (!contentItemAdded && externalToolCalls.length === 0) {
            await writeAssistantMessageEvents(
                res,
                state.responseId + '_empty_r' + roundIndex,
                emptyReplyText(state.model),
                nextSlot++,
                state
            );
        }
        await writeSseLine(res, JSON.stringify({
            type: 'response.completed',
            response: { id: state.responseId, status: 'completed', output: [], created_at: state.createdAt, usage: usageFromTotals(state.usageTotals) },
            sequence_number: state.seq++
        }));
        await writeSseRaw(res, 'data: [DONE]\n\n');
    }

    state.nextSlot = nextSlot;
    return streamResult;
}

// 在 text 里从 minIndex 往后找第一个句子结束标点（。！？；.!?;），返回该标点的
// 下标；找不到返回 -1。用于给"整段没有换行"的思维链兜底切段：从头部往后找，
// 每刀切出 ~minIndex 起步的短段，段与段之间逐次推进，显示上灰字才能逐行出现
// （若从尾部往前找，一刀会切出接近全长的大段，等于没切）。
function firstSentenceEnd(text, minIndex) {
    for (let i = Math.max(0, minIndex); i < text.length; i++) {
        if ('。！？；.!?;'.indexOf(text[i]) !== -1) return i;
    }
    return -1;
}

async function readIncomingMessageLines(response) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve(text.split('\n'));
        });
        response.on('error', reject);
    });
}

// Write raw bytes to the SSE response, tolerating a disconnected client. Once
// the socket is gone `res.write` throws ERR_STREAM_DESTROYED synchronously, which
// would otherwise abort the round with a bogus "stream error" — the intended
// behaviour is to drop the event and let the round wind down quietly.
async function writeSseRaw(res, text) {
    if (res.destroyed || res.writableEnded) return;
    await new Promise((resolve) => {
        try {
            res.write(text, () => resolve());
        } catch (e) {
            resolve();
        }
    });
}

async function writeSseLine(res, line) {
    await writeSseRaw(res, 'data: ' + line + '\n\n');
}

function splitTextIntoChunks(text, maxLen) {
    const chunks = [];
    let remaining = text;
    while (remaining.length > maxLen) {
        let cut = remaining.lastIndexOf('\n', maxLen);
        if (cut <= 0 || cut > maxLen + 20) {
            cut = remaining.lastIndexOf(' ', maxLen);
        }
        if (cut <= 0 || cut > maxLen + 20) {
            cut = remaining.lastIndexOf('，', maxLen);
        }
        if (cut <= 0 || cut > maxLen + 20) {
            cut = remaining.lastIndexOf('。', maxLen);
        }
        if (cut <= 0 || cut > maxLen + 20) {
            cut = maxLen;
        }
        chunks.push(remaining.substring(0, cut + 1));
        remaining = remaining.substring(cut + 1);
    }
    if (remaining.length > 0) {
        chunks.push(remaining);
    }
    return chunks;
}

async function streamResponseObject(res, responseObject, skipHeader) {
    let seq = 0;
    // 非流式路径的重放也要带 created_at，理由同流式路径（回看耗时徽章）。
    const createdAt = responseObject.created_at || Math.floor(Date.now() / 1000);

    async function sendEvent(event) {
        if (!event.sequence_number) {
            event.sequence_number = seq++;
        }
        await writeSseLine(res, `data: ${JSON.stringify(event)}\n\n`);
    }

    if (!skipHeader) {
        await sendEvent({
            type: 'response.created',
            response: { id: responseObject.id, status: 'in_progress', output: [], created_at: createdAt }
        });
        await sendEvent({
            type: 'response.in_progress',
            response: { id: responseObject.id, status: 'in_progress', output: [], created_at: createdAt }
        });
    }

    for (let outputIndex = 0; outputIndex < responseObject.output.length; outputIndex++) {
        const item = responseObject.output[outputIndex];

        if (item.type === 'message') {
            await sendEvent({
                type: 'response.output_item.added',
                item: {
                    id: item.id,
                    type: 'message',
                    role: item.role,
                    status: 'in_progress',
                    content: []
                },
                output_index: outputIndex
            });

            for (let contentIndex = 0; contentIndex < item.content.length; contentIndex++) {
                const part = item.content[contentIndex];
                const partId = item.id + '_part' + contentIndex;
                const text = part.text || '';

                await sendEvent({
                    type: 'response.content_part.added',
                    part: { id: partId, type: 'output_text', text: '' },
                    item_id: item.id,
                    output_index: outputIndex,
                    content_index: contentIndex
                });

                if (text) {
                    const chunks = splitTextIntoChunks(text, 40);
                    for (const chunk of chunks) {
                        await sendEvent({
                            type: 'response.output_text.delta',
                            delta: chunk,
                            item_id: item.id,
                            output_index: outputIndex,
                            content_index: contentIndex
                        });
                        await new Promise(r => setTimeout(r, 15));
                    }
                }

                await sendEvent({
                    type: 'response.output_text.done',
                    text,
                    item_id: item.id,
                    output_index: outputIndex,
                    content_index: contentIndex
                });
                await sendEvent({
                    type: 'response.content_part.done',
                    part: { id: partId, type: 'output_text', text },
                    item_id: item.id,
                    output_index: outputIndex,
                    content_index: contentIndex
                });
            }

            await sendEvent({
                type: 'response.output_item.done',
                item,
                output_index: outputIndex
            });
            continue;
        }

        if (item.type === 'function_call') {
            const args = item.arguments || '';
            await sendEvent({
                type: 'response.output_item.added',
                item: {
                    id: item.id,
                    type: 'function_call',
                    ...toolNameFields(item.name),
                    call_id: item.call_id,
                    arguments: '',
                    status: 'in_progress'
                },
                output_index: outputIndex
            });

            if (args) {
                await sendEvent({
                    type: 'response.function_call_arguments.delta',
                    delta: args,
                    item_id: item.id,
                    output_index: outputIndex
                });
            }

            await sendEvent({
                type: 'response.function_call_arguments.done',
                arguments: args,
                item_id: item.id,
                output_index: outputIndex
            });
            await sendEvent({
                type: 'response.output_item.done',
                item,
                output_index: outputIndex
            });
            continue;
        }

        if (item.type === 'web_search_call') {
            await sendEvent({
                type: 'response.output_item.added',
                item: {
                    id: item.id,
                    type: 'web_search_call',
                    status: 'in_progress',
                    action: item.action
                },
                output_index: outputIndex
            });
            await new Promise(r => setTimeout(r, 300));
            await sendEvent({
                type: 'response.output_item.done',
                item: {
                    id: item.id,
                    type: 'web_search_call',
                    status: 'completed',
                    action: item.action,
                    results: item.results
                },
                output_index: outputIndex
            });
            continue;
        }

        await sendEvent({
            type: 'response.output_item.added',
            item,
            output_index: outputIndex
        });
        await sendEvent({
            type: 'response.output_item.done',
            item,
            output_index: outputIndex
        });
    }

    await sendEvent({
        type: 'response.completed',
        response: {
            id: responseObject.id,
            status: 'completed',
            output: responseObject.output,
            created_at: createdAt,
            usage: responseObject.usage
        }
    });

    await writeSseRaw(res, 'data: [DONE]\n\n');
}

function computeRetryDelayMs(attemptNumber, retryAfterHeader) {
    const parsedRetryAfter = Number(retryAfterHeader);
    if (Number.isFinite(parsedRetryAfter) && parsedRetryAfter > 0) {
        return Math.min(parsedRetryAfter * 1000, 30000);
    }

    const baseDelay = Math.min(1000 * Math.pow(2, Math.max(0, attemptNumber - 1)), 12000);
    const jitter = Math.floor(Math.random() * 750);
    return baseDelay + jitter;
}

async function forwardRequestWithRetry(req, bodyStr, maxRetries) {
    if (maxRetries === undefined) maxRetries = 5;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const result = await forwardRequest(req, bodyStr);

            if (result.response.statusCode === 200) {
                return result;
            }

            if (result.response.statusCode === 503 || result.response.statusCode === 429) {
                if (attempt < maxRetries) {
                    let errBody = '';
                    result.response.on('data', c => errBody += c);
                    await new Promise(r => result.response.on('end', r));
                    const retryAfterHeader = result.response.headers['retry-after'];
                    const delayMs = computeRetryDelayMs(attempt + 1, retryAfterHeader);
                    log(
                        'Retry ' + (attempt + 1) + '/' + maxRetries +
                        ' after ' + result.response.statusCode +
                        ' delay=' + delayMs + 'ms:',
                        errBody.substring(0, 150)
                    );
                    await new Promise(r => setTimeout(r, delayMs));
                    continue;
                }
                return result;
            }

            return result;
        } catch (e) {
            log('Retry ' + (attempt + 1) + '/' + maxRetries + ' after error:', e.message);
            if (attempt < maxRetries) {
                const delayMs = computeRetryDelayMs(attempt + 1);
                await new Promise(r => setTimeout(r, delayMs));
                continue;
            }
            throw e;
        }
    }
}

function buildNonStreamResponse(chatResp) {
    const choice = (chatResp.choices && chatResp.choices[0]) || {};
    const message = choice.message || {};
    const reasoningText = message.reasoning || message.reasoning_content || '';
    const answerText = message.content || '';
    const toolCalls = message.tool_calls || [];
    const output = [];

    if (reasoningText) {
        output.push({
            type: 'message',
            id: (chatResp.id || 'resp_proxy') + '_think',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: '💭 思考过程：\n\n' + reasoningText }]
        });
    }

    for (const tc of toolCalls) {
        const fn = tc.function || {};
        output.push(toResponseCallItem(
            (chatResp.id || 'resp_proxy') + '_fc_' + (tc.index || 0), fn.name || '', tc.id || '', fn.arguments || '', 'completed'
        ));
    }

    if (answerText) {
        output.push({
            type: 'message',
            id: (chatResp.id || 'resp_proxy') + '_msg',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: answerText }]
        });
    }

    return {
        id: chatResp.id || 'resp_proxy',
        object: 'response',
        status: 'completed',
        output,
        usage: nimUsageToResponse(chatResp.usage)
    };
}

const proxyServer = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
        // 请求体用 Buffer 数组累积，而不是 `body += chunk` 字符串拼接。
        // 后者在 Codex 发来超大请求体（超长会话 / 大图 base64）时会撞上 V8 的
        // 字符串长度上限（约 5 亿字符），抛 RangeError——而 'data' 回调跑在
        // 事件发射器里，外层 try/catch 罩不住，直接 uncaughtException 杀死
        // 整个代理进程（proxy-crash.log 里的 "Invalid string length" 就是它）。
        // Buffer.concat 没有这个上限，且再配一个硬上限：超过就回 413 拒掉，
        // 因为这么大的请求体 NIM 也消化不了，攒下去只会白烧内存。
        const MAX_BODY_BYTES = 256 * 1024 * 1024;
        const bodyChunks = [];
        let bodyBytes = 0;
        let bodyTooLarge = false;
        req.on('data', chunk => {
            if (bodyTooLarge) return;
            bodyBytes += chunk.length;
            if (bodyBytes > MAX_BODY_BYTES) {
                bodyTooLarge = true;
                log('Request body exceeds ' + MAX_BODY_BYTES + ' bytes, rejecting with 413');
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(codexErrorEnvelope(413, { message: 'request body too large (over 256MB)' }, '', req.url)));
                req.destroy();
                return;
            }
            bodyChunks.push(chunk);
        });
        req.on('end', async () => {
            if (bodyTooLarge) return;
            const body = Buffer.concat(bodyChunks).toString('utf8');
            try {
                const responsesBody = JSON.parse(body);
                const chatBody = convertRequest(responsesBody);
                chatBody.model = chatBody.model || currentModel;

                if (!isVisionModel(chatBody.model) && Array.isArray(chatBody.messages)) {
                    let imagesStripped = 0;
                    for (const msg of chatBody.messages) {
                        if (Array.isArray(msg.content)) {
                            const textContent = msg.content
                                .filter(c => c.type === 'text')
                                .map(c => c.text)
                                .join('');
                            const imageCount = msg.content.filter(c => c.type === 'image_url').length;
                            if (imageCount > 0) {
                                imagesStripped += imageCount;
                                msg.content = textContent;
                            }
                        }
                    }
                    if (imagesStripped > 0) {
                        log('Warning: stripped ' + imagesStripped + ' image(s) from request (model ' + chatBody.model + ' does not support multimodal)');
                    }
                }

                if (isVisionModel(chatBody.model) && Array.isArray(chatBody.messages)) {
                    const maxImages = /llama.*vision/.test(chatBody.model.toLowerCase()) ? 1 : 1;
                    const imageMessages = [];
                    for (let i = 0; i < chatBody.messages.length; i++) {
                        const msg = chatBody.messages[i];
                        if (Array.isArray(msg.content)) {
                            const imgCount = msg.content.filter(c => c.type === 'image_url').length;
                            if (imgCount > 0) {
                                imageMessages.push({ index: i, count: imgCount });
                            }
                        }
                    }
                    if (imageMessages.length > maxImages) {
                        const keep = imageMessages.slice(-maxImages);
                        const keepIndices = new Set(keep.map(m => m.index));
                        let strippedCount = 0;
                        for (let i = 0; i < chatBody.messages.length; i++) {
                            if (!keepIndices.has(i)) {
                                const msg = chatBody.messages[i];
                                if (Array.isArray(msg.content)) {
                                    const imgCount = msg.content.filter(c => c.type === 'image_url').length;
                                    if (imgCount > 0) {
                                        const textOnly = msg.content
                                            .filter(c => c.type === 'text')
                                            .map(c => c.text)
                                            .join('');
                                        msg.content = textOnly;
                                        strippedCount += imgCount;
                                    }
                                }
                            }
                        }
                        log('Warning: stripped ' + strippedCount + ' older image(s), keeping only ' + keep.length + ' most recent message(s) with images (model limit: ' + maxImages + ')');
                    }
                }
                const chatBodyStr = JSON.stringify(chatBody);

                log('=== New Request ===');
                log('Model:', chatBody.model);
                log('Stream:', responsesBody.stream);
                log('Tools:', chatBody.tools ? chatBody.tools.length : 0);
                log('Tool choice:', chatBody.tool_choice);
                log('ChatBody keys:', Object.keys(chatBody).join(','));
                if (DEBUG && responsesBody.stream) {
                    log('ChatBody (truncated):', chatBodyStr.substring(0, 500));
                }

                const isStream = responsesBody.stream === true;

                // Pre-flight: a blacklisted model can never succeed — NIM already
                // returned 404 for it before. Fail natively instead of round-tripping
                // to NIM and waiting for another 404.
                if (isBlacklisted(chatBody.model)) {
                    log('Pre-flight blacklist rejection:', chatBody.model);
                    // 失败在流开始前就已成定局，所以不走 SSE，直接返回真实 HTTP 状态码 + JSON。
                    // 这样 Codex 渲染的是它自己的错误卡片：没有 "Reconnecting 5/5"，也没有
                    // "stream disconnected before completion:" 前缀——因为 Codex 并不把
                    // response.failed 视为回合结束事件，会把它当成"未完成断流"而重试 5 次。
                    // 流式与非流式在此统一处理（此前流式分支还额外多发了一对 created/in_progress）。
                    res.writeHead(codexHttpStatus(404), { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(codexErrorEnvelope(404, { message: 'model is on the proxy blacklist (NIM does not serve it)' }, chatBody.model, req.url)));
                    return;
                }

                if (!isStream) {
                    let resp;
                    try {
                        resp = await resolveHostedResponse(chatBody);
                    } catch (e) {
                        const statusCode = e.statusCode || 500;
                        if (statusCode === 404) blacklistModel(chatBody.model);
                        // 上游失败直通 HTTP 状态码 + 结构化错误体，而不是 200 + 伪装成
                        // 正常回复——非流式客户端（含 Codex compact 等）能看到真实失败。
                        res.writeHead(codexHttpStatus(statusCode), { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(codexErrorEnvelope(statusCode, e, chatBody.model, req.url)));
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(resp));
                    return;
                }

                // 注意：这里不再 writeHead(200)。开流（writeHead 200 + response.created）
                // 已移入 resolveHostedResponseStreaming —— 它要先看第 0 轮上游的真实
                // 状态码，才能决定是「开 SSE」还是「回 HTTP 错误」（分层报错）。
                try {
                    await resolveHostedResponseStreaming(res, chatBody, req.url);
                } catch (streamErr) {
                    log('Stream error:', streamErr.message);
                    if (streamErr.body) log('Stream error body:', streamErr.body.substring(0, 500));
                    const statusCode = streamErr.statusCode || 500;
                    if (res.headersSent) {
                        // 流已经开始：只能用 response.failed（Codex 原生错误卡片）。
                        if (!res.writableEnded && !res.destroyed) {
                            await emitResponseFailed(res, 'resp_error_' + Date.now(), { seq: 0 }, upstreamErrorDetail(statusCode, streamErr, chatBody.model));
                        }
                    } else {
                        // 流还没开始：还能给真实 HTTP 状态码。
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(codexErrorEnvelope(statusCode, streamErr, chatBody.model, req.url)));
                    }
                    // Blacklist models that return 404 (not available for this account)
                    if (statusCode === 404) {
                        blacklistModel(chatBody.model);
                    }
                }

            } catch (e) {
                log('Error:', e.message);
                if (e.statusCode === 404 && chatBody && chatBody.model) {
                    blacklistModel(chatBody.model);
                }
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(codexErrorEnvelope(500, e, chatBody && chatBody.model, req.url)));
                }
            }
        });
    } else {
        log('Passthrough:', req.method, req.url);
        const passthrough = https.request({
            hostname: NVIDIA_HOST,
            port: 443,
            path: req.url,
            method: req.method,
            headers: { ...req.headers, host: NVIDIA_HOST, authorization: 'Bearer ' + NVIDIA_API_KEY },
            rejectUnauthorized: true,
        }, (pres) => {
            res.writeHead(pres.statusCode, pres.headers);
            pres.pipe(res);
        });
        passthrough.on('error', (e) => {
            log('Passthrough error:', e.message);
            if (!res.headersSent) {
                res.writeHead(502);
                res.end('Bad Gateway');
            }
        });
        req.pipe(passthrough);
    }
});

proxyServer.listen(PROXY_PORT, '127.0.0.1', () => {
    console.log(`[Proxy] Listening on http://127.0.0.1:${PROXY_PORT}/v1/responses`);
    console.log(`[Proxy] Forwarding to https://${NVIDIA_HOST}/v1/chat/completions`);
    console.log(`[Proxy] Dual bubble + tool calling support`);
});
