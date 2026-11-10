# 执行过程叙述机器翻译

[English](README.en.md) | **简体中文**

[![npm](https://img.shields.io/npm/v/dsh-execution-narration.svg)](https://www.npmjs.com/package/dsh-execution-narration)
[![license](https://img.shields.io/npm/l/dsh-execution-narration.svg)](LICENSE)

一个 DSH 插件：把 Agent 执行任务时写下的英文**过程叙述**（例如读取文件前那句「Let me check…」）**原位**翻译成简体中文。

官方「思考过程和翻译」插件只处理 **Reasoning（思考）** 内容，不覆盖工具调用之间那些普通的英文工作说明。本插件补的就是这段空白，两者可同时启用。

> ⚠️ **隐私提示。** 待翻译文本会发送给第三方翻译服务（默认 Microsoft Bing 免费匿名端点），**可能包含项目代码、文件内容或其他私有信息**。若某个会话不适合外发，请在插件设置里关闭自动翻译。

## 翻译范围

| 翻译 | 不翻译 |
|---|---|
| Agent 的英文过程叙述、计划与阶段性总结 | 最终回答 |
| 读取文件 / 分析代码 / 调研架构前后的自然语言说明 | Reasoning 思考内容（官方插件的职责） |
| 完整的英文段落 | 用户消息、工具记录、运行状态、系统提示 |
| | 文件路径、命令、代码块、技术标识符 |
| | 已经是中文的内容 |

**范围判定靠结构信号，不靠英文句式。** 在 DSH 里，过程叙述与最终回答是同一个 `assistant-step` 节点里同一种 `text` 块——没有独立的事件类型或 part 类型可以把它们区分开。因此本插件用渲染期信号 `turnProcess.spec.answerStep` 排除最终回答：

- `data.step === answerStep` → 最终回答，永不自动翻译；
- `data.status === 'running'` → 仍在生成，可能是最终回答，不自动翻译；
- `groupPart === 'reasoning'` → 推理分组，属官方插件领域；
- `turnProcess.spec == null` → 拿不到结构信号，不做任何自动翻译，只提供单条手动入口。

每一个步骤（包括最终回答与流式步骤）都提供 **「翻译本段」** 手动入口，由用户显式决定。插件绝不静默扩大自己的范围。

## 交互

- 译文**原位替换**原文：不新增聊天消息、不加边框卡片、不弹独立窗口；原有字号、间距、Markdown 与排版保持不变。
- **查看原文 / 查看译文** 可来回切换，切换不会重复请求翻译服务。
- 翻译进行中保留原文，不会闪烁。
- 失败或超时继续显示英文，并出现 **重试** 入口；不影响 Agent 执行。
- 关闭自动翻译后，单条「翻译本段」入口仍然可用。

## 设置

在插件详情页提供：

- 启用 / 禁用自动翻译
- 翻译服务：Bing（默认，免费、无需 API Key）或 Google
- 目标语言：`zh`（默认）或 `auto`（跟随界面语言）
- 恢复默认设置；试译一句以检查连通性

配置通过 DSH 的 `configEditor` 持久化。

## 实现要点

- **复用官方 `ctx.translator` 服务**，不重复造翻译引擎。该服务由内置 `dsh-experimental-cot-translation-bundle` 挂载；本插件不插入重复 row，只在运行时以 `ctx.get('translator')` 软取。服务缺失时退化为显示原文。
- **纯声明式 React，不做 DOM 扫描。** `conversation.chat.node` 是按 kind 派发的 keyed slot，但注册第二个 `assistant-step` entry 走不通：内置 entry 已声明子槽 `conversation.chat.reasoning.body` 与 `conversation.chat.message.images`，第二个 entry 重复声明会直接抛错，而没有 children 的 entry 又拿不到可用的 `renderSlot`。因此本插件改为**就地包裹内置渲染器**：找到 `assistant-step` entry、保留其组件，换成只替换 `text` 块内容、再以 `React.createElement(Original, props)` 委派的包裹组件。内置的 children、inject 与 `renderSlot` 绑定全部存活——这正是官方思考翻译插件能继续工作的原因。
- **流式与性能**：按空行分段（并在服务 `maxTextChars` 处硬切），只发送已完整的段落。引擎带精确文本缓存、单飞去重、120 ms 防抖、并发上限 3、15 s 超时、卸载或切会话即 abort、失败回退原文。
- **代码保护**：围栏代码、行内代码、URL、文件路径与 `@scope/pkg` 在请求前替换为 ASCII 占位符；响应中任一占位符缺失，整段回退原文，保证 Markdown、代码与路径不被破坏。
- **不上游改任何东西**：不改 Session 消息、模型上下文、工具参数或执行结果。
- **译文会落到本机 session 文件**。插件会把 session id 传给宿主翻译服务，宿主因此把每段原文与译文以 `plugin:translator/request` / `plugin:translator/result` 记录写进你自己的 session 文件——这正是「重复打开 Session 不重复请求」的实现方式。它们是对话旁的 plugin 记录，不是对你的消息的改写；但这段文本确实会以明文落在本机磁盘上（与该 session 其余内容一致）。

## 安装

三种方式任选其一。

**① 从 npm 安装**（[npmjs.com/package/dsh-execution-narration](https://www.npmjs.com/package/dsh-execution-narration)）：

```sh
dsh plugin --profile <你的 profile 名> add dsh-execution-narration
```

**② 从插件市场安装**：在 DSH 的插件面板里搜索「执行过程叙述机器翻译」或包名 `dsh-execution-narration`。

**③ 从源码安装**：用插件管理器的 `install_bundle` 指向本目录。

装好后**重启 DSH** 让 Host 半边加载（浏览器半边会热重载），然后在 **插件 → 已安装 → 执行过程叙述机器翻译** 里管理。

## 自动发布（维护者）

本仓库通过 **npm Trusted Publishing（OIDC）** 发布，**不保存任何长期 npm 令牌**。启用一次即可：

1. 在 npmjs.com 打开本包的 **Settings → Trusted Publisher**，选择 GitHub Actions，填：

   | 字段 | 值 |
   |---|---|
   | Organization or user | `101011001101Q` |
   | Repository | `dsh-execution-narration` |
   | Workflow filename | `publish.yml`（只写文件名，不带路径） |
   | Environment | 留空 |

2. 之后发布：改好 `package.json` 的 `version` 并提交 → 在 GitHub 上创建 Release（打 tag `v1.0.2` 之类）→ `.github/workflows/publish.yml` 自动发布。

要求 npm CLI ≥ 11.5.1、Node ≥ 22.14.0（工作流里已自动升级 npm）。发布时会自动附带 provenance 证明。

版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 已知限制

1. `answerStep` 是渲染期信号、非持久化，依赖宿主的展示策略。流式生成或该 turn 没有最终回答时它可能是 `null`——此时插件保守地不做自动翻译。
2. 插件就地替换内置 `assistant-step` 渲染器，因此与**另一个也替换同一条内置 entry** 的插件冲突；官方思考翻译插件不碰它。
3. DSH 升级若改动内置渲染器的 props（`node.data.blocks`、`turnProcess`、`groupPart` 等），本插件可能需要同步更新。
4. Bing / Google 匿名端点的可用性、限速与产出质量不受本插件控制。
5. 实测部分网络下 Google 匿名端点超时，而 Bing 正常——这也是默认选 Bing 的原因。

## 许可

MIT — 见 [LICENSE](LICENSE)。
