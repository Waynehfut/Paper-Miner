# PaperMiner — 架构与协作约定

> 本文件是 Lead 与各模块负责人的共享契约。开始编码前必须通读；如与代码冲突，以本文件 + 现有代码为准，并立即告知 Lead。

## 1. 项目环境

- 项目根目录：`/Users/hao/Documents/dsh/paperminer`
- 目标 Zotero：**10.0.6**（已安装 `/Applications/Zotero.app`，Firefox 140）
- 技术栈：TypeScript + zotero-plugin-template（scaffold/esbuild）+ zotero-plugin-toolkit
- 依赖已安装，**不要执行 `npm install` / `pnpm install`**（npm 缓存权限有问题，且会重新拉取 git 依赖）。需要新依赖先问 Lead。
- 构建 / 类型检查：
  - `HOME=$PWD/.home npx zotero-plugin build`
  - `npx tsc --noEmit`
- 测试（**只有 Lead 会执行**，避免多个 Zotero 实例冲突；模块负责人只写测试、跑 tsc）：
  - `HOME=$PWD/.home npx zotero-plugin test --no-watch`
- 格式化：`npx prettier --write <files>`（不要全仓库跑，避免改动他人文件）。

## 2. 文件所有权（不要修改他人文件）

| 模块                          | 负责人   | 写入范围                                                                                                                                                                                                                                 |
| ----------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 期刊分区 + 撤稿 + 对应 UI     | 负责人 A | `src/modules/journal/**`、`src/modules/retraction/**`、`src/modules/ui/journalSection.ts`、`treeColumn.ts`、`readerBanner.ts`、`contextMenu.ts`、`addon/content/styles/journal.css`、`test/journal*.test.ts`、`test/retraction*.test.ts` |
| AI 服务（正文/摘要/PPT/翻译） | 负责人 B | `src/modules/ai/paperText.ts`、`summary.ts`、`ppt.ts`、`translate.ts`、`prompts.ts`、`src/modules/ai/outline.ts`（可新建）、`addon/content/styles/ai.css`、`test/ai*.test.ts`、`test/ppt*.test.ts`                                       |
| 阅读对话 UI + 划词交互        | 负责人 C | `src/modules/chat/**`、`src/modules/ui/chatPanel.ts`、`selectionPopup.ts`、`addon/content/styles/chat.css`、`test/chat*.test.ts`                                                                                                         |
| 设置界面、i18n、集成、测试    | Lead     | 其余全部（`src/hooks.ts`、`src/modules/plugin.ts`、`src/modules/preferences/**`、`addon/content/preferences.xhtml`、`addon/locale/**`、`src/utils/**`、`test/startup.test.ts` 等）                                                       |

文件内已有 stub（签名 + 注释）。直接实现并替换 body，**保持导出名和签名**；确需改签名先发消息给 Lead。

## 3. 已验证的 Zotero 10 API（可直接用）

- 条目右侧面板区块：`Zotero.ItemPaneManager.registerSection({ paneID, pluginID, header:{l10nID, icon}, sidenav, onInit, onRender, onAsyncRender, onItemChange, onDestroy, sectionButtons })`，`body` 是 `HTMLDivElement`，可直接 append HTML。
- 条目列表列：`Zotero.ItemTreeManager.registerColumns({ pluginID, dataKey, label, dataProvider, renderCell, ... })`；刷新用 `Zotero.ItemTreeManager.refreshColumns()` 或 `Zotero.getActiveZoteroPane()?.itemsView?.refreshAndMaintainSelection(false)`（节流）。
- 阅读器事件（全局注册一次，pluginID = `paperminer@paperminer.org`）：
  - `Zotero.Reader.registerEventListener("renderToolbar", handler, pluginID)` — `handler({reader, doc, append})`
  - `"renderTextSelectionPopup"` — `handler({reader, doc, params:{annotation:{text}}})`，可用 `event.append(node)` 追加按钮
  - `"createAnnotationContextMenu"` — `event.append({label, onCommand})`
  - 取消：`Zotero.Reader.unregisterEventListener(type, handler)`
- 原生撤稿数据：`Zotero.Retractions.isRetracted(item)`、`await Zotero.Retractions.getData(item)`、`Zotero.Retractions.getReasonDescription(reason)`（Zotero 10 已内置 Retraction Watch 数据）。
- PDF 正文：`attachment.attachmentText`（已索引全文，可能为空）；fallback `await Zotero.PDFWorker.getFullText(attachment.id, null, true)` 返回 `{ text }`。
- 文件：全局 `IOUtils`、`PathUtils`（`IOUtils.write/readJSON/writeJSON`、`PathUtils.join`）。已封装在 `src/utils/fs.ts`。
- 打开阅读器：`Zotero.Reader.open(attachmentID, location?, options?)`（异步）。
- 打开设置：`Zotero.Utilities.Internal.openPreferences("paperminer-preference-pane")`。
- 通知/刷新：`Zotero.Notifier.registerObserver(observer, types, id, priority)`；observer 方法 `notify(event, type, ids, extraData)`。

## 4. 共享基础设施（Lead 已实现，直接用）

- `src/types.ts`：`JournalResult`、`RetractionResult`、`PaperContext`、`LLMChatOptions`、`ProgressReporter` 等。
- `src/utils/prefs.ts`：`getPref/setPref`（键名见 `src/modules/preferences/defaults.ts` 与 `addon/prefs.js`）。
- `src/utils/cache.ts`：`pluginCache.get/set/delete/clear`，命名空间 `journal` / `retraction` / `chat`。
- `src/utils/fs.ts`：`getPluginDataDir`、`getDownloadsDir`、`readJSONFile`、`writeJSONFile`、`writeBinaryFile`、`sanitizeFilename`、`launchFile`。
- `src/utils/item.ts`：`getItemDOI`、`getItemPublication`、`getItemMeta`、`findPDFAttachment`、`isPaperItem`、`getRegularItemForReader`。
- `src/utils/html.ts`：`el(doc, tag, props, ...children)`、`zoteroIcon(doc, name)`、`clearChildren`、`escapeHtml`、`debounce`。
- `src/utils/ui.ts`：`toast`、`showProgress`、`copyText`、`openURL`。
- `src/utils/i18n.ts`：`t(key, fallback, args?)`（ftl 缺失时用 fallback；**fallback 直接写中文**）。
- `src/utils/log.ts`：`log/warn/errorToString`。
- `src/utils/styles.ts`：主窗口样式由 hooks 自动注入；阅读器 iframe 内用 `injectStylesIntoDocument(doc)`（异步）注入。
- `src/modules/ai/llm.ts`：**已完成**。`chatCompletion(messages, options)`、`testLLMConnection()`、`LLMError`、`getLLMConfig()`、`isLLMConfigured()`。OpenAI 兼容 SSE，支持 AbortSignal、onDelta、onReasoning。
- `src/modules/ai/presets.ts`：`LLM_PRESETS`、`normalizeChatEndpoint`。

## 5. 交叉模块接口

### B 必须实现（A/C 会调用）

```ts
// src/modules/ai/paperText.ts
getPaperText(item): Promise<{text, attachmentID?, truncated, fullTextLength}>
getPaperContext(item, {maxChars?}): Promise<PaperContext>

// src/modules/ai/summary.ts
generateSummary(item, {force?, onProgress?, language?}): Promise<{noteID, markdown, cached}>
findSummaryNote(item): Promise<Zotero.Item | null>
maybeAutoGenerateSummary(item): Promise<void>
openSummaryNote(item): void

// src/modules/ai/ppt.ts
generatePpt(item, {onProgress?, slideCount?, language?, openAfter?}): Promise<{filePath, slideCount, title}>

// src/modules/ai/translate.ts
translateText(text, {signal?, onDelta?, context?, targetLang?}): Promise<string>
getTranslateTargetLanguage(): string
isTranslationConfigured(): boolean
```

### C 必须实现（A/Lead 会调用）

```ts
// src/modules/ui/chatPanel.ts
registerChatEntryPoints(): void
unregisterChatEntryPoints(): void
openChatPanel(item?, {quotedText?}): Promise<void>
toggleChatPanel(item?): Promise<void>
closeChatPanel(): void
onReaderOpened(reader): Promise<void>
```

### A 必须实现（Lead 集成调用）

已有 stub 的导出名保持不变：`registerJournalSection/unregisterJournalSection/refreshJournalSection`、`registerJournalColumn/unregisterJournalColumn/refreshJournalColumn`、`registerReaderBanner/unregisterReaderBanner/refreshReaderBanner`、`registerContextMenus/unregisterContextMenus`、`getJournalRank/getJournalRankByName/prefetchJournalRanks/clearJournalCache/getJournalCacheStats`、`getRetractionStatus/prefetchRetractions/clearRetractionCache`。

## 6. UI / 视觉约定

- 风格必须融入 Zotero：使用 `addon/content/styles/base.css` 中的 `.pm-*` 类与 CSS 变量（`--pm-text`、`--pm-border`、`--pm-accent` 等），不要另起一套配色；深色模式自动生效。
- 图标优先用 Zotero 内置：`chrome://zotero/skin/16/universal/<name>.svg`（如 `abstract`、`annotate-note`、`page`、`globe`、`book`、`retracted`、`refresh`、`dialog-options`、`cross`）。品牌图标：`chrome://paperminer/content/icons/paperminer.svg`。
- 所有用户可见文本用 `t("key", "中文 fallback")`；ftl 由 Lead 统一维护。
- 按钮/输入框用 `.pm-btn`、`.pm-input`、`.pm-badge` 等基础类；模块私有样式写进自己的 CSS 文件（`journal.css` / `chat.css` / `ai.css`），类名前缀：A `pm-journal-`、B `pm-ai-`、C `pm-chat-`（选择翻译用 `pm-translate-`）。
- 主窗口/阅读器都支持深色模式；不要硬编码白底黑字。

## 7. 测试与验收

- 每个负责人写至少 2 个纯逻辑测试文件到 `test/`（Zotero mocha 环境运行）。可测试：URL 构造、响应解析、缓存 TTL、上下文检索、Markdown 大纲解析、会话序列化、徽章映射。
- 不依赖真实 API Key 的测试必须用 mock 数据。
- 模块完成标准：`npx tsc --noEmit` 通过；导出接口可用；无 `console.log` 调试残留；异常用 `toast`/`onProgress` 友好提示，不抛给用户原始堆栈。
- 完成后向 Lead 发消息：完成了什么、改了什么文件、如何手工验证、遗留问题。

## 8. 协作纪律

- 只改自己范围内的文件；需要改共享文件先发消息给 Lead。
- 不要执行 `git` 提交/回滚；不要删除他人文件。
- 不要同时运行 `zotero-plugin test/serve`（Lead 负责）。
- 遇到 Zotero API 不确定时，优先用 `rg` 查 `/tmp/omni/chrome/content/zotero/`（已解包的 Zotero 10 源码）和 `node_modules/zotero-types`。
- 每完成一个里程碑给 Lead 发一条简短消息，不要等全部做完才说。
