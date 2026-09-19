# MarkText 待优化项

来源：用户（FrameCode）原话逐条整理。

**2026-09-12 更新**：按优先级完成一轮修改。每条已标注状态：
✅ 已完成 · ◐ 部分完成 · ✔ 验证后确认无需改动 · ⬜ 未动（原因见条目）。

本轮改动明细见文末「变更记录」。

---

## 1. KaTeX ✅（剪贴板部分）

- KaTeX 已是 `^0.17.0`（`packages/muya/package.json`），含 mhchem 扩展、颜色预处理、AMSCD 预处理；本轮确认无需再升。
- 行内 / 块级公式 → LaTeX 字符串：复制时 `text/plain` 槽位本来就是 markdown 源（含 `$…$` LaTeX）。
- **本轮新增**：MathML 渲染管线 —— `renderMathToMathML()`（KaTeX `output: 'mathml'`）+ marked math 扩展 `mathOutput: 'mathml'` + `getClipBoardHtml` 的 `mathRenderMode` 选项。与第 14 条共用同一条线。

## 2. Source Code 模式仍偏 CodeMirror 5 ◐

- **第二轮落地（键位同步）**：
  - （更正：最初误诊为主进程缺少 format 命令注册并新增了 `main/commands/format.ts`，实际它与既有 `menu/actions/format.ts` 的 `loadFormatCommands` 重复，导致打包版启动抛 "Command already exists"，第三轮已删除。格式化命令一直由 `loadMenuCommands` 正常注册。）
  - Source Code 模式下，同样的格式化快捷键现在会把选区包上对应的 markdown 标记（`**…**`、`*…*`、`~~…~~`、`` `…` ``、`$…$`、`==…==`、`[text]()`、`![img]()`、`<u>/<sup>/<sub>`），多光标选区逐个包裹，`clear` 反向剥离标记。WYSIWYG 与 Source 两种模式同一快捷键产出一致。
  - 列选择：CM5 原生即支持 **Alt+拖拽** 矩形选择（`configureMouse` 默认行为），无需改动，此前是被遗漏的存量能力。
- **第三轮落地（Vim 键位）**：新增偏好 `vimMode`（设置 > 编辑器 > 写作行为），开启后 Source Code 模式启用 CM5 Vim 键位（`keymap/vim` + dialog addon，支持 `/` 搜索与 `:` 命令行），可随时热切换。
- **仍待办**：CM5 → CM6 / Monaco 内核迁移（智能粘贴、Markdown 片段等依赖扩展接口的项在迁移后再做）。

## 3. 预览 ≠ 真所见即所得的小瑕疵 ⬜

- 属 muya 引擎级打磨（光标虚拟态 / hide heading characters），需要具体复现用例与引擎专项；没有可复现 case 时盲改光标逻辑风险大于收益，保持待办。

## 4. 可访问性 / 高对比度 ✅（高对比度主题部分）

- **本轮新增**：`high-contrast` 暗色主题 —— 纯黑底 + 近白文字 + 高可见度焦点环（`--focusColor: #ffc600` 显式高亮），覆盖 UI 主题、Prism 代码高亮、源码模式 CM 表面类、菜单/偏好设置注册、窗口启动背景色防白闪映射、暗色判定（`isDarkThemeId`）与 10 语言文案。
- 注册点全部打通：`assets/themes/{,prismjs/}high-contrast.theme.css` → `themeColor.ts` → `theme.ts addThemeStyle` → `common/theme.ts`（railscasts 成员 + 背景色表）→ 偏好设置主题列表 + 主菜单 Theme 子菜单。
- 剩余：200% 缩放专项核查、屏幕阅读器遍历等仍待办。

## 5. 多窗口 / 分屏 ✅（P0，本轮完成）

> 用户明确表态：**不要做"原生分屏"**。要的是"原生多窗口 + 拖拽重组"。

已按期望行为全部落地（原生 HTML5 Drag&Drop，替换了原 tab 栏上的 dragula）：

1. ✅ 标签页**可拖出窗口外**：拖出所有窗口释放 → 在释放点新建独立窗口并打开该标签（位置取光标点，自动 clamp 到最近显示器工作区）。
2. ✅ 拖到另一窗口**顶栏对应位置**（标签条 / 主进程几何兜底覆盖标题栏区域）→ 合并为该窗口的新标签；拖到文档编辑区不算。
3. ✅ 右键标签页新增 **"在新窗口中打开"**（全部 10 种语言文案已补）。
4. ✅ 反向成立：独立窗口的标签页同样可拖回其他窗口顶栏合并。

实现要点：
- 未保存内容以快照形式随拖拽转移（未保存具名文件走 `restoreUnsavedTabs` 通道，保留未保存状态；已保存文件在目标窗口从磁盘重开；无路径草稿走 untitled 通道）。
- 主进程在 `dragend` 时用光标几何位置统一裁决：被目标窗口收养 / 合并到光标下的编辑器窗口顶栏 / 新建窗口 / 取消（防 drop→dragend 跨进程竞态的兜底）。
- tab 栏内重排序改用同一套 HTML5 DnD（新增 store 动作 `MOVE_TAB_TO_INDEX`），并保留边缘自动滚动与插入位置指示。
- crash-recovery 快照、watcher 注册、最近使用列表均复用现有通道，保持一致。

## 6. 侧栏设计 ◐

- **本轮新增**：文件树文件名过滤 —— 项目树标题下新增过滤输入框（渲染层派生视图，不改动 store 的树数据；文件夹名自身命中时显示整个子树，命中在深层时自动展开路径，Esc 清空，全部不匹配显示空态提示）。10 语言文案已补。
- 虚拟滚动未做（递归组件结构下的净新增，1k+ 文件渲染压力仍在，但过滤已大幅缓解查找/浏览场景）。

## 7. 导出设置项的"持久化" ✅（frontmatter 预设部分）

- 原有 localStorage 持久化保留（`persistence.ts`，含 `export-settings-persist.spec.ts` 钉住）。
- **本轮新增**：按文档 frontmatter 自动套用预设 —— 文档可携带：

  ```markdown
  ---
  export:
    pageSize: A4
    isLandscape: true
    tocTitle: 目录
    showFrontMatter: false
  ---
  ```

  导出对话框打开时，`export:` 段的键值会覆盖全局默认（类型不匹配 / 未知键忽略）。解析器为免依赖的 `frontmatterPreset.ts`，含 4 个单测。

## 8. 设置切换需要重启的部分 ✔（验证无需改动）

- 全量核查结果：语言、主题、sidebar 布局均已即时生效（`SET_USER_PREFERENCE` → `setLanguage` / `broadcast-preferences-changed` → 菜单重建）；唯一标注"需重启"的偏好是 `titleBarStyle`，而 Electron 无法动态改标题栏样式（`windowManager.ts` 内已有注释），属平台限制。无需清理。

## 9. 粘贴 / 拖拽图片的"位置选项" ◐

- `imageInsertAction`（upload / folder / path）三条分支的落地逻辑已齐（`editor.vue#imageAction`）。
- **本轮修复**：渲染端兜底默认值是 `'folder'`，与 schema 默认 `'path'` 不一致，已对齐为 `'path'`。
- 剩余 UX（批量插入提示、per-insert 询问弹层、压缩/缩放）未动。

## 10. 多语言 ◐

- 复核 `showOpenedFiles` 式的大小写问题：全部 10 个语言 camelCase 一致，无残留变体。
- 全量"句子大小写 / 单复数"audit 属逐语言人工审校，本轮未展开。本轮新增文案（`contextMenu.tabs.openInNewWindow`）已同步 10 语言 + `.min.json`。

## 11. CSP / 安全 ✅（PDF offscreen 部分）

- **本轮落地**：PDF 导出改为在专用隐藏 BrowserWindow 中栅格化（`main/utils/offscreenPrint.ts`）—— 渲染端把 `exportStyledHTML` 生成的完整独立文档（KaTeX 字体已 data-URI 内联、图片为绝对 file:// 或 data URI）交给主进程，写入临时文件后由隐藏窗口加载并 `printToPDF`，完成后销毁窗口并清理临时文件。
- 编辑器窗口的 DOM 从此与 PDF 链路完全解耦：沙箱内解析异常不再可能影响主编辑流程；带 60s 超时防挂死。真实"打印"（Ctrl+P 系）仍走原 `webContents.print()` 通道，行为不变。

## 12. 依赖收紧 ✅（CI matrix 部分）

- **本轮新增**：CI matrix（`build.yml` / `release.yml`）补上 `linux-arm64`（`ubuntu-*-arm` runner）与 `macos-universal`，并新增 `build:linux:arm64` / `build:mac:universal` 脚本。
- 注：universal 依赖 electron-builder 对原生模块（keytar / native-keymap）的双架构重建 + lipo，需观察一次 CI 实跑；若失败可先单独摘除该 matrix 项。

## 13. 测试覆盖 ✅（golden file 部分）

- **本轮新增**：
  - `export-combined-cjk-math-table-diagram.spec.ts` —— "中文 + 复杂公式（aligned/cases）+ GFM 表格 + Mermaid + 引用"组合文档，`toMatchFileSnapshot` 固化 golden file（`__snapshots__/combined-cjk-math-table-mermaid.golden.html`），另附结构断言。
  - `math-clipboard.spec.ts`（muya）—— 公式 → MathML 剪贴板回归（含货币 `$` 不误伤、解析失败回退）。
  - `export-frontmatter-preset.spec.ts` —— frontmatter 预设解析。
- docx 引擎 / Pandoc 路径的 e2e 仍偏稀疏，继续待办。

## 14. 复制公式到 Office（Word / Docs 等）✅

- "Copy as Rich Text" 时，若复制内容含公式，`text/html` 槽位改以**独立 MathML**（KaTeX `output:'mathml'`，保留 `<annotation>` 中的 LaTeX 源）渲染 —— Word / Word online 粘贴侧可转换为原生公式对象；`text/plain` 槽位保持 markdown（LaTeX 源）不变。
- 非公式内容零影响（仅当 `$…$` / `\ [` / `\ (` 预检命中才重渲染；货币 `$5 and $ 100` 不会被 math 扩展分词，误检也无副作用）。
- MarkText 内部普通复制（Ctrl+C）行为刻意不变（text/html 仍为空），避免破坏应用内 markdown 粘贴回路。

---

## 优先级

- **P0**：#5 多窗口拖拽重组 —— ✅ 完成
- **P1**：#1 ✅、#7 ✅、#9 ◐、#13 ✅、#14 ✅、#11 ✅ ｜ #2 ◐（键位同步+列选择已落地，CM6 内核迁移待办）、#3 ⬜（需具体复现用例）
- **P2**：#12 ✅、#4 ✅（主题部分）｜ #6 ◐（过滤已落地，虚拟滚动待办）、#10 ◐
- **待评估可行性**：#14 已落地（KaTeX MathML 剪贴板路线，未走 OLE）

> 回归状态：`pnpm typecheck` 通过；desktop 单测 57 文件 789 用例全过、muya 单测 226 文件 1625 用例全过；改动文件 eslint 0 error。Electron 已升至 44.3.0（二进制已验证可运行，原生模块已重编）。

---

## 变更记录（2026-09-12）

**#5 多窗口标签拖拽**
- `packages/desktop/src/renderer/src/components/editorWithTabs/tabs.vue` — HTML5 DnD 重写（替换 dragula）：重排、插入指示、边缘自动滚动、dragstart/dragend 会话、跨窗 drop 收养、上下文菜单事件
- `packages/desktop/src/renderer/src/store/editor.ts` — 新增 `MOVE_TAB_TO_INDEX`
- `packages/desktop/src/renderer/src/contextMenu/tabs/{menuItems,actions,index}.ts` — "在新窗口中打开"菜单项
- `packages/desktop/src/shared/types/files.ts` — `TabTransferData` / `TabDragPayload`
- `packages/desktop/src/shared/types/ipc.ts` — `mt::tab-drag-adopt` / `mt::tab-drag-finished` / `mt::move-tab-to-new-window`
- `packages/desktop/src/main/app/index.ts` — 三个 IPC handler、光标几何裁决、drop 点建窗定位
- `packages/desktop/src/main/windows/editor.ts` — `createWindow` 支持随窗恢复未保存快照
- `packages/desktop/static/locales/*.json`（+`.min.json`）— `contextMenu.tabs.openInNewWindow` ×10 语言

**#14/#1 公式剪贴板**
- `packages/muya/src/utils/katex.ts` — `renderMathToMathML`
- `packages/muya/src/utils/marked/extensions/math.ts` — `mathOutput` 选项
- `packages/muya/src/utils/marked/getClipboardHtml.ts` + `types.ts` — `mathRenderMode`
- `packages/muya/src/clipboard/copyData.ts` — COPY_AS_RICH 分支按需升级 MathML

**#7 导出预设**
- `packages/desktop/src/renderer/src/components/exportSettings/frontmatterPreset.ts`（新）
- `packages/desktop/src/renderer/src/components/exportSettings/index.vue` — showDialog 时套用

**#9 / #12 / #13**
- `packages/desktop/src/renderer/src/store/preferences.ts` — 默认值对齐
- `.github/workflows/{build,release}.yml`、`packages/desktop/package.json` — matrix 与脚本
- 新测试：`export-combined-cjk-math-table-diagram.spec.ts`（含 golden）、`export-frontmatter-preset.spec.ts`、muya `math-clipboard.spec.ts`

**#11 PDF offscreen（第二轮）**
- `packages/desktop/src/main/utils/offscreenPrint.ts`（新）— 隐藏窗口 + 临时文件 + 60s 超时的 `printToPdfOffscreen`
- `packages/desktop/src/main/menu/actions/file.ts` — pdf 分支改走 offscreen（含取消路径清理）
- `packages/desktop/src/renderer/src/components/editorWithTabs/editor.vue` — pdf case 传完整 HTML，不再改写活动 DOM

**#6 文件树过滤（第二轮）**
- `packages/desktop/src/renderer/src/components/sideBar/treeFilter.ts`（新）— 纯函数过滤谓词
- `packages/desktop/src/renderer/src/components/sideBar/tree.vue` — 过滤输入框 + 根层过滤 + 空态
- `packages/desktop/src/renderer/src/components/sideBar/treeFolder.vue` — `filter` prop 递归、自动展开、自命中显示全子树
- locales ×10 — `sideBar.tree.filterFiles` / `sideBar.tree.noMatchingFiles`

**#4 高对比度主题（第二轮）**
- `assets/themes/high-contrast.theme.css` + `assets/themes/prismjs/high-contrast.theme.css`（新）
- `util/themeColor.ts`、`util/theme.ts`、`common/theme.ts`、`prefComponents/theme/config.ts`、`main/menu/templates/theme.ts` — 端到端注册
- locales ×10 — `menu.theme.highContrast`

**#2 键位同步（第二轮）**
- `packages/desktop/src/renderer/src/components/editorWithTabs/editor.vue` — source 模式转发 `cm-format`
- `packages/desktop/src/renderer/src/components/editorWithTabs/sourceCode.vue` — `cm-format` → 多光标感知的 markdown 标记包裹/剥离
- editor.vue 既有缩进风格问题随 `eslint --fix` 清零

---

## 第三轮变更（2026-09-12）：对齐上游 + 对标功能 + Electron 44

**对齐上游（快照 → 上游 0.20.0-rc 线）**
- 移植图片属性 XSS 修复（CWE-79，上游 #4980）：`packages/muya/src/block/base/format.ts` 两处 `updateImage`/`replaceImage` 的属性值经 `escapeHTML` 转义。
- 移植"软换行视为空格"偏好（上游 #4937，#1849）：`softNewlineAsSpace` 偏好全链路（schema/preference.json/store/types/editor.vue 热切换/markdown 偏好 UI）+ muya 侧 CSS-only 渲染（`MU_SOFT_NEWLINE_AS_SPACE` class + `white-space: normal`）+ 导出 HTML 追加窄域覆盖规则 + 上游 10 个单测（softLineBreak / softBreakExportHtml）+ 10 语言文案。
- 核对确认已具备：RTL 导出、原子写入、可执行链接防护、导出设置持久化、PDF 大纲、mhchem。
- 上游参考克隆位于 `D:/codework/_upstream_ref/marktext`（blobless clone），后续同步可用。
- 待后续同步：上游 9 月的 muya 僵尸块防护批次（#5281–#5304）、UNC 路径、CJK 锚点等增量修复（涉及面广，建议整体 rebase 一次）。

**Electron 42 → 44.3.0**
- 两处 `package.json` electron 依赖升至 `~44.3.0`；Electron 44 二进制经 aria2 RPC(6800) 多连接下载并预置 @electron/get 缓存（sha256 校验通过）；`node-abi` 升至 4.35.0（识别 ABI 149）；ced/keytar/native-keymap 已重编；postinstall 全链路验证通过。
- API 适配（Electron 44 主进程 clipboard 改为异步 W3C 风格）：
  - `main/ipc/shell.ts`：`guess-file-path` 改为 `clipboard.read()` 找 `text/uri-list`（旧的 `read('FileNameW')`/`'NSFilenamesPboardType'` 已删除）；`read-text` 走 `await clipboard.readText()`。
  - `main/app/index.ts`：macOS 截屏改为 `screencapture -i <file>` 直写文件（不再经剪贴板，`readImage` 已删除）。

**打包修复（第三轮）**
- 删除与 `menu/actions/format.ts#loadFormatCommands` 重复的 `main/commands/format.ts`（曾致打包版启动抛 "Command with id=\"format.clear-format\" already exists"），`main/commands/index.ts` 恢复为只注册 file/tab 命令，重新打包。

**对标新功能**
- Vim 键位（Source 模式）：偏好 `vimMode` + CM5 `keymap/vim` + dialog addon，见 #2。
- 选区字数统计（上游 #2791）：muya 新增 `Selection.getSelectedText()` / `Muya.getSelectedText()`（单块精确、跨块尽力拼接，含同容器边界去重），`selection-change` 时经 `muyaWordCount` 写入 `editorStore.selectionWordCount`，标题栏新增选区字数徽标（切 tab 自动清零），10 语言文案 `menu.counter.selectedWords`。
- 写作目标：偏好 `writingTarget`（0 = 关闭，设置 > 编辑器 > 写作行为），标题栏字数徽标变为 `123 / 2000` 进度式显示。
- 编辑器编号标题（上游 #1275 的编辑器侧）：偏好 `showHeadingNumbers`（设置 > Markdown > 杂项），CSS counter 纯装饰渲染（`mu-show-heading-numbers` 包裹类 + `h1–h6.mu-atx-heading/mu-setext-heading::before`），不动源码与光标计算。
