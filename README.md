# Codex NIM Proxy

> 让 Codex 白嫖 NVIDIA 免费顶级模型：DeepSeek V4.1 Flash、GLM-5.3、Kimi K3 一键接入
> Use Codex with NVIDIA's free top-tier models — one-click access

## 这是什么

Codex 是 OpenAI 的编程助手，自带 CLI 和桌面版，但默认只能用 OpenAI 的模型。NVIDIA NIM 免费开放了一批顶级模型，只是 Codex 不认识它的接口格式。

本项目就是中间那层翻译：

```
Codex  →  本地代理（本项目）  →  NVIDIA 免费模型
```

启动它，Codex 就能像用官方模型一样直接选用这些免费模型；关掉它，Codex 完好如初。整个过程不用改配置、不用换账号、不用装任何第三方包。

## 支持的模型

不需要记模型名。代理每次启动都会从 NVIDIA 拉取当前可用的全部模型，直接写进 Codex 的模型列表，你在 Codex 里挑就行。

下面是 2026-09 实测可用的代表性模型：

| 模型 | 适合用来做 |
|------|-----------|
| DeepSeek V4.1 Flash | 日常编码、快速改 bug，响应快 |
| Kimi K3 | 读大项目、长上下文任务 |
| GLM-5.3 / GLM-5.3 Flash | 中文场景友好，推理与 agent 任务 |
| Nemotron 3 Ultra 550B | NVIDIA 旗舰，复杂推理 |
| Nemotron 3 Super 120B | 综合均衡，工具调用稳定 |
| Nemotron 3.5 Lightning 30B | 轻量高速，简单任务够用 |
| Gemma 4 31B | Google 通用模型 |
| Mistral Large 2 | Mistral 旗舰 |
| gpt-oss 20B | OpenAI 开源模型 |
| Llama 3.2 90B Vision | 支持看图，能读截图 |

NVIDIA 会不时上架和下架模型，所以以 Codex 客户端里显示的实时列表为准，本表不保证长期准确。

## 它能做什么

- **免费使用** — 花的是你自己的 NVIDIA 免费额度，不需要订阅
- **模型列表自动更新** — 启动即拉取，不用手动维护
- **工具能力完整** — 改文件、执行命令、联网搜索、调用 MCP 工具和子代理工具都能正常用（CLI 和桌面版均已实测）
- **技能与指令完整传递** — Codex 下发的技能说明会原样交给模型
- **配置自动来回** — 启动时自动接管 Codex 配置，退出时自动还原，不留残留
- **断线自愈** — 网络抖动或服务繁忙时自动重试
- **失效模型自动屏蔽** — NVIDIA 已下架的模型会自动从列表里移除
- **零依赖** — 单个文件、纯 Node.js，不需要 npm install

## 快速开始

前置条件：

- Node.js 18 或以上
- Codex（CLI 或桌面版）已安装
- 一个免费的 NVIDIA NIM API Key

```bash
git clone https://github.com/ClaireMoonlit/codex-nvidia-proxy.git
cd codex-nvidia-proxy

copy .env.example .env      # 然后把你的 NVIDIA_API_KEY 填进 .env
node responses_proxy.cjs
```

Windows 用户也可以直接双击 `start_proxy.bat`。

启动后打开 Codex，在模型选择器里挑一个模型就能开始用（桌面版在模型下拉框里选，CLI 用 `/model`）。

## 关掉它

在启动代理的窗口按 `Ctrl+C` 即可。代理会把 Codex 的配置还原成原样，Codex 回到只使用 OpenAI 官方模型的状态。

## 常见问题

**模型列表里没有刚上架的新模型？**
Codex 只在启动时读一次模型列表，重启 Codex 客户端即可看到。

**提示额度不足或请求被拒？**
通常是这个 NVIDIA 账号的免费额度用完了，换一个 Key 或稍后再试。

**想重新试一个被屏蔽的模型？**
删掉 `model_blacklist.json`，然后重启代理。

**代理关了以后 Codex 变回 OpenAI 了？**
正常，这就是自动还原的效果。

**怎么确认代理真的在工作？**
在 PowerShell 里跑下面这条命令，能看到滚动输出的 `data:` 就说明通了：

```powershell
$body = '{"model":"z-ai/glm-5.3-flash","input":[{"role":"user","content":"Say the single word: pong"}],"stream":true}'
Invoke-WebRequest -Uri http://127.0.0.1:15721/v1/responses -Method POST -Body $body -ContentType "application/json"
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `NVIDIA_API_KEY` | NVIDIA NIM API Key，**必需** | 无 |
| `DEBUG` | 打印详细调试日志，排查问题时设为 `true` | `false` |

## 项目结构

```
codex-nvidia-proxy/
├── responses_proxy.cjs    # 主程序（单文件，零依赖）
├── start_proxy.bat        # Windows 启动脚本
├── .env.example           # API Key 配置模板
├── models.json            # 内置兜底模型列表（拿不到实时列表时才用）
├── model_state.json       # 当前选中的模型（自动生成）
├── model_blacklist.json   # 不可用模型黑名单（自动生成）
├── package.json           # 项目元数据（无外部依赖）
└── LICENSE
```

## 许可

MIT License，详见 [LICENSE](./LICENSE)