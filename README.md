# PaperMiner

[![CI](https://github.com/Waynehfut/Paper-Miner/actions/workflows/ci.yml/badge.svg)](https://github.com/Waynehfut/Paper-Miner/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

**GitHub：[Waynehfut/Paper-Miner](https://github.com/Waynehfut/Paper-Miner) · [问题反馈](https://github.com/Waynehfut/Paper-Miner/issues)**

PaperMiner 是一个面向科研工作者的 Zotero 文献阅读助手：在 Zotero 原生界面里直接查看**期刊分区/预警**，并对选中的论文进行 **AI 阅读对话、AI 摘要、PPT 生成、划词翻译**。

- 无需注册 / 登录 PaperMiner 账号；所有功能由用户自己的 API Key 驱动。
- 所有配置和缓存仅保存在本机 Zotero 数据目录，插件不含任何服务器、不收集遥测。
- 界面遵循 Zotero 原生样式，支持浅色 / 深色模式。

面向 Zotero 7+（在 **Zotero 10.0.6** 上完成开发与自动化测试）。

---

## 功能

| 功能            | 说明                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 期刊分区 / 预警 | 对接 **EasyScholar 开放接口**，在期刊列表列中用颜色区分：中科院分区橙色、SCI/IF 蓝色、中文核心绿色、榜单紫色、开放索引青色、预警红色；条目面板只保留操作按钮，不重复显示标签。  |
| 论文阅读对话    | 在 PDF 阅读器右侧停靠聊天面板，基于论文原文问答；支持流式输出、停止、历史记录、划词引用、建议问题，以及可直接编辑 Markdown 文件的对话技能（每项可设为全局系统规则或单次模板）。 |
| AI 阅读摘要     | 一键（或手动开启「打开 PDF 时自动生成」后）生成结构化中文摘要：研究问题、方法、数据与实验、结论、创新点、局限、启示；保存为条目的子笔记并打标签。自动生成默认关闭。             |
| 生成 PPT        | 依据论文生成 5–30 页可编辑 `.pptx`，支持自定义幻灯片提示词，保存到「下载/PaperMiner」并可自动打开。                                                                             |
| 划词翻译        | 在 PDF 中选中文字后直接在 Zotero 划词菜单内流式显示译文，无需再打开独立弹窗；支持 LLM / DeepL / 有道智云 / 腾讯云机器翻译，以及 Bing / MyMemory 免费接口；可关闭自动翻译。      |
| 无需登录        | 用户只需配置自己的 OpenAI 兼容 API Key（以及可选的 EasyScholar Key / 翻译服务 Key）。                                                                                           |

---

## 安装

### 方式一：安装已构建的 XPI

1. 直接使用本仓库已构建的 [`dist/paper-miner.xpi`](https://github.com/Waynehfut/Paper-Miner/blob/main/dist/paper-miner.xpi)（或从 [Releases](https://github.com/Waynehfut/Paper-Miner/releases) 下载）。
2. Zotero →「工具」→「插件」→ 右上角齿轮 →「Install Add-on From File…」，选择 XPI。
3. 重启 Zotero。

### 方式二：从源码构建

需要 Node.js ≥ 20、npm（已安装依赖时可直接构建）：

```bash
npm install            # 首次
npm run build          # 输出 .scaffold/build/addon + XPI
```

构建产物位于 `.scaffold/build/`（XPI 为 `paper-miner.xpi`）。开发调试见文末「开发」。

---

## 快速配置

安装后打开 **Zotero →「编辑」→「设置」→「PaperMiner」**。

### 1. AI 服务（对话 / 摘要 / PPT / 翻译必需）

1. 选择服务商预设（OpenAI、DeepSeek、Kimi、智谱、通义、SiliconFlow、OpenRouter、Gemini、Claude 或「自定义」；默认是「自定义」，不绑定任何平台）。
2. 填写 **API Key**；Base URL 与模型会随预设自动填充，也可手动修改。
3. 点击 **获取模型列表**，会读取当前 Key 可用的模型并填充到模型下拉列表，可直接选择或手动输入；点击 **测试连接**，看到「连接成功」即可。
4. 「关闭深度思考/推理」是通用开关：目前 DeepSeek、通义千问/DashScope、智谱 GLM、SiliconFlow（Qwen3）会按模型发送对应的关闭参数；不支持的服务商会保持标准请求，不受影响。

> 任意 OpenAI 兼容接口都可用，模型列表通过当前 Base URL + API Key 动态获取。若使用本地模型（Ollama、LM Studio 等），选择「自定义」，Base URL 填例如 `http://127.0.0.1:11434/v1`。

### 2. EasyScholar 期刊分区（可选）

1. 打开 <https://www.easyscholar.cc/> 免费注册并登录。
2. 用户信息 →「开放接口」→ 复制密钥。
3. 粘贴到设置中的 **EasyScholar 密钥**，点击 **检测密钥**（会用 Nature 做一次真实查询），确认有效后勾选想显示的字段（中科院分区、IF、CSSCI/北大核心/CSCD/科技核心、预警等）。

> 中文期刊默认开启 CSSCI、北大核心、CSCD、中国科技核心、卓越行动计划梯队等字段；如果之前安装过旧版本，升级后会自动迁移默认字段设置。

> 不配置 EasyScholar 时，AI 功能仍可正常使用。

### 对话技能（阅读对话）

技能以 **Markdown 文件**保存在：

```
<Zotero 数据目录>/paperminer/skills/
```

每个技能一个 `.md` 文件，格式：

```markdown
---
name: 审稿人视角
global: false
---

请从审稿人的角度指出论文的主要缺陷，并给出修改建议。
```

- `name`：技能名称；
- `global: true`：作为全局系统提示词，每轮对话都发送；`false` 表示单次模板；
- 文件名前的数字（如 `01-`）决定显示顺序；
- 新增 `.md` 文件即新增技能，删除文件即删除技能。

设置页的「对话技能」表格仍可用于快速查看和修改，修改会自动同步到 Markdown 文件；直接编辑文件后，点击「从文件夹重新加载」即可生效。

其他按钮：

- 「打开技能文件夹」：写入当前技能和 `README.md`，并打开目录；
- 「导入技能」：支持 JSON、旧版 `名称 | 提示词` 文本，以及单个 Markdown 技能文件；
- 「导出技能」：保存为 `Downloads/paperminer-skills.json`，便于备份迁移。

### 3. 划词翻译（可选）

- 选中文本后默认自动翻译，并在 Zotero 划词菜单内直接显示译文；关闭「选中文本时自动翻译」后，可在同一菜单里点击「翻译」内联显示。
- 默认复用已配置的 AI 模型（质量好、支持上下文），可在设置中填写「AI 翻译自定义提示词」。
- 也可在设置中选择 **DeepL**（填 API Key）、**有道智云**（填 App Key / App Secret）、**腾讯云机器翻译**（填 SecretId / SecretKey / 地域），或无需密钥的 **Bing 翻译 / MyMemory** 免费接口（可能受频率/额度限制）。

---

## 自动更新

安装包已通过 Zotero 原生 `update_url` 接入 GitHub Release：

- 更新清单：<https://github.com/Waynehfut/Paper-Miner/releases/download/release/update.json>
- Zotero 会在自身的更新检查周期内自动检查；也可手动打开 **工具 → 插件 → 齿轮 → 检查更新**
- 每个新版本只需修改 `package.json` 版本、提交并推送对应 `vX.Y.Z` tag，Release 工作流会构建 XPI、更新 `release/update.json` 并发布 Release

---

## 使用

- **选中文献**：右侧信息栏出现「PaperMiner」区块，展示期刊徽章，以及「AI 摘要 / 阅读对话 / 生成 PPT / 刷新信息」按钮。
- **文献列表**：右键列标题 → 勾选「期刊」列，可查看分区/影响因子/预警。
- **打开 PDF**：阅读器顶部显示期刊预警横幅；工具栏出现 PaperMiner 对话按钮，点击后右侧停靠聊天面板。
- **划词**：在 PDF 中选中文本 → 原生菜单中出现「翻译」「问 AI」；标注右键菜单也支持翻译/询问。
- **条目右键菜单**：右键文献（或 PDF 附件）→「PaperMiner」子菜单：更新期刊分区、生成 AI 摘要、生成汇报 PPT、与论文对话、划词翻译、打开 PaperMiner 设置；支持多选批量更新期刊/摘要/PPT。
- **PDF 页面右键菜单**：在阅读器中右键页面 → PaperMiner 菜单：翻译选中文字、就选中文字提问、生成 AI 阅读摘要、生成汇报 PPT、打开阅读对话、刷新期刊信息。

### 生成的文件位置

- AI 摘要：条目的子笔记（默认标签 `PaperMiner-AI阅读摘要`）。
- PPT：`~/Downloads/PaperMiner/*.pptx`（可在设置中修改目录）。
- 缓存 / 对话记录：`<Zotero 数据目录>/paperminer/`。

---

## 隐私与数据

- API Key 存放在本机 Zotero 配置（`prefs.js`）中，不会上传到任何 PaperMiner 服务器。
- 论文正文只发送给**你配置的**模型服务商 / 翻译服务商；EasyScholar 只接收期刊名，OpenAlex/Crossref 只接收 DOI。
- 插件不包含统计、追踪或远程日志。
- 建议不要在共享电脑上保存 API Key。

---

## 已知限制

- AI 摘要 / PPT 质量取决于所选模型与 PDF 文本可提取性（扫描版 PDF 需先 OCR）。
- 期刊分区以 EasyScholar 数据为准；不同分区体系（JCR / 中科院基础版 / 升级版）可能不同。
- PPT 为文本大纲型演示文稿，不会自动截取论文插图。
- 生成内容由 AI 产生，请自行核对事实与引用。

---

## 开发

```bash
npm install
cp .env.example .env   # 填写 Zotero 可执行文件与开发 profile 路径
npm start              # 启动开发模式（热重载）
npm run build          # 类型检查 + 打包
npm test               # 在 Zotero 内运行 mocha 测试
```

目录结构：

```
src/
  modules/
    ai/          # LLM 客户端、摘要、PPT、翻译、正文提取
    journal/     # EasyScholar 期刊分区
    chat/        # 对话上下文与会话存储
    ui/          # 条目面板、列表列、阅读器横幅、聊天面板、划词交互
    preferences/ # 设置面板
  utils/         # prefs / cache / fs / dom / i18n / styles
addon/           # manifest、bootstrap、XHTML、locale、CSS、图标
```

架构与模块契约见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 致谢

- 基于 [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) 与 [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit)。
- 交互与实现思路参考 [zotero-reference](https://github.com/MuiseDestiny/zotero-reference) 与 [paper-chat-for-zotero](https://github.com/syt2/paper-chat-for-zotero)。
- 期刊数据由 [EasyScholar](https://www.easyscholar.cc/) 提供。

## License

AGPL-3.0-or-later

## Prompt design references

PaperMiner's reading and slide prompts are original, but their structure was informed by current open agent-skill repositories:

- [Ayanami0730/paper-read-skill](https://github.com/Ayanami0730/paper-read-skill) — evidence/claim separation, limitation and reproducibility checklists for deep paper reading (MIT).
- [M1n-n9/academic-ppt-master](https://github.com/M1n-n9/academic-ppt-master) — assertion–evidence slide design, narrative-first planning and academic presentation quality standards (MIT).

The prompts are adapted to PaperMiner's constraints: only the paper content provided by Zotero is available, and no external web search is performed during summary or slide generation.
