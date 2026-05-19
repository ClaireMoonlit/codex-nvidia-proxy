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
const CONFIG_PATH = path.join(process.env.USERPROFILE || '~', '.codex', 'config.toml');
const MODEL_STATE_PATH = path.join(__dirname, 'model_state.json');
const MODEL_LIST_PATH = path.join(__dirname, 'models.json');
const DEBUG = (process.env.DEBUG || '').toLowerCase() === 'true';

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

const BUILTIN_MODELS = [
    { id: 'deepseek-ai/deepseek-v4-pro', name: 'DeepSeek V4 Pro', desc: '1.6T MoE, 49B active, 1M ctx, Think/Non-Think hybrid', tags: ['coding', 'reasoning', 'agent'] },
    { id: 'deepseek-ai/deepseek-v4-flash', name: 'DeepSeek V4 Flash', desc: '284B MoE, 13B active, fast coding & agents', tags: ['coding', 'fast', 'agent'] },
    { id: 'qwen/qwen3-coder-480b-a35b-instruct', name: 'Qwen3 Coder 480B', desc: 'Dedicated coding model, 35B active, 256K ctx', tags: ['coding', 'agent'] },
    { id: 'qwen/qwen3.5-122b-a10b', name: 'Qwen3.5 122B', desc: 'Fast general purpose, 10B active, ~110 tok/s', tags: ['fast', 'general'] },
    { id: 'qwen/qwen3-next-80b-a3b-thinking', name: 'Qwen3 Next 80B Thinking', desc: '80B MoE thinking model, 3B active', tags: ['thinking', 'general'] },
    { id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6', desc: '1T multimodal MoE, long-horizon coding', tags: ['coding', 'multimodal'] },
    { id: 'minimaxai/minimax-m2.7', name: 'MiniMax M2.7', desc: '230B, coding + reasoning + office tasks', tags: ['coding', 'reasoning'] },
    { id: 'z-ai/glm-5.1', name: 'GLM-5.1', desc: 'Flagship LLM, agentic workflows & long-horizon reasoning', tags: ['coding', 'agent', 'reasoning'] },
    { id: 'google/gemma-4-31b-it', name: 'Gemma 4 31B', desc: 'Dense 31B, frontier reasoning, coding & agentic', tags: ['coding', 'agent', 'reasoning'] },
    { id: 'google/gemma-3-27b-it', name: 'Gemma 3 27B', desc: 'Google lightweight, strong at multilingual & reasoning', tags: ['general', 'reasoning'] },
    { id: 'nvidia/nemotron-3-super-120b-a12b', name: 'Nemotron 3 Super 120B', desc: 'Hybrid Mamba-Transformer MoE, 1M ctx, agentic reasoning', tags: ['agent', 'reasoning', 'tool-calling'] },
    { id: 'nvidia/llama-3.3-nemotron-super-49b-v1', name: 'Nemotron Super 49B', desc: 'NVIDIA-tuned, coding & tool calling', tags: ['coding', 'tool-calling'] },
    { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'Nemotron 70B', desc: 'NVIDIA-tuned Llama 3.1 70B, strong coding & tool use', tags: ['coding', 'tool-calling'] },
    { id: 'nvidia/nemotron-nano-12b-2-vl', name: 'Nemotron Nano 12B VL', desc: 'Multimodal, video understanding & document intelligence', tags: ['vision', 'reasoning'] },
    { id: 'meta/llama-4-maverick-17b-128e-instruct', name: 'Llama 4 Maverick', desc: '128-expert MoE, 17B active, multimodal & multilingual', tags: ['general', 'multimodal'] },
    { id: 'meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', desc: 'Popular general-purpose, stable & reliable', tags: ['general', 'fast'] },
    { id: 'meta/llama-3.2-90b-vision-instruct', name: 'Llama 3.2 90B Vision', desc: 'Largest vision model, image understanding + coding', tags: ['vision', 'general'] },
    { id: 'meta/llama-3.1-405b-instruct', name: 'Llama 3.1 405B', desc: 'Fast, coherent, strong instruction following', tags: ['general', 'fast'] },
    { id: 'mistralai/mistral-large', name: 'Mistral Large', desc: 'Flagship model, top-tier coding & multilingual', tags: ['coding', 'agent'] },
    { id: 'mistralai/mistral-medium-3.5-128b', name: 'Mistral Medium 3.5', desc: '128B, coding & agentic use cases', tags: ['coding', 'agent'] },
    { id: 'microsoft/phi-4-multimodal-instruct', name: 'Phi-4 Multimodal', desc: 'Multimodal reasoning, vision + text', tags: ['vision', 'reasoning'] },
    { id: 'microsoft/phi-4', name: 'Phi-4', desc: '14B, strong reasoning with compact size', tags: ['reasoning', 'fast'] },
    { id: 'stepfun-ai/step-3.5-flash', name: 'Step 3.5 Flash', desc: '200B MoE, frontier agentic AI', tags: ['agent', 'reasoning'] },
    { id: 'bytedance/seed-oss-36b-instruct', name: 'Seed-OSS 36B', desc: 'ByteDance, long-context reasoning & agentic', tags: ['reasoning', 'agent'] },
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

function switchModel(modelId) {
    if (!modelId || typeof modelId !== 'string') return { ok: false, error: 'Invalid model ID' };

    currentModel = modelId;
    log('Hot-switched model to:', modelId);

    try {
        fs.writeFileSync(MODEL_STATE_PATH, JSON.stringify({ model: modelId }), 'utf-8');
    } catch (e) {
        log('State file write failed (non-fatal):', e.message);
    }

    try {
        let content = fs.readFileSync(CONFIG_PATH, 'utf-8');
        content = content.replace(/^model\s*=\s*"[^"]*"/m, 'model = "' + modelId + '"');

        const isThinking = modelId.includes('thinking') || modelId.includes('deepseek-v4-pro') || modelId.includes('kimi-k2');
        if (isThinking) {
            if (!content.includes('model_reasoning_effort')) {
                content = content.replace(/^model\s*=\s*"[^"]*"/m, 'model = "' + modelId + '"\nmodel_reasoning_effort = "high"\nmodel_reasoning_summary = "detailed"\nmodel_supports_reasoning_summaries = true\nshow_raw_agent_reasoning = true');
            }
        } else {
            content = content.replace(/^model_reasoning_effort\s*=\s*.*\n?/gm, '');
            content = content.replace(/^model_reasoning_summary\s*=\s*.*\n?/gm, '');
            content = content.replace(/^model_supports_reasoning_summaries\s*=\s*.*\n?/gm, '');
            content = content.replace(/^show_raw_agent_reasoning\s*=\s*.*\n?/gm, '');
        }

        fs.writeFileSync(CONFIG_PATH, content, 'utf-8');
    } catch (e) {
        log('Config write failed (non-fatal):', e.message);
    }

    return { ok: true, model: modelId };
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
    if (/vision|vl\b|multimodal|omni|image|video|ocr|deplot|kosmos|neva|nvclip|vila|fuyu|paligemma/.test(lower)) {
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

function isMultimodalModel(modelId) {
    if (!modelId) return false;
    const lower = modelId.toLowerCase();
    return /vision|vl\b|multimodal|omni|image|video|ocr|deplot|kosmos|neva|nvclip|vila|fuyu|paligemma/.test(lower);
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

const UI_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Codex NIM Model Switcher</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0d1117; color: #c9d1d9; min-height: 100vh; }
.header { background: #161b22; border-bottom: 1px solid #30363d; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
.header h1 { font-size: 18px; font-weight: 600; color: #58a6ff; }
.header .status { font-size: 12px; color: #8b949e; }
.header .status .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
.header .status .dot.online { background: #3fb950; box-shadow: 0 0 6px #3fb950; }
.container { max-width: 900px; margin: 0 auto; padding: 24px; }
.current { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px 20px; margin-bottom: 24px; display: flex; align-items: center; gap: 12px; }
.current .badge { background: #1f6feb; color: #fff; font-size: 11px; padding: 3px 8px; border-radius: 12px; font-weight: 600; white-space: nowrap; }
.current .name { font-size: 16px; font-weight: 600; flex: 1; }
.current .id { font-size: 12px; color: #8b949e; font-family: monospace; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; cursor: pointer; transition: all 0.15s; position: relative; }
.card:hover { border-color: #58a6ff; background: #1c2129; }
.card.active { border-color: #3fb950; background: #0d1b11; }
.card.active::after { content: '✓ ACTIVE'; position: absolute; top: 8px; right: 12px; font-size: 10px; color: #3fb950; font-weight: 700; }
.card .card-name { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
.card .card-desc { font-size: 12px; color: #8b949e; margin-bottom: 10px; line-height: 1.5; }
.card .tags { display: flex; gap: 6px; flex-wrap: wrap; }
.tag { font-size: 10px; padding: 2px 8px; border-radius: 10px; background: #21262d; color: #8b949e; border: 1px solid #30363d; }
.tag.coding { color: #7ee787; border-color: #238636; background: #0d1b11; }
.tag.reasoning { color: #d2a8ff; border-color: #8250df; background: #1b1124; }
.tag.agent { color: #79c0ff; border-color: #1f6feb; background: #0d1b2a; }
.tag.fast { color: #f0883e; border-color: #9e6a03; background: #1b180d; }
.tag.thinking { color: #ff7b72; border-color: #da3633; background: #1b0d0d; }
.tag.general { color: #c9d1d9; border-color: #484f58; background: #1c2128; }
.tag.embed { color: #d2a8ff; border-color: #8250df; background: #1b1124; }
.tag.guard { color: #f0883e; border-color: #9e6a03; background: #1b180d; }
.toast { position: fixed; bottom: 24px; right: 24px; background: #238636; color: #fff; padding: 12px 20px; border-radius: 8px; font-size: 14px; font-weight: 500; opacity: 0; transform: translateY(10px); transition: all 0.3s; pointer-events: none; z-index: 100; }
.toast.show { opacity: 1; transform: translateY(0); }
.toast.error { background: #da3633; }
.search { width: 100%; padding: 10px 16px; background: #0d1117; border: 1px solid #30363d; border-radius: 8px; color: #c9d1d9; font-size: 14px; margin-bottom: 16px; outline: none; }
.search:focus { border-color: #58a6ff; }
.search::placeholder { color: #484f58; }
</style>
</head>
<body>
<div class="header">
    <h1>⚡ Codex NIM Switcher</h1>
    <div class="status"><span class="dot online"></span>Proxy running on :15721</div>
</div>
<div class="container">
    <div class="current" id="currentBar">
        <span class="badge">CURRENT</span>
        <span class="name" id="currentName">Loading...</span>
        <span class="id" id="currentId"></span>
    </div>
    <input class="search" type="text" placeholder="🔍 Filter models..." id="search" oninput="render()">
    <div class="grid" id="grid"></div>
</div>
<div class="toast" id="toast"></div>
<script>
let models = [];
let currentModel = '';

async function load() {
    let data;
    try {
        const res = await fetch('/api/models/fetch');
        data = await res.json();
        if (!data.live) console.warn('Live fetch failed, using static list:', data.error);
    } catch (e) {
        const res = await fetch('/api/models');
        data = await res.json();
    }
    models = data.models;
    currentModel = data.current;
    document.getElementById('currentName').textContent = models.find(m => m.id === currentModel)?.name || currentModel;
    document.getElementById('currentId').textContent = currentModel;
    render();
}

function render() {
    const q = document.getElementById('search').value.toLowerCase();
    const filtered = models.filter(m => {
        if (!q) return true;
        return m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || m.tags.some(t => t.includes(q));
    });
    document.getElementById('grid').innerHTML = filtered.map(m => \`
        <div class="card \${m.id === currentModel ? 'active' : ''}" onclick="switchTo('\${m.id}')">
            <div class="card-name">\${m.name}</div>
            <div class="card-desc">\${m.desc}</div>
            <div class="tags">\${m.tags.map(t => '<span class="tag '+t+'">'+t+'</span>').join('')}</div>
        </div>
    \`).join('');
}

async function switchTo(modelId) {
    if (modelId === currentModel) return;
    try {
        const res = await fetch('/api/switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: modelId })
        });
        const data = await res.json();
        if (data.ok) {
            currentModel = modelId;
            document.getElementById('currentName').textContent = models.find(m => m.id === currentModel)?.name || currentModel;
            document.getElementById('currentId').textContent = currentModel;
            render();
            showToast('✓ Switched to ' + models.find(m => m.id === modelId)?.name + ' — takes effect immediately');
        } else {
            showToast(data.error || 'Switch failed', true);
        }
    } catch (e) {
        showToast('Network error: ' + e.message, true);
    }
}

function showToast(msg, isError) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    setTimeout(() => t.className = 'toast', 2500);
}

load();
</script>
</body>
</html>`;

function convertRequest(responsesBody) {
    const chatBody = { ...responsesBody };
    const hasWebSearchTool = Array.isArray(chatBody.tools) && chatBody.tools.some(
        t => t && (t.type === 'web_search' || t.type === 'web_search_preview')
    );

    if (chatBody.input && Array.isArray(chatBody.input)) {
        const messages = [];
        for (const item of chatBody.input) {
            if (item.type === 'function_call_output') {
                messages.push({
                    role: 'tool',
                    tool_call_id: item.call_id,
                    content: item.output || ''
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
            if (item.role === 'system' || item.role === 'user' || item.role === 'assistant') {
                const msg = { role: item.role };
                if (typeof item.content === 'string') {
                    msg.content = item.content;
                } else if (Array.isArray(item.content)) {
                    const textParts = [];
                    const imageParts = [];
                    for (const c of item.content) {
                        if (c.type === 'input_text' || c.type === 'output_text') {
                            textParts.push(c.text);
                        } else if (c.type === 'input_image') {
                            const imgUrl = c.image_url || (c.source && c.source.url) || '';
                            if (imgUrl) {
                                imageParts.push({ type: 'image_url', image_url: { url: imgUrl } });
                            }
                        } else if (c.type === 'output_image') {
                            const imgUrl = c.image_url || (c.source && c.source.url) || '';
                            if (imgUrl) {
                                imageParts.push({ type: 'image_url', image_url: { url: imgUrl } });
                            }
                        }
                    }
                    if (imageParts.length === 0) {
                        msg.content = textParts.join('');
                    } else {
                        const parts = [];
                        if (textParts.length > 0) {
                            parts.push({ type: 'text', text: textParts.join('') });
                        }
                        parts.push(...imageParts);
                        msg.content = parts;
                    }
                }
                if (item.tool_calls) {
                    msg.tool_calls = item.tool_calls;
                }
                if (item.tool_call_id) {
                    msg.tool_call_id = item.tool_call_id;
                }
                messages.push(msg);
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
        chatBody.tools = chatBody.tools
            .map(t => {
                if (t.type === 'function') {
                    if (t.function) return t;
                    const { type, ...rest } = t;
                    return { type: 'function', function: rest };
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
                log('Warning: dropped unsupported tool type:', t.type);
                return null;
            })
            .filter(Boolean);
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
        output.push({
            type: 'function_call',
            id: responseId + '_fc_' + (tc.index || 0),
            call_id: tc.id || '',
            name: tc.name || '',
            arguments: tc.arguments || '',
            status: 'completed'
        });
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
        seq: 0
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

    const workingChatBody = JSON.parse(JSON.stringify(chatBody));
    workingChatBody.stream = true;
    workingChatBody.messages = Array.isArray(workingChatBody.messages) ? workingChatBody.messages : [];

    const firstRoundResult = await streamSingleRound(res, workingChatBody, tempState, 0);
    log('STREAM_MAIN: firstRoundResult=' + (firstRoundResult ? ('wsCalls=' + firstRoundResult.webSearchCalls.length + ', seEvents=' + firstRoundResult.searchEvents.length) : 'null'));
    if (!firstRoundResult) {
        log('STREAM_MAIN: first round returned null (external tool calls), finishing');
        await finishSseIfOpen(res);
        return;
    }

    if (firstRoundResult.webSearchCalls.length === 0) {
        log('STREAM_MAIN: no web search calls, finishing. contentItemAdded was in streamSingleRound');
        await finishSseIfOpen(res);
        return;
    }

    tempState.searchEvents = firstRoundResult.searchEvents;
    const updatedBody = firstRoundResult.updatedChatBody;

    const savedRP = tempState.reasoningParts.length;
    const savedSE = tempState.searchEvents.length;
    const savedAT = tempState.answerText;

    const heartbeat = setInterval(() => {
        try {
            if (res.writable && !res.destroyed) {
                res.write(': heartbeat\n\n');
            }
        } catch (e) {}
    }, 3000);

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
                item: { id: itemId, type: 'function_call', name: tc.name, call_id: tc.id, arguments: tc.arguments, status: 'in_progress' },
                output_index: fcIdx,
                sequence_number: tempState.seq++
            }));
            await writeSseLine(res, JSON.stringify({
                type: 'response.function_call_arguments.done',
                arguments: tc.arguments,
                item_id: itemId,
                output_index: fcIdx,
                sequence_number: tempState.seq++
            }));
            await writeSseLine(res, JSON.stringify({
                type: 'response.output_item.done',
                item: { id: itemId, type: 'function_call', name: tc.name, call_id: tc.id, arguments: tc.arguments, status: 'completed' },
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
    await new Promise((r, rj) => res.write('data: [DONE]\n\n', e => e ? rj(e) : r()));
}

function finishSseIfOpen(res) {
    if (res && !res.writableEnded) {
        try { res.end(); } catch (e) {}
    }
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
        response.on('error', reject);
    });
}

async function streamSingleRound(res, chatBody, state, roundIndex) {
    const bodyStr = JSON.stringify(chatBody);
    const result = await forwardRequestWithRetry(null, bodyStr);
    const response = result.response;
    const statusCode = response.statusCode || 200;

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
                item: { id: itemId, type: 'function_call', name: tc.name, call_id: tc.id, arguments: tc.arguments, status: 'in_progress' },
                output_index: fcIndex,
                sequence_number: state.seq++
            }));
            await writeSseLine(res, JSON.stringify({
                type: 'response.function_call_arguments.done',
                arguments: tc.arguments,
                item_id: itemId,
                output_index: fcIndex,
                sequence_number: state.seq++
            }));
            await writeSseLine(res, JSON.stringify({
                type: 'response.output_item.done',
                item: { id: itemId, type: 'function_call', name: tc.name, call_id: tc.id, arguments: tc.arguments, status: 'completed' },
                output_index: fcIndex,
                sequence_number: state.seq++
            }));
        }
        await writeSseLine(res, JSON.stringify({
            type: 'response.completed',
            response: { id: state.responseId, status: 'completed', output: [] },
            sequence_number: state.seq++
        }));
        await new Promise((r, rj) => res.write('data: [DONE]\n\n', e => e ? rj(e) : r()));
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
        await new Promise((r, rj) => res.write('data: [DONE]\n\n', e => e ? rj(e) : r()));
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

async function writeSseLine(res, line) {
    await new Promise((resolve, reject) => {
        res.write('data: ' + line + '\n\n', (err) => err ? reject(err) : resolve());
    });
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
                    name: item.name,
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

    await new Promise((r, rj) => res.write('data: [DONE]\n\n', e => e ? rj(e) : r()));
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
        output.push({
            type: 'function_call',
            id: (chatResp.id || 'resp_proxy') + '_fc_' + (tc.index || 0),
            call_id: tc.id || '',
            name: fn.name || '',
            arguments: fn.arguments || '',
            status: 'completed'
        });
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
    if (req.method === 'GET' && req.url === '/ui') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(UI_HTML);
        return;
    }

    if (req.method === 'GET' && req.url === '/api/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ current: currentModel, models: MODELS }));
        return;
    }

    if (req.method === 'GET' && req.url === '/api/models/fetch') {
        fetchNvidiaModels().then(models => {
            MODELS = models;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ current: currentModel, models, live: true }));
        }).catch(e => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ current: currentModel, models: MODELS, live: false, error: e.message }));
        });
        return;
    }

    if (req.method === 'POST' && req.url === '/api/switch') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { model } = JSON.parse(body);
                const result = switchModel(model);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    if (req.method === 'POST' && req.url === '/v1/responses') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const responsesBody = JSON.parse(body);
                const chatBody = convertRequest(responsesBody);
                chatBody.model = currentModel;

                if (!isMultimodalModel(currentModel) && Array.isArray(chatBody.messages)) {
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
                        log('Warning: stripped ' + imagesStripped + ' image(s) from request (model ' + currentModel + ' does not support multimodal)');
                    }
                }

                if (isMultimodalModel(currentModel) && Array.isArray(chatBody.messages)) {
                    const maxImages = /llama.*vision/.test(currentModel.toLowerCase()) ? 1 : 1;
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
                log('ChatBody keys:', Object.keys(chatBody).join(','));
                if (DEBUG && responsesBody.stream) {
                    log('ChatBody (truncated):', chatBodyStr.substring(0, 500));
                }

                const isStream = responsesBody.stream === true;

                if (!isStream) {
                    const resp = await resolveHostedResponse(chatBody);
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
                    const errEvent = JSON.stringify({
                        type: 'error',
                        error: {
                            type: 'server_error',
                            code: statusCode === 500 ? 'proxy_error' : ('upstream_' + statusCode),
                            message: statusCode === 500
                                ? streamErr.message
                                : 'NVIDIA NIM returned ' + statusCode + '. The model may be overloaded. Try again or switch models.'
                        }
                    });
                    if (!res.writableEnded) {
                        res.write('data: ' + errEvent + '\n\n');
                        res.write('data: ' + JSON.stringify({
                            type: 'response.completed',
                            response: { id: 'error', status: 'failed', output: [] }
                        }) + '\n\n');
                        res.write('data: [DONE]\n\n');
                        res.end();
                    }
                }

            } catch (e) {
                log('Error:', e.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

proxyServer.listen(PROXY_PORT, '127.0.0.1', () => {
    console.log(`[Proxy] Listening on http://127.0.0.1:${PROXY_PORT}/v1/responses`);
    console.log(`[Proxy] Forwarding to https://${NVIDIA_HOST}/v1/chat/completions`);
    console.log(`[Proxy] Dual bubble + tool calling support`);
});
