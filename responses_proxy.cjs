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
const PROXY_PORT = 15721;
const CONFIG_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '~', '.codex', 'config.toml');
const MODEL_STATE_PATH = path.join(__dirname, 'model_state.json');
const MODEL_LIST_PATH = path.join(__dirname, 'models.json');
const MODEL_BLACKLIST_PATH = path.join(__dirname, 'model_blacklist.json');
const MODEL_CATALOG_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '~', '.codex', 'model-catalog.json');
const DEBUG = (process.env.DEBUG || '').toLowerCase() === 'true';

const PROXY_API_BASE = 'http://127.0.0.1:15721/v1';

// 顶层由代理负责写入/清理的键（不属于任何 [section]）。
// 清理时只对这些键动手，绝不改动用户自己定义的其它 provider 段。
const PROXY_TOP_KEYS = /^(api_base_url|model_provider|model|model_catalog_json|model_reasoning_effort|model_reasoning_summary|model_supports_reasoning_summaries|show_raw_agent_reasoning)\s*=/;
const PROXY_PROVIDER_SECTION = 'model_providers.nvidia-proxy';

// 从 TOML 内容中移除代理写入的配置：
// - 整段删除 [model_providers.nvidia-proxy]（含 header 与段内所有键）
// - 删除顶层（尚未进入任何 [section]）的代理键
// 其余内容（例如用户自定义的 [model_providers.custom] 等）原样保留，
// 这样历史线程引用的其它 provider 名不会因代理启动/退出而被破坏。
function removeProxyConfig(content) {
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
    return result.join('\n');
}

function stripProxyConfig() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) return;
        const before = fs.readFileSync(CONFIG_PATH, 'utf-8');
        const content = removeProxyConfig(before).trimEnd();
        if (content !== before.trimEnd()) {
            fs.writeFileSync(CONFIG_PATH, content ? content + '\n' : '', 'utf-8');
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
        // 先移除旧的代理配置，但保留用户自定义的其它 provider 段（如 custom）
        content = removeProxyConfig(content).trim();

        // 顶层键必须写在任何 [section] header 之前，否则 TOML 作用域会出错
        const providerConfig = 'model_provider = "nvidia-proxy"\n' +
            'model = "' + modelId + '"\n' +
            'model_catalog_json = "model-catalog.json"\n\n' +
            '[model_providers.nvidia-proxy]\n' +
            'name = "NVIDIA NIM Proxy"\n' +
            'base_url = "http://127.0.0.1:15721/v1"\n' +
            'wire_api = "responses"\n';

        content = providerConfig + '\n' + content;

        const isThinking = modelId.includes('thinking') || modelId.includes('deepseek-v4-pro') || modelId.includes('kimi-k2');
        if (isThinking) {
            content += 'model_reasoning_effort = "high"\nmodel_reasoning_summary = "detailed"\nmodel_supports_reasoning_summaries = true\nshow_raw_agent_reasoning = true\n';
        }

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
        list = list.filter(m => m && !BLACKLISTED_MODELS.has(m.id));
        // Ensure the currently-selected model is present, otherwise Codex won't
        // find a matching slug and silently drops tools.
        if (currentModel && !BLACKLISTED_MODELS.has(currentModel) && !list.some(x => x.id === currentModel)) {
            list = [{ id: currentModel, name: currentModel, desc: '' }].concat(list);
        }
        const data = list.map(m => {
            const isThinking = /thinking|deepseek-v4-pro|kimi-k2/.test(m.id);
            const isVision = isVisionModel(m.id);
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
                supports_reasoning_summaries: isThinking,
                default_reasoning_summary: 'none',
                support_verbosity: false,
                apply_patch_tool_type: 'freeform',
                truncation_policy: { mode: 'bytes', limit: 10000 },
                context_window: isThinking ? 1048576 : 131072,
                max_context_window: isThinking ? 1048576 : 131072,
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
    stripProxyConfig();
    process.exit(0);
});
process.on('SIGTERM', () => {
    stripProxyConfig();
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

function loadBlacklist() {
    try {
        if (fs.existsSync(MODEL_BLACKLIST_PATH)) {
            return new Set(JSON.parse(fs.readFileSync(MODEL_BLACKLIST_PATH, 'utf-8')));
        }
    } catch (e) {
        console.warn('[Proxy] Failed to load blacklist:', e.message);
    }
    return new Set();
}

function saveBlacklist(blacklist) {
    try {
        fs.writeFileSync(MODEL_BLACKLIST_PATH, JSON.stringify([...blacklist], null, 2), 'utf-8');
    } catch (e) {
        console.warn('[Proxy] Failed to save blacklist:', e.message);
    }
}

function blacklistModel(modelId) {
    if (!BLACKLISTED_MODELS.has(modelId)) {
        BLACKLISTED_MODELS.add(modelId);
        saveBlacklist(BLACKLISTED_MODELS);
        console.warn('[Proxy] Blacklisted model:', modelId);
        // Rewrite the catalog so the desktop picker / CLI `/model` stop
        // offering the blacklisted model immediately (they read the catalog
        // file on disk, not the in-memory list).
        writeModelCatalog();
    }
}

let BLACKLISTED_MODELS = loadBlacklist();

const BUILTIN_MODELS = [
    { id: 'deepseek-ai/deepseek-v4-pro', name: 'DeepSeek V4 Pro', desc: '1.6T MoE, 49B active, 1M ctx, Think/Non-Think hybrid', tags: ['coding', 'reasoning', 'agent'] },
    { id: 'deepseek-ai/deepseek-v4-flash', name: 'DeepSeek V4 Flash', desc: '284B MoE, 13B active, fast coding & agents', tags: ['coding', 'fast', 'agent'] },
    { id: 'qwen/qwen3-coder-480b-a35b-instruct', name: 'Qwen3 Coder 480B', desc: 'Dedicated coding model, 35B active, 256K ctx', tags: ['coding', 'agent'] },
    { id: 'qwen/qwen3.5-122b-a10b', name: 'Qwen3.5 122B', desc: 'Fast general purpose, 10B active, ~110 tok/s', tags: ['fast', 'general'] },
    { id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6', desc: '1T multimodal MoE, long-horizon coding', tags: ['coding', 'multimodal'] },
    { id: 'minimaxai/minimax-m2.7', name: 'MiniMax M2.7', desc: '230B, coding + reasoning + office tasks', tags: ['coding', 'reasoning'] },
    { id: 'z-ai/glm-5.1', name: 'GLM-5.1', desc: 'Flagship LLM, agentic workflows & long-horizon reasoning', tags: ['coding', 'agent', 'reasoning'] },
    { id: 'google/gemma-4-31b-it', name: 'Gemma 4 31B', desc: 'Dense 31B, frontier reasoning, coding & agentic', tags: ['coding', 'agent', 'reasoning'] },
    { id: 'nvidia/nemotron-3-super-120b-a12b', name: 'Nemotron Super 120B', desc: 'Hybrid Mamba-Transformer MoE, 1M ctx, agentic reasoning', tags: ['agent', 'reasoning', 'tool-calling'] },
    { id: 'nvidia/llama-3.3-nemotron-super-49b-v1', name: 'Nemotron Super 49B', desc: 'NVIDIA-tuned, coding & tool calling', tags: ['coding', 'tool-calling'] },
    { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'Nemotron 70B', desc: 'NVIDIA-tuned Llama 3.1 70B, strong coding & tool use', tags: ['coding', 'tool-calling'] },
    { id: 'nvidia/nemotron-nano-12b-2-vl', name: 'Nemotron Nano 12B VL', desc: 'Multimodal, video understanding & document intelligence', tags: ['vision', 'reasoning'] },
    { id: 'meta/llama-4-maverick-17b-128e-instruct', name: 'Llama 4 Maverick', desc: '128-expert MoE, 17B active, multimodal & multilingual', tags: ['general', 'multimodal'] },
    { id: 'meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', desc: 'Popular general-purpose, stable & reliable', tags: ['general', 'fast'] },
    { id: 'meta/llama-3.1-405b-instruct', name: 'Llama 3.1 405B', desc: 'Fast, coherent, strong instruction following', tags: ['general', 'fast'] },
    { id: 'meta/llama-3.2-90b-vision-instruct', name: 'Llama 3.2 90B Vision', desc: 'Largest vision model, image understanding + coding', tags: ['vision', 'general'] },
    { id: 'mistralai/mistral-large-3-675b-instruct-2512', name: 'Mistral Large 3', desc: '675B flagship, top-tier coding & tool calling', tags: ['coding', 'agent', 'tool-calling'] },
    { id: 'mistralai/mistral-medium-3.5-128b', name: 'Mistral Medium 3.5', desc: '128B, coding & agentic use cases', tags: ['coding', 'agent'] },
    { id: 'microsoft/phi-4-multimodal-instruct', name: 'Phi-4 Multimodal', desc: 'Multimodal reasoning, vision + audio + text', tags: ['vision', 'reasoning'] },
    { id: 'microsoft/phi-4', name: 'Phi-4', desc: '14B, strong reasoning with compact size', tags: ['reasoning', 'fast'] },
    { id: 'stepfun-ai/step-3.5-flash', name: 'Step 3.5 Flash', desc: '200B MoE, frontier agentic AI', tags: ['agent', 'reasoning'] },
    { id: 'bytedance/seed-oss-36b-instruct', name: 'Seed-OSS 36B', desc: 'ByteDance, 512K ctx, long-context reasoning & agentic', tags: ['reasoning', 'agent'] },
    { id: 'ibm/granite-3.3-8b-instruct', name: 'Granite 3.3 8B', desc: 'IBM lightweight, efficient instruction following', tags: ['general', 'fast'] },
    { id: 'qwen/qwen2.5-72b-instruct', name: 'Qwen2.5 72B', desc: 'Alibaba flagship, strong multilingual coding', tags: ['coding', 'general'] },
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

let currentModel = getCurrentModelFromFile();

stripProxyConfig();

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
            try { fs.writeFileSync(MODEL_STATE_PATH, JSON.stringify({ model: currentModel }), 'utf-8'); } catch (e) {}
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
        if (fs.existsSync(MODEL_STATE_PATH)) {
            const state = JSON.parse(fs.readFileSync(MODEL_STATE_PATH, 'utf-8'));
            if (state.model && typeof state.model === 'string') {
                return state.model;
            }
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
const TOOL_DUMP_PATH = path.join(__dirname, 'tool_dump.json');
let lastToolDump = '';
function dumpToolSurface(tools) {
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
        const options = {
            hostname: NVIDIA_HOST,
            port: 443,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + NVIDIA_API_KEY,
            },
            timeout: 300000
        };

        log('Forwarding to NVIDIA, body length:', bodyStr.length);

        const proxyReq = https.request(options, (proxyRes) => {
            log('NVIDIA response received, status:', proxyRes.statusCode);
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

function extractTextContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter(part => part && (part.type === 'text' || part.type === 'output_text' || part.type === 'input_text'))
            .map(part => part.text || '')
            .join('');
    }
    return '';
}

function extractReasoningText(message) {
    return message.reasoning || message.reasoning_content || '';
}

function normalizeToolCalls(toolCalls) {
    return (toolCalls || []).map((tc, index) => ({
        index: tc.index !== undefined ? tc.index : index,
        id: tc.id || '',
        name: (tc.function && tc.function.name) || '',
        arguments: (tc.function && tc.function.arguments) || ''
    }));
}

function makeUsage(usage) {
    if (!usage) return undefined;
    return {
        input_tokens: usage.prompt_tokens || 0,
        output_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || 0
    };
}

function addUsageTotals(totals, usage) {
    if (!usage) return;
    totals.input_tokens += usage.prompt_tokens || 0;
    totals.output_tokens += usage.completion_tokens || 0;
    totals.total_tokens += usage.total_tokens || 0;
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
        output.push({
            type: 'message',
            id: responseId + '_think',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: combinedReasoning }]
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

    if (state.answerText) {
        output.push({
            type: 'message',
            id: responseId + '_msg',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: state.answerText }]
        });
    }

    return {
        id: responseId,
        object: 'response',
        status: 'completed',
        output,
        usage: state.usageTotals.total_tokens > 0 ? state.usageTotals : undefined
    };
}

async function requestChatCompletionJson(chatBody) {
    const requestBody = { ...chatBody, stream: false };
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

async function resolveHostedResponseStreaming(res, chatBody) {
    const tempState = {
        responseId: 'resp_' + Date.now(),
        reasoningParts: [],
        searchEvents: [],
        functionCalls: [],
        answerText: '',
        usageTotals: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        seq: 0,
        clientGone: false,
        upstream: null
    };

    if (res.socket) { res.socket.setNoDelay(true); }

    await writeSseLine(res, JSON.stringify({
        type: 'response.created',
        response: { id: tempState.responseId, status: 'in_progress', output: [] },
        sequence_number: tempState.seq++
    }));
    await writeSseLine(res, JSON.stringify({
        type: 'response.in_progress',
        response: { id: tempState.responseId, status: 'in_progress', output: [] },
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

    const workingChatBody = JSON.parse(JSON.stringify(chatBody));
    workingChatBody.stream = true;
    workingChatBody.messages = Array.isArray(workingChatBody.messages) ? workingChatBody.messages : [];

    let firstRoundResult;
    try {
        firstRoundResult = await streamSingleRound(res, workingChatBody, tempState, 0);
    } catch (e) {
        clearInterval(heartbeat);
        throw e;
    }
    log('STREAM_MAIN: firstRoundResult=' + (firstRoundResult ? ('wsCalls=' + firstRoundResult.webSearchCalls.length + ', seEvents=' + firstRoundResult.searchEvents.length) : 'null'));
    if (!firstRoundResult) {
        log('STREAM_MAIN: first round returned null (external tool calls), finishing');
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

    const savedRP = tempState.reasoningParts.length;
    const savedSE = tempState.searchEvents.length;
    const savedAT = tempState.answerText;

    let fallbackResult;
    try {
        fallbackResult = await resolveHostedResponseCore(updatedBody, tempState, 1);
    } finally {
        clearInterval(heartbeat);
    }

    log('STREAM_MAIN: fallback done, answerText=' + (tempState.answerText ? tempState.answerText.length + ' chars' : 'empty') + ', reasoningParts=' + tempState.reasoningParts.length + ', functionCalls=' + (tempState.functionCalls ? tempState.functionCalls.length : 0));

    const newReasoningParts = tempState.reasoningParts.slice(savedRP);
    const combinedNewReasoning = newReasoningParts.filter(Boolean).join('\n\n').trim();

    if (combinedNewReasoning) {
        const itemId = tempState.responseId + '_think_postsearch';
        await writeSseLine(res, JSON.stringify({
            type: 'response.output_item.added',
            item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
            output_index: tempState.searchEvents.length + 2,
            sequence_number: tempState.seq++
        }));
        await writeSseLine(res, JSON.stringify({
            type: 'response.content_part.added',
            part: { id: itemId + '_part0', type: 'output_text', text: '' },
            item_id: itemId,
            output_index: tempState.searchEvents.length + 2,
            content_index: 0,
            sequence_number: tempState.seq++
        }));
        const chunks = splitTextIntoChunks(combinedNewReasoning, 40);
        for (const chunk of chunks) {
            await writeSseLine(res, JSON.stringify({
                type: 'response.output_text.delta',
                delta: chunk,
                item_id: itemId,
                output_index: tempState.searchEvents.length + 2,
                content_index: 0,
                sequence_number: tempState.seq++
            }));
            await new Promise(r => setTimeout(r, 15));
        }
        await writeSseLine(res, JSON.stringify({
            type: 'response.output_text.done',
            text: combinedNewReasoning,
            item_id: itemId,
            output_index: tempState.searchEvents.length + 2,
            content_index: 0,
            sequence_number: tempState.seq++
        }));
        await writeSseLine(res, JSON.stringify({
            type: 'response.content_part.done',
            part: { id: itemId + '_part0', type: 'output_text', text: combinedNewReasoning },
            item_id: itemId,
            output_index: tempState.searchEvents.length + 2,
            content_index: 0,
            sequence_number: tempState.seq++
        }));
        await writeSseLine(res, JSON.stringify({
            type: 'response.output_item.done',
            item: { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: combinedNewReasoning }] },
            output_index: tempState.searchEvents.length + 2,
            sequence_number: tempState.seq++
        }));
    }

    if (tempState.answerText) {
        const itemId = tempState.responseId + '_msg_postsearch';
        const outIdx = combinedNewReasoning ? (tempState.searchEvents.length + 4) : (tempState.searchEvents.length + 2);
        await writeSseLine(res, JSON.stringify({
            type: 'response.output_item.added',
            item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
            output_index: outIdx,
            sequence_number: tempState.seq++
        }));
        await writeSseLine(res, JSON.stringify({
            type: 'response.content_part.added',
            part: { id: itemId + '_part0', type: 'output_text', text: '' },
            item_id: itemId,
            output_index: outIdx,
            content_index: 0,
            sequence_number: tempState.seq++
        }));
        const chunks = splitTextIntoChunks(tempState.answerText, 40);
        for (const chunk of chunks) {
            await writeSseLine(res, JSON.stringify({
                type: 'response.output_text.delta',
                delta: chunk,
                item_id: itemId,
                output_index: outIdx,
                content_index: 0,
                sequence_number: tempState.seq++
            }));
            await new Promise(r => setTimeout(r, 15));
        }
        await writeSseLine(res, JSON.stringify({
            type: 'response.output_text.done',
            text: tempState.answerText,
            item_id: itemId,
            output_index: outIdx,
            content_index: 0,
            sequence_number: tempState.seq++
        }));
        await writeSseLine(res, JSON.stringify({
            type: 'response.content_part.done',
            part: { id: itemId + '_part0', type: 'output_text', text: tempState.answerText },
            item_id: itemId,
            output_index: outIdx,
            content_index: 0,
            sequence_number: tempState.seq++
        }));
        await writeSseLine(res, JSON.stringify({
            type: 'response.output_item.done',
            item: { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: tempState.answerText }] },
            output_index: outIdx,
            sequence_number: tempState.seq++
        }));
    }

    const externalFcAfterSearch = tempState.functionCalls && tempState.functionCalls.filter(tc => tc.name !== 'web_search');
    if (externalFcAfterSearch && externalFcAfterSearch.length > 0) {
        const fcBaseIdx = outIdx + 2;
        for (let i = 0; i < externalFcAfterSearch.length; i++) {
            const tc = externalFcAfterSearch[i];
            const fcIdx = fcBaseIdx + i;
            const itemId = tempState.responseId + '_fc_post_' + (tc.index || i);
            await writeSseLine(res, JSON.stringify({
                type: 'response.output_item.added',
                item: toResponseCallItem(itemId, tc.name, tc.id, tc.arguments, 'in_progress'),
                output_index: fcIdx,
                sequence_number: tempState.seq++
            }));
            if (!FREEFORM_TOOLS.has(tc.name)) {
                await writeSseLine(res, JSON.stringify({
                    type: 'response.function_call_arguments.done',
                    arguments: tc.arguments,
                    item_id: itemId,
                    output_index: fcIdx,
                    sequence_number: tempState.seq++
                }));
            }
            await writeSseLine(res, JSON.stringify({
                type: 'response.output_item.done',
                item: toResponseCallItem(itemId, tc.name, tc.id, tc.arguments, 'completed'),
                output_index: fcIdx,
                sequence_number: tempState.seq++
            }));
        }
    }

    await writeSseLine(res, JSON.stringify({
        type: 'response.completed',
        response: { id: tempState.responseId, status: 'completed', output: [] },
        sequence_number: tempState.seq++
    }));
    await writeSseRaw(res, 'data: [DONE]\n\n');
}

function finishSseIfOpen(res) {
    if (res && !res.writableEnded) {
        try { res.end(); } catch (e) {}
    }
}

// Build a Responses-API JSON object whose single message carries the given
// text. Used to surface proxy-side errors (e.g. blacklisted/404 model) to the
// non-streaming client as a normal assistant message instead of an opaque 500.
function buildMessageResponseObject(responseId, text) {
    return {
        id: responseId,
        object: 'response',
        status: 'completed',
        output: [{
            type: 'message',
            id: responseId + '_msg',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text }]
        }]
    };
}

// Emit a standard Responses streaming event sequence that renders `text` as a
// single assistant message, then completes the stream. With `skipHeader`, the
// caller has already written `response.created` / `response.in_progress` (e.g.
// mid-stream errors), so we only append the message + completion events.
async function emitAssistantTextAndComplete(res, responseId, text, skipHeader) {
    let seq = 0;
    if (!skipHeader) {
        await writeSseLine(res, JSON.stringify({
            type: 'response.created',
            response: { id: responseId, status: 'in_progress', output: [] },
            sequence_number: seq++
        }));
        await writeSseLine(res, JSON.stringify({
            type: 'response.in_progress',
            response: { id: responseId, status: 'in_progress', output: [] },
            sequence_number: seq++
        }));
    }
    const itemId = responseId + '_msg';
    await writeSseLine(res, JSON.stringify({
        type: 'response.output_item.added',
        item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
        output_index: 0,
        sequence_number: seq++
    }));
    await writeSseLine(res, JSON.stringify({
        type: 'response.content_part.added',
        part: { id: itemId + '_part0', type: 'output_text', text: '' },
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        sequence_number: seq++
    }));
    await writeSseLine(res, JSON.stringify({
        type: 'response.output_text.delta',
        delta: text,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        sequence_number: seq++
    }));
    await writeSseLine(res, JSON.stringify({
        type: 'response.output_text.done',
        text,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        sequence_number: seq++
    }));
    await writeSseLine(res, JSON.stringify({
        type: 'response.content_part.done',
        part: { id: itemId + '_part0', type: 'output_text', text },
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        sequence_number: seq++
    }));
    await writeSseLine(res, JSON.stringify({
        type: 'response.output_item.done',
        item: { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] },
        output_index: 0,
        sequence_number: seq++
    }));
    await writeSseLine(res, JSON.stringify({
        type: 'response.completed',
        response: { id: responseId, status: 'completed', output: [] },
        sequence_number: seq++
    }));
    await writeSseRaw(res, 'data: [DONE]\n\n');
    try { res.end(); } catch (e) {}
}

async function resolveHostedResponseCore(chatBody, sharedState, startRound) {
    const MAX_HOSTED_WEB_SEARCH_ROUNDS = 6;
    const workingChatBody = JSON.parse(JSON.stringify(chatBody));
    workingChatBody.stream = false;
    workingChatBody.messages = Array.isArray(workingChatBody.messages) ? workingChatBody.messages : [];

    const state = sharedState || {
        responseId: '',
        reasoningParts: [],
        searchEvents: [],
        functionCalls: [],
        answerText: '',
        usageTotals: {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0
        }
    };

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

    throw new Error('Hosted web_search exceeded max continuation rounds');
}

async function processResponseIncremental(response, onDelta) {
    await new Promise((resolve, reject) => {
        let buffer = '';
        let pendingCount = 0;
        let streamEnded = false;

        function checkComplete() {
            if (streamEnded && pendingCount === 0) {
                resolve();
            }
        }

        function enqueueDelta(delta) {
            pendingCount++;
            onDelta(delta).then(
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
                const delta = (parsed.choices && parsed.choices[0] && parsed.choices[0].delta) || {};
                enqueueDelta(delta);
            }
        });
        response.on('end', () => {
            const trimmed = buffer.trim();
            if (trimmed && trimmed.startsWith('data: ') && trimmed.slice(6).trim() !== '[DONE]') {
                let parsed;
                try { parsed = JSON.parse(trimmed.slice(6).trim()); } catch (e) {}
                if (parsed) {
                    const delta = (parsed.choices && parsed.choices[0] && parsed.choices[0].delta) || {};
                    enqueueDelta(delta);
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

async function streamSingleRound(res, chatBody, state, roundIndex) {
    const bodyStr = JSON.stringify(chatBody);
    const result = await forwardRequestWithRetry(null, bodyStr);
    const response = result.response;
    const statusCode = response.statusCode || 200;

    // Hand the upstream stream to the shared client-close handler (registered in
    // resolveHostedResponseStreaming) so a disconnect can abort it immediately.
    state.upstream = response;
    if (state.clientGone) {
        try { response.destroy(); } catch (e) {}
    }

    if (statusCode !== 200) {
        const raw = await readIncomingMessage(response);
        const err = new Error('NVIDIA NIM returned ' + statusCode);
        err.statusCode = statusCode;
        err.body = raw;
        throw err;
    }

    let fullContent = '';
    let fullReasoning = '';
    let webSearchCalls = [];
    let searchEvents = [];
    const wsCallMap = new Map();

    let contentItemAdded = false;
    let reasonItemAdded = false;
    let contentIndex = 0;
    let reasonIndex = 0;
    let functionCallItemsAdded = new Set();

    const messages = chatBody.messages;

    log('STREAM_R' + roundIndex + ': starting to process incremental response');

    await processResponseIncremental(response, async (delta) => {
        const reasoning = extractReasoningText(delta);
        const textDelta = delta.content || '';
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
                reasonIndex = roundIndex;
                reasonItemAdded = true;
                const itemId = state.responseId + '_think_r' + roundIndex;
                await writeSseLine(res, JSON.stringify({
                    type: 'response.output_item.added',
                    item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
                    output_index: reasonIndex * 2,
                    sequence_number: state.seq++
                }));
                await writeSseLine(res, JSON.stringify({
                    type: 'response.content_part.added',
                    part: { id: itemId + '_part0', type: 'output_text', text: '' },
                    item_id: itemId,
                    output_index: reasonIndex * 2,
                    content_index: 0,
                    sequence_number: state.seq++
                }));
            }
            await writeSseLine(res, JSON.stringify({
                type: 'response.output_text.delta',
                delta: reasoning,
                item_id: state.responseId + '_think_r' + roundIndex,
                output_index: reasonIndex * 2,
                content_index: 0,
                sequence_number: state.seq++
            }));
        }

        if (textDelta && !tcDeltas.some(tc => tc.name === 'web_search')) {
            fullContent += textDelta;
            if (!contentItemAdded) {
                contentIndex = roundIndex * 2 + 1;
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
            await writeSseLine(res, JSON.stringify({
                type: 'response.output_text.delta',
                delta: textDelta,
                item_id: state.responseId + '_msg_r' + roundIndex,
                output_index: contentIndex,
                content_index: 0,
                sequence_number: state.seq++
            }));
        }
    });

    if (reasonItemAdded) {
        log('STREAM_R' + roundIndex + ': reasonItemAdded, fullReasoning=' + fullReasoning.length + ' chars');
        const itemId = state.responseId + '_think_r' + roundIndex;
        await writeSseLine(res, JSON.stringify({
            type: 'response.output_text.done',
            text: fullReasoning,
            item_id: itemId,
            output_index: reasonIndex * 2,
            content_index: 0,
            sequence_number: state.seq++
        }));
        await writeSseLine(res, JSON.stringify({
            type: 'response.content_part.done',
            part: { id: itemId + '_part0', type: 'output_text', text: fullReasoning },
            item_id: itemId,
            output_index: reasonIndex * 2,
            content_index: 0,
            sequence_number: state.seq++
        }));
        await writeSseLine(res, JSON.stringify({
            type: 'response.output_item.done',
            item: { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: fullReasoning }] },
            output_index: reasonIndex * 2,
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
            const fcIndex = contentIndex + 1;
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
            response: { id: state.responseId, status: 'completed', output: [] },
            sequence_number: state.seq++
        }));
        await writeSseRaw(res, 'data: [DONE]\n\n');
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

        const nextIndex = contentItemAdded ? contentIndex : reasonIndex * 2 + 1;
        for (const tc of webSearchCalls) {
            const fn = tc.function || {};
            let args = {};
            try { args = JSON.parse(tc.arguments || '{}'); } catch (e) { args = {}; }
            const query = args.searchTerm || args.query || args.q || '';

            const wsItemId = tc.id || (state.responseId + '_ws_' + searchEvents.length);
            await writeSseLine(res, JSON.stringify({
                type: 'response.output_item.added',
                item: { id: wsItemId, type: 'web_search_call', status: 'in_progress', action: { type: 'search', queries: [query] } },
                output_index: nextIndex + searchEvents.length,
                sequence_number: state.seq++
            }));

            if (!query) {
                const fallbackText = 'Search failed: missing search query.';
                updatedChatBody.messages.push({ role: 'tool', tool_call_id: tc.id || '', content: fallbackText });
                searchEvents.push({ id: wsItemId, query: '', results: [] });
                await writeSseLine(res, JSON.stringify({
                    type: 'response.output_item.done',
                    item: { id: wsItemId, type: 'web_search_call', status: 'completed', action: { type: 'search', queries: [] }, results: [] },
                    output_index: nextIndex + searchEvents.length - 1,
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
                output_index: nextIndex + searchEvents.length - 1,
                sequence_number: state.seq++
            }));
        }
    }

    const streamResult = webSearchCalls.length > 0
        ? { webSearchCalls, searchEvents, updatedChatBody }
        : { webSearchCalls: [], searchEvents: [] };

    if (webSearchCalls.length === 0) {
        await writeSseLine(res, JSON.stringify({
            type: 'response.completed',
            response: { id: state.responseId, status: 'completed', output: [] },
            sequence_number: state.seq++
        }));
        await writeSseRaw(res, 'data: [DONE]\n\n');
    }

    return streamResult;
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

    async function sendEvent(event) {
        if (!event.sequence_number) {
            event.sequence_number = seq++;
        }
        await writeSseLine(res, `data: ${JSON.stringify(event)}\n\n`);
    }

    if (!skipHeader) {
        await sendEvent({
            type: 'response.created',
            response: { id: responseObject.id, status: 'in_progress', output: [] }
        });
        await sendEvent({
            type: 'response.in_progress',
            response: { id: responseObject.id, status: 'in_progress', output: [] }
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
            output: responseObject.output
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
        usage: chatResp.usage ? {
            input_tokens: chatResp.usage.prompt_tokens || 0,
            output_tokens: chatResp.usage.completion_tokens || 0,
            total_tokens: chatResp.usage.total_tokens || 0
        } : undefined
    };
}

const proxyServer = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
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
                // returned 404 for it before. Answer with a clear message instead
                // of round-tripping to NIM and waiting for another 404.
                if (BLACKLISTED_MODELS.has(chatBody.model)) {
                    const errText = 'Model "' + chatBody.model + '" is not available (it was previously blacklisted). Switch to a different model.';
                    log('Pre-flight blacklist rejection:', chatBody.model);
                    if (isStream) {
                        res.writeHead(200, {
                            'Content-Type': 'text/event-stream',
                            'Cache-Control': 'no-cache',
                            'Connection': 'keep-alive'
                        });
                        if (res.socket) res.socket.setNoDelay(true);
                        await emitAssistantTextAndComplete(res, 'resp_blacklisted_' + Date.now(), errText, false);
                    } else {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(buildMessageResponseObject('resp_blacklisted_' + Date.now(), errText)));
                    }
                    return;
                }

                if (!isStream) {
                    let resp;
                    try {
                        resp = await resolveHostedResponse(chatBody);
                    } catch (e) {
                        const statusCode = e.statusCode || 500;
                        if (statusCode === 404) blacklistModel(chatBody.model);
                        const errText = statusCode === 404
                            ? 'Model "' + chatBody.model + '" is not available on NVIDIA NIM (404). It has been removed from your model list — switch to another model.'
                            : (statusCode === 500 ? e.message : 'NVIDIA NIM returned ' + statusCode + '. The model may be overloaded. Try again or switch models.');
                        resp = buildMessageResponseObject('resp_error_' + Date.now(), errText);
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(resp));
                    return;
                }

                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                });
                if (res.socket) {
                    res.socket.setNoDelay(true);
                }

                try {
                    await resolveHostedResponseStreaming(res, chatBody);
                } catch (streamErr) {
                    log('Stream error:', streamErr.message);
                    if (streamErr.body) log('Stream error body:', streamErr.body.substring(0, 500));
                    const statusCode = streamErr.statusCode || 500;
                    const isNotFound = statusCode === 404;
                    const errText = isNotFound
                        ? 'Model "' + (chatBody.model || '') + '" is not available on NVIDIA NIM (404). It has been removed from your model list — switch to another model.'
                        : (statusCode === 500
                            ? streamErr.message
                            : 'NVIDIA NIM returned ' + statusCode + '. The model may be overloaded. Try again or switch models.');
                    if (!res.writableEnded && !res.destroyed) {
                        // response.created / response.in_progress were already
                        // written before the stream errored, so append only the
                        // message + completion events (skipHeader = true). The
                        // `type: 'error'` event is not rendered by Codex.
                        await emitAssistantTextAndComplete(res, 'resp_error_' + Date.now(), errText, true);
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
                    res.end(JSON.stringify({ error: e.message }));
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
