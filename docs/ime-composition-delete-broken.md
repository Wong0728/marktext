# 豆包输入法下「能输入、不能删除」问题诊断报告

- **日期**：2026-09-28
- **状态**：根因已定位，**未做任何修复**（本文档仅记录）
- **影响引擎**：`packages/muya`（`@muyajs/core`）
- **触发输入法**：豆包输入法（云端优化型，组字期间 `isComposing` 长时间为 true）
- **采集方式**：新增的独立 Debug 窗口，四轮真实操作录制（JSONL trace）

---

## 1. 结论摘要

用户报告的现象是：**文字能正常打进去，但按删除键删不掉，只能继续写。**

根因是一条完整因果链，**不是单点 bug**：

1. 组合输入期间按 **Enter**，`Content.keydownHandler` 因 `isComposed` 为 true 而**静默跳过** `enterHandler`；
2. `enterHandler` 没有被调用 ⇒ 没有 `event.preventDefault()` ⇒ **浏览器原生 Enter 生效**，在 `contenteditable` 内**克隆出 `span.mu-content` 孤儿节点**；
3. 孤儿节点上没有 `__MUYA_BLOCK__` 反向引用，`TextSelection.getSelection()` 返回 `null`；
4. `Editor._dispatchEvents` 因此执行 `activeContentBlock = null; return;` —— **引擎把自己关闭，且永不恢复**。

第 4 步直接解释了两个现象：

| 现象 | 原因 |
|---|---|
| 能打字 | 文字由 Chromium / 豆包输入法**直接写入 `contenteditable` DOM**，完全不经过 muya |
| 删不掉 | 引擎已退出事件处理，退格**连 `beforeinput` 都不产生**，浏览器层面没有发生任何编辑动作 |

补充：这是一个**曾经修过一半的同类 bug**。muya 自己的测试注释里记录了完全相同的机制（见 §5.3），但当时只修了 ATX 标题一处，且只把崩溃降级为返回 `null`，没有处理"返回 null 之后引擎永久失效"。

---

## 2. 复现步骤

在 Debug 窗口的**右侧「复现面板 · Muya 引擎」**中：

1. 点击 `IME debug line two.` 那一行，让光标进入该段落；
2. 切换到豆包输入法，输入一段中文（例如 `ni'hao` → `你好`）；
3. **在组字尚未结束时（或刚结束时、组合态仍为 true 时）按一次 Enter**；
4. 再输入一段中文；
5. 按退格 / Delete —— 文字不消失；
6. 记录仍在持续增加（因为引擎已死，新文字同样只是浏览器写入 DOM）。

关键变量是第 3 步的 **Enter**。若全程不按 Enter，引擎保持存活。

---

## 3. 实测证据

### 3.1 断点：Enter 前后

```
#74  80529ms  keydown  key=Enter             bail=none               ← 正常
#75  80530ms  beforeinput  inputType=insertParagraph   bail=none
#76  80530ms  input        inputType=insertParagraph   bail=no-block-backlink   ← 崩溃
#77  80530ms  mutation: p.mu-paragraph 内新增 span.mu-content（无标记）
```

- `enterHandler` 第一行即 `event.preventDefault()`，但 `insertParagraph` 仍然发生 ⇒ **`enterHandler` 未被调用**。
- 排查 `keydownHandler` 中 Enter 之前的两个早退点，均可排除：
  - `ui.handleContentKeydown`：命中时它自己会调 `preventDefault`，不可能是元凶；
  - `_wrapSelectionWithAutoPair`：需要非折叠选区，实测 `cursor=2-2` 为折叠。
- 剩余唯一分支即 `isComposed` 门控（§5.1）。

### 3.2 孤儿节点审计

```
audit = {
  totalSpans: 4,
  linked: 3,
  unlinked: 1,
  unlinkedHTML: "<span class=\"mu-content mu-paragraph-content\"
                  contenteditable=\"true\" empty-hint=\"输入 / 插入段落\">
                  <span class=\"mu-plain-text\">为啥不能右移到最右侧这里是手工输入</span>…"
}
```

- 内层 `mu-plain-text` 是 **muya 自己的渲染类**（`packages/muya/src/inlineRenderer/renderer/text.ts:11`），
  证明该 span 是**muya 渲染过的 `mu-content` 的克隆体**，而非输入法凭空构造。
- 一个**非空**段落仍携带 `empty-hint="输入 / 插入段落"`（空段落提示），属性自相矛盾，同样是克隆特征。

### 3.3 引擎死亡后的表现

- `calls: []` —— `inputHandler` / `composeHandler` / `keydownHandler` **一次都未被调用**；
- 14 次 Backspace：`keydown` / `keyup` 均 `defaultPrevented=false`（无人拦截），
  但**零 `beforeinput`、零 `input`、零 DOM mutation**；
- 1227 条记录中 **811 条**处于 `bail=no-block-backlink` 状态，且此后从未恢复。

### 3.4 同源问题：DOM 与 state 失步

整个组字过程 `desync=true`：`state=""` 而 `dom=你好`。

**豆包输入法上屏的文字，从头到尾没有写进 `block.text`。**
这一点可能只是"引擎死亡"的连带后果，也可能是 `Format.inputHandler` 自身的独立门控问题 —— 尚未单独确认（见 §7）。

---

## 4. 相关代码位置

| 作用 | 位置 |
|---|---|
| **全项目唯一**给 DOM 元素打 `__MUYA_BLOCK__` 标记的地方 | `packages/muya/src/block/base/treeNode.ts:111` |
| `mu-content` 容器识别（`findContentDOM` / `isContentDOM`） | `packages/muya/src/selection/dom.ts:5-25` |
| **引擎自停开关** | `packages/muya/src/editor/index.ts:317-320` |
| 孤儿节点导致 `getSelection()` 返回 `null` | `packages/muya/src/selection/TextSelection.ts:172-178` |
| **Enter 的 `isComposed` 门控（根因 A）** | `packages/muya/src/block/base/content.ts:741-744` |
| `keydownHandler`（实例箭头函数字段，非原型方法） | `packages/muya/src/block/base/content.ts:722` |
| `Format.enterHandler`（首行即 `preventDefault`） | `packages/muya/src/block/base/format.ts:1579-1601` |
| `composeHandler`（`compositionend` 时同步 state） | `packages/muya/src/block/base/content.ts:612-621` |
| `Format.inputHandler`（`isComposed` 早退） | `packages/muya/src/block/base/format.ts:596-609` |
| `mu-plain-text` 渲染类定义 | `packages/muya/src/inlineRenderer/renderer/text.ts:11` |

---

## 5. 完整因果链

### 5.1 第一步：组合期间的 Enter 被静默放行

`packages/muya/src/block/base/content.ts:741`

```js
case EVENT_KEYS.Enter:
    if (!this.isComposed)
        this.enterHandler(event);
    break;
```

`isComposed` 为 true 时**什么都不做**——既不拆段，也不 `preventDefault`。

### 5.2 第二步：浏览器克隆出孤儿 span

`Format.enterHandler`（`format.ts:1580`）第一行就是 `event.preventDefault()`。
它没被调用 ⇒ 原生 Enter 生效 ⇒ Chromium 在 `contenteditable` 内分裂/克隆 `span.mu-content` ⇒
克隆体未经 `treeNode.ts:111` 打标记 ⇒ **孤儿节点**。

### 5.3 第三步：引擎永久自杀

`packages/muya/src/editor/index.ts:317`

```js
if (!isSelectionInSameBlock || !anchorBlock) {
    this.activeContentBlock = null;
    return;
}
```

一旦解析失败即置空并 `return`，**此后所有 `input` / `composition*` / `keydown` 事件全部被丢弃，且没有任何恢复路径**。

`TextSelection.ts:174-178` 的注释显示开发者已知此场景：

> An `mu-content` span cloned by the browser's native edit behavior is not linked back to a block.
> Bail out instead of crashing — the caller treats null the same as "no selection".

**当年的修复把「崩溃」降级成了「静默永久失效」，比崩溃更难排查。**

### 5.4 同类 bug 的历史先例

`packages/muya/src/block/content/atxHeadingContent/__tests__/enterHandler.spec.ts:6-14`

> Regression: pressing Enter at the start of an ATX heading … the handler used to forget to call
> `event.preventDefault()`. The browser's default Enter behavior then ran on the contenteditable —
> splitting the heading's `<span class="mu-content">` or **cloning it** — producing **orphan
> `mu-content` nodes that were NOT linked back to a block via `BLOCK_DOM_PROPERTY`**.

即：**同样的机制在标题上已修过，但段落（`Format`）走同一条路，当时没有一并处理。**

---

## 6. 修复建议（本次未实施）

| # | 位置 | 建议改法 | 作用 |
|---|---|---|---|
| **A** | `content.ts:741` | 组合期间的 Enter 也要拦截：仍执行 `event.preventDefault()`，只是不进行拆段 | **断因**，孤儿节点不再产生 |
| **B** | `editor/index.ts:317` | 选区解析失败时**不要**清空 `activeContentBlock`，保留上一个有效 block | **兜底**，把"永久死锁"降级为"可自恢复" |
| **C** | `TextSelection.getSelection()` | 遇到孤儿 `mu-content` 时不直接 `null`，按 DOM 顺序 / 块路径反查并重新绑定标记 | **治标**，让已产生的孤儿能自愈 |

- **A 是根因，必须改。**
- **B 强烈建议同时上**——A 修好后 B 仍能兜住其它未知的克隆路径。
- **C 可作为后续加固**，优先级最低。

改动落在引擎包 `packages/muya`（非 desktop），建议先补回归测试再改，并跑 `pnpm -C packages/muya test` / `typecheck` / `lint`。

---

## 7. 遗留问题

1. **`desync` 是否为独立缺陷**（§3.4）：修复 A/B/C 后需重跑 Debug 窗口确认。若 desync 仍存在，则 `Format.inputHandler`（`format.ts:604-609` 的 `isComposed` 早退）需单独排查。
2. **是否还有其它触发路径**：首轮采集显示豆包输入法**激活按键**（`keydown Alt` / `keydown Unidentified`）之后也会出现同一状态，可能存在第二条触发路径。
3. **孤儿节点是否会累积**：审计中 `totalSpans: 4 / linked: 3 / unlinked: 1`，目前只见一个孤儿，但未验证长时间编辑后是否累积、是否影响保存结果。
4. **`isComposed` 实测值未直接捕获**：受限于探针覆盖范围（`keydownHandler` 是实例属性，早期版本未抓到），该结论目前为**代码推导 + trace 旁证**，非直接实测。A/B 修复后可顺带验证。

---

## 8. 附：本次新增的 Debug 工具

为定位该问题新增了一套独立诊断工具，**已存在于工作区**，与修复无关，可保留或后续移除。

| 文件 | 作用 |
|---|---|
| `packages/desktop/src/renderer/ime-debug.html` | 独立页面入口（双面板 + 事件时间线） |
| `packages/desktop/src/renderer/src/imeDebug/main.ts` | UI 装配、过滤、时间线渲染 |
| `packages/desktop/src/renderer/src/imeDebug/recorder.ts` | 事件录制核心：`getSelection()` 逐条 bail-out 诊断、孤儿节点审计、引擎 handler 探针 |
| `packages/desktop/src/renderer/src/imeDebug/sink.ts` | JSONL 落盘 / 导出 / 复制 |
| `packages/desktop/src/main/imeDebugWindow.ts` | 独立 BrowserWindow（仅 dev） |
| `packages/desktop/src/main/index.ts` | 增加 `MARKTEXT_IME_DEBUG=1` 开关（仅 dev 分支） |
| `packages/desktop/electron.vite.config.ts` | 同一开关下才把调试页纳入构建入口 |

**启动方式**：

```bash
# Windows PowerShell —— 启动并自动打开独立 Debug 窗口
$env:MARKTEXT_IME_DEBUG='1'; pnpm run dev

# 或直接在任意 Chromium 浏览器打开（无 Node 写盘能力，仅能导出）
# http://localhost:5173/ime-debug.html
```

**窗口能力**：

- 左面板：原生 `contenteditable` 基线（对比输入法在无引擎时的行为）
- 右面板：真实 muya 引擎（与编辑器同一条输入路径）
- 逐事件记录 `pre` / `post` / 两帧后的 `settle` 三段快照，标出 `DESYNC` 与 `ENGINE-DISABLED(<bail>)`
- 实时落盘 JSONL；窗口关闭后 trace 仍可用于分析

> 注意：Debug 窗口为 dev-only，放宽了 `contextIsolation` / `sandbox` 以获得 `fs` 写盘能力。
> 其余所有正式窗口仍保持 `contextIsolation: true` + `sandbox: true`。

---

## 9. 重要背景：工作区已有其它未提交改动

排查过程中通过 `git status` 发现，`packages/muya` 下**存在一批先于本次诊断的未提交改动**：

```
 M packages/muya/src/block/base/__tests__/autoPair.spec.ts
 M packages/muya/src/block/base/content.ts
 M packages/muya/src/block/base/format.ts
 M packages/muya/src/clipboard/cut.ts
 M packages/muya/src/editor/index.ts
 M packages/muya/src/history/index.ts
 M packages/muya/src/selection/TextSelection.ts
 M packages/muya/src/selection/index.ts
 M packages/muya/src/ui/paragraphFrontMenu/index.ts
?? packages/muya/src/__tests__/selectionCacheClamp.spec.ts
?? packages/muya/src/block/base/__tests__/deleteHandlerListBoundary.spec.ts
?? packages/muya/src/block/base/__tests__/deletionInlineUpdateGuard.spec.ts
?? packages/muya/src/clipboard/__tests__/cutDeletionConvertGuard.spec.ts
?? packages/muya/src/clipboard/__tests__/cutUndoBoundary.spec.ts
?? packages/muya/src/history/__tests__/historyFirstUndoCaret.spec.ts
```

**这些改动与本问题无关**，处理的是另一组缺陷：

| 改动 | 内容 |
|---|---|
| `TextSelection.ts` | 新增 `_clampOffsetToBlockText`，把越界的缓存 offset 钳回块文本长度 |
| `editor/index.ts` | `queryBlock([...path])` 传副本，避免 `path.shift` 就地消耗缓存的 `anchorPath` |
| `content.ts` | `inputHandler` 中 autoPair 跳过非单字符删除，避免跨区间误配对 |
| `format.ts` / `cut.ts` / `history/index.ts` | 删除→块类型转换保护、剪切与 undo 边界 |

**已确认：这三处改动均未触及本报告诊断出的三个位置**（`content.ts:741-743` 的 Enter 门控、`editor/index.ts:317-320` 的自停开关、`TextSelection.ts:174-178` 的孤儿 bail 三者在工作区中均保持原样，行号已复核）。

**但需要留意**：后续实施 A/B/C 修复时，这三个文件会与上述未提交改动产生**同文件冲突**。建议先把这批既有改动提交或 stash，再动手修复。
