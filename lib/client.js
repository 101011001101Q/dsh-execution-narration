/**
 * 执行过程叙述机器翻译 —— Client（浏览器）半边。
 *
 * ## 它做什么
 *
 * 把 Agent 执行过程里「assistant-step」节点中的英文过程叙述（text 块）原位
 * 翻译成中文，复用 DSH 内置的 AssistantNodeView 渲染，因此字体、间距、
 * Markdown、图片、工具记录、推理体（官方 CoT 插件）全部原样保留。
 *
 * ## 为什么用「就地包裹内置渲染器」而不是覆盖 keyed slot
 *
 * `conversation.chat.node` 是按 kind 派发的 keyed slot。若注册第二个
 * `assistant-step` entry 去覆盖它，会遇到两个硬冲突（均已对源码核实）：
 *   1. 内置 entry 已用 `children` 声明了 `conversation.chat.reasoning.body`
 *      与 `conversation.chat.message.images`；SlotCore.register 对「子槽已
 *      被声明」直接抛错，第二个 entry 不能重复声明这些 children。
 *   2. `renderSlot` 只在 entry 声明了 children 时注入 kit；内置
 *      AssistantNodeView 需要它来渲染推理体与图片。没有 children ⇒ 拿不到
 *      可用的 renderSlot ⇒ 委派渲染必然失败。
 *
 * 因此改为：从 `ctx.slots.entries('conversation.chat.node')` 找到内置
 * entry，把它的 `component` 就地替换为我们的包裹组件（闭包保留原组件）。
 * 可行依据（源码核实）：
 *   - SlotCore 的 entry 是普通可变对象，`entries()` 返回同一引用；
 *   - renderer 的 `SessionEntry` 在**每次渲染时**现读 `entry.component`
 *     （dsh-client-ui-renderer/lib/client.js:814）；
 *   - 框架仍按内置 entry 的 children 绑定 renderSlot、按内置 inject 注入
 *     presentation / resolveFilePath / fileMentions，并照旧传入 ownerProps。
 * 框架给包裹组件的 props 与内置渲染器完全一致，只需把 `node` 换成浅克隆
 * （仅替换 text 块的文本），再 `React.createElement(Original, props)` 委派。
 * 官方 CoT 插件注册在 reasoning.body 上的译文仍在链路中，两个插件互不冲突。
 *
 * 用一个「哨兵」entry（独立 key，永不派发）触发一次 slot 版本变更（register
 * 会 markDirty → 微任务 flush → 订阅者重渲染），保证插件在会话已挂载后才
 * 启用时也能立即重渲染出译文。
 *
 * ## 范围判定（结构信号，不看英文句式）
 *
 * 过程叙述与最终回答在 DSH 里是同一种 `assistant-step` / 同一种 `text`
 * 块，没有独立的事件或 part.type。唯一的结构区分是渲染期的
 * `turnProcess.spec.answerStep`（lib/index.js 与交付报告有详述）。判定：
 *   - `answerStep === data.step`        → 最终回答，不自动翻译；
 *   - `data.status === 'running'`      → 正在生成的步骤，可能是最终回答，不自动翻译；
 *   - `groupPart === 'reasoning'`      → 推理分组（官方插件领域），不动；
 *   - `turnProcess.spec == null`       → 拿不到结构信号，绝不静默扩大范围，
 *                                        只提供「翻译本段」手动入口。
 * 其余（已结束、非答案、非推理的步骤）才自动翻译其中的 text 块。
 * 最终回答 / 流式中的步骤始终提供单条手动翻译入口，由用户显式决定。
 * `answerStep` 非持久化、依赖宿主展示策略、极端情况可能误判 —— 已知限制。
 *
 * ## 实时与容错
 *
 * 段落切分（空行 / maxTextChars 硬切）→ 只翻译「完整」段落 → 以精确文本
 * 为键的缓存 + 单飞去重 + 并发上限 3 + 120ms 防抖 → 失败/超时显示原文
 * 并可重试。缓存键是精确文本，旧会话的迟到响应不可能覆盖新内容。
 * 代码块 / 行内代码 / URL / 文件路径用 ASCII 占位符（AATZ<i>ZQ）保护，
 * 译文里占位符缺失即整段回退原文，保证 Markdown、代码块、路径绝不被破坏。
 */

window.__ModuleLoader__.load({
  id: 'dsh-execution-narration',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PKG = 'dsh-execution-narration';
    const BASE = '/plugins/dsh-execution-narration';
    const DEFAULTS = { enabled: true, provider: 'bing', targetLanguage: 'zh' };
    const SAMPLE = 'I have a thorough understanding now. Let me check the client UI structure.';

    // ---- 文案（不额外注册 locale 命名空间，避免多一个硬依赖） ----
    function isZh() {
      const lang = (navigator.language || document.documentElement.lang || '').toLowerCase();
      return lang.indexOf('zh') === 0;
    }
    function L(zh, en) { return isZh() ? zh : en; }

    // ---- 文本分段：借鉴官方 reasoningFragments，分段自带分隔符，join 可精确还原 ----
    function splitFragments(text, running, limit) {
      const out = [];
      if (!text) return out;
      const sep = /\r?\n(?:[\t ]*\r?\n)+/g;
      const push = (chunk, complete) => {
        let rest = chunk;
        while (rest.length > limit) {
          let cut = limit;
          const a = rest.charCodeAt(cut - 1);
          const b = rest.charCodeAt(cut);
          if (a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff) cut -= 1;
          if (cut <= 0) cut = limit;
          out.push({ text: rest.slice(0, cut), complete: true });
          rest = rest.slice(cut);
        }
        if (rest.length > 0) out.push({ text: rest, complete });
      };
      let start = 0;
      let m;
      sep.lastIndex = 0;
      while ((m = sep.exec(text)) !== null) {
        push(text.slice(start, m.index + m[0].length), true);
        start = m.index + m[0].length;
      }
      if (start < text.length) push(text.slice(start), !running);
      return out;
    }

    /** 已是中文 / 英文散文太少的内容不翻，避免重复翻译中文与误伤标识符。 */
    function shouldTranslate(t) {
      let cjk = 0;
      let letters = 0;
      for (const ch of t) {
        const c = ch.codePointAt(0);
        if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) ||
            (c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af)) cjk += 1;
        else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) letters += 1;
      }
      if (letters < 4) return false;
      if (cjk > 0 && cjk / (cjk + letters) > 0.25) return false;
      return true;
    }

    const EXT = 'ts|tsx|js|jsx|mjs|cjs|json|md|mdx|py|yml|yaml|css|scss|html|htm|svg|' +
      'png|jpg|jpeg|gif|webp|pdf|zip|tar|gz|rs|go|java|c|h|cpp|hpp|cs|sh|ps1|bat|' +
      'toml|ini|lock|log|txt|sql|so|dll|exe|bin|wasm|vue|svelte|rb|php|kt|swift|xml';
    const PROTECT = new RegExp(
      '```[\\s\\S]*?```|~~~[\\s\\S]*?~~~|`[^`\\r\\n]*`|https?:\\/\\/[^\\s<>()"\']+' +
      '|(?:[A-Za-z]:\\\\)?[\\w@./\\\\-]+\\.(?:' + EXT + ')\\b|@[\\w-]+\\/[\\w@./-]+',
      'g'
    );

    function protect(text) {
      const tokens = [];
      // 占位符必须是「Bing/Google 不会改写」的纯 ASCII 字母数字串。
      // 曾用 \uE000<i>\uE001（私用区字符）：实测 Bing 会把它变成
      // 「␀ 0 ␀」/「“这个 0 ”」等乱码，导致 restore 判定占位符缺失、
      // 整段回退原文 —— 而 Agent 叙述里几乎必然含路径/行内代码，等于
      // 大部分段落都翻不出来。AATZ<i>ZQ 实测在段首/段中/相邻/6 个 token
      // 的场景下都能原样穿过 Bing；大小写敏感匹配仍要求它逐字保留。
      const masked = text.replace(PROTECT, (match) => {
        const i = tokens.length;
        tokens.push(match);
        return 'AATZ' + i + 'ZQ';
      });
      return { masked, tokens };
    }

    /** 占位符在译文里缺失 => 判定第三方破坏了结构 => 整段回退原文。 */
    function restore(translated, tokens) {
      if (tokens.length === 0) return translated;
      let out = translated;
      for (let i = 0; i < tokens.length; i += 1) {
        const ph = 'AATZ' + i + 'ZQ';
        if (out.indexOf(ph) === -1) return null;
        out = out.replace(ph, () => tokens[i]);
      }
      return out;
    }

    function resolveTarget(pref) {
      if (pref && pref !== 'auto') return pref;
      const lang = (navigator.language || document.documentElement.lang || 'zh').toLowerCase();
      if (lang.indexOf('zh') === 0) return 'zh';
      if (lang.indexOf('ja') === 0) return 'ja';
      if (lang.indexOf('ko') === 0) return 'ko';
      if (lang.indexOf('fr') === 0) return 'fr';
      if (lang.indexOf('de') === 0) return 'de';
      if (lang.indexOf('ru') === 0) return 'ru';
      return 'en';
    }

    // ---- 翻译引擎：精确文本键缓存 / 单飞 / 并发 / 防抖 / 超时 / 失败回退 ----
    function createEngine() {
      const cache = new Map();       // 精确文本 -> 译文
      const failed = new Set();      // 精确文本 -> 失败（显示原文，可重试）
      const pending = new Set();     // 精确文本 -> 排队或在途（单飞）
      const timers = new Map();      // 精确文本 -> 防抖定时器
      const inFlight = new Map();    // 精确文本 -> AbortController
      const owners = new Map();      // 精确文本 -> 持有该请求的 AbortSignal 集合
      const cancelled = new Set();   // 被主动取消的 controller（不计为失败）
      const listeners = new Set();   // useSyncExternalStore 订阅者
      const queue = [];              // [{ text, sessionId }]
      let active = 0;
      const MAX_CONCURRENT = 3;
      const DEBOUNCE_MS = 120;
      const TIMEOUT_MS = 15000;
      let version = 0;
      let disposed = false;
      let settings = { enabled: true, provider: 'bing', targetLanguage: 'zh', available: true, maxTextChars: 4000 };

      const emit = () => { version += 1; for (const fn of Array.from(listeners)) { try { fn(); } catch (_) {} } };
      const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
      const getVersion = () => version;
      const get = (text) => cache.get(text);
      const hasFailed = (text) => failed.has(text);
      const getSettings = () => settings;
      const getMaxTextChars = () => settings.maxTextChars;
      const setSettings = (next) => {
        settings = {
          enabled: next.enabled !== false,
          provider: next.provider === 'google' ? 'google' : 'bing',
          targetLanguage: next.targetLanguage === 'auto' ? 'auto' : 'zh',
          available: next.available !== false,
          maxTextChars: typeof next.maxTextChars === 'number' ? next.maxTextChars : 4000,
        };
        emit();
      };

      /** 登记「订阅者信号」；该文本所有订阅者失效（卸载 / 切会话）时取消请求。 */
      function addOwner(text, signal) {
        if (!signal) return;
        let set = owners.get(text);
        if (!set) { set = new Set(); owners.set(text, set); }
        if (set.has(signal)) return;
        set.add(signal);
        const onAbort = () => {
          set.delete(signal);
          if (set.size === 0 && owners.get(text) === set) {
            owners.delete(text);
            drop(text);
          }
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      /** 取消某文本所有尚未完成的排队 / 在途工作（不计为失败）。 */
      function drop(text) {
        const timer = timers.get(text);
        if (timer) { clearTimeout(timer); timers.delete(text); }
        for (let i = queue.length - 1; i >= 0; i -= 1) {
          if (queue[i].text === text) queue.splice(i, 1);
        }
        const ac = inFlight.get(text);
        if (ac) { cancelled.add(ac); ac.abort(); }
        else pending.delete(text);
      }

      async function run(text, sessionId) {
        const ac = new AbortController();
        inFlight.set(text, ac);
        const timeout = setTimeout(() => ac.abort(), TIMEOUT_MS);
        try {
          const { masked, tokens } = protect(text);
          const res = await fetch(BASE + '/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: masked,
              targetLanguage: resolveTarget(settings.targetLanguage),
              provider: settings.provider,
              sessionId: sessionId || undefined,
            }),
            signal: ac.signal,
          });
          const json = await res.json();
          if (!json.ok || typeof json.text !== 'string') throw new Error(json.error || 'translate failed');
          const out = restore(json.text, tokens);
          if (out === null) throw new Error('protected tokens lost');
          cache.set(text, out);
          failed.delete(text);
        } catch (error) {
          // 静默取消（卸载 / 切会话）不计为失败；超时 / 网络错误才显示原文且可重试。
          if (!disposed && !cancelled.has(ac)) failed.add(text);
        } finally {
          cancelled.delete(ac);
          clearTimeout(timeout);
          inFlight.delete(text);
          pending.delete(text);
          owners.delete(text);
          active -= 1;
          emit();
          pump();
        }
      }

      function pump() {
        if (disposed) return;
        while (active < MAX_CONCURRENT && queue.length > 0) {
          const job = queue.shift();
          if (pending.has(job.text) || cache.has(job.text) || failed.has(job.text)) continue;
          pending.add(job.text);
          active += 1;
          run(job.text, job.sessionId);
        }
      }

      function enqueue(text, sessionId) {
        if (disposed || cache.has(text) || failed.has(text) || pending.has(text)) return;
        if (!settings.available) return; // 服务不可用：显示原文，不置失败
        queue.push({ text, sessionId });
        pump();
      }

      function request(text, sessionId, signal) {
        if (disposed) return;
        // 即使已缓存 / 在途也登记订阅者：同一文本被多个节点持有时，
        // 任何一个节点卸载都不能把仍然可见的请求误取消。
        addOwner(text, signal);
        if (cache.has(text) || failed.has(text) || pending.has(text)) return;
        // 防抖「只登记一次」：流式逐 token 反复 render 不重置定时器，
        // 稳定段落仍会在 DEBOUNCE_MS 后发出（不会无限推迟）。
        if (timers.has(text)) return;
        timers.set(text, setTimeout(() => {
          timers.delete(text);
          enqueue(text, sessionId);
        }, DEBOUNCE_MS));
      }

      function retry(texts, signal) {
        for (const text of texts) {
          failed.delete(text);
          const prev = timers.get(text);
          if (prev) clearTimeout(prev);
          timers.delete(text);
          addOwner(text, signal);
          enqueue(text, null);
        }
      }

      function dispose() {
        disposed = true;
        for (const ac of inFlight.values()) { try { ac.abort(); } catch (_) {} }
        inFlight.clear();
        for (const t of timers.values()) clearTimeout(t);
        timers.clear();
        queue.length = 0;
        owners.clear();
        cancelled.clear();
        listeners.clear();
      }

      return {
        subscribe, getVersion, get, hasFailed, getSettings, setSettings,
        getMaxTextChars, request, retry, dispose,
      };
    }

    const engine = createEngine();

    // ---- 一个小工具条：无边框、无背景卡片、不新增聊天消息 ----
    const BAR_STYLE = {
      display: 'flex', alignItems: 'center', gap: '8px',
      minHeight: '20px', margin: '2px 0', fontSize: '12px',
      lineHeight: '18px', opacity: '0.75', userSelect: 'none',
    };
    const BTN_STYLE = {
      background: 'none', border: 'none', padding: 0, margin: 0,
      font: 'inherit', fontSize: 'inherit', lineHeight: 'inherit',
      color: 'var(--dsw-alias-label-link, inherit)',
      cursor: 'pointer', textDecoration: 'none',
    };

    function Toolbar({ showOriginal, onToggle, failed, onRetry, manual, onManual }) {
      const buttons = [];
      if (manual) {
        buttons.push(h('button', { key: 'm', type: 'button', style: BTN_STYLE, onClick: onManual },
          L('翻译本段', 'Translate this step')));
      } else {
        buttons.push(h('button', { key: 't', type: 'button', style: BTN_STYLE, onClick: onToggle },
          showOriginal ? L('查看译文', 'Show translation') : L('查看原文', 'Show original')));
        if (failed) {
          buttons.push(h('button', { key: 'r', type: 'button', style: BTN_STYLE, onClick: onRetry },
            L('重试', 'Retry')));
        }
      }
      return h('div', { style: BAR_STYLE, 'data-execution-narration': 'toolbar' }, buttons);
    }

    // ---- 包裹内置 AssistantNodeView ----
    // 工厂：为每个被包裹 entry 生成「闭包绑定原组件」的包裹组件，
    // 不用共享可变 holder，HMR / 多 entry 场景不会串味。__aatOriginal
    // 指向真正的内置组件，便于 HMR 时先解包再重包（避免二次包裹）。
    function makeWrapped(Original) {
      function WrappedAssistantView(props) {
        const node = props.node;
        const data = (node && node.data) || {};
        const blocks = Array.isArray(data.blocks) ? data.blocks : [];

        const spec = props.turnProcess && props.turnProcess.spec;
        const isAnswer = spec && spec.answerStep != null && data.step === spec.answerStep;
        const isRunning = data.status === 'running';
        const isReasoningGroup = props.groupPart === 'reasoning';
        // 拿不到结构信号时不自动翻译，只给手动入口（不静默扩大范围）。
        const canAuto = !!spec && !isAnswer && !isRunning && !isReasoningGroup;

        const [manual, setManual] = React.useState(false);
        const [showOriginal, setShowOriginal] = React.useState(false);
        const version = React.useSyncExternalStore(engine.subscribe, engine.getVersion);
        // 卸载 / 会话切换时取消本节点持有的请求；精确文本键缓存不串会话。
        const ownerSignal = React.useMemo(() => {
          const ac = new AbortController();
          return ac;
        }, [props.sessionId]);
        React.useEffect(() => () => ownerSignal.abort(), [ownerSignal]);

        const settings = engine.getSettings();
        const enabled = settings.enabled;
        // enabled=false 时仍允许手动「翻译本段」，只是不自动翻译。
        const autoActive = canAuto && enabled;
        const active = autoActive || manual;

        const plans = React.useMemo(() => blocks.map((b, i) => {
          if (!b || b.kind !== 'text' || typeof b.text !== 'string') return null;
          const running = isRunning && i === blocks.length - 1;
          const frags = splitFragments(b.text, running, engine.getMaxTextChars());
          return frags.map((f) => ({ text: f.text, complete: f.complete, skip: !shouldTranslate(f.text) }));
        }), [blocks, isRunning, version]);

        const allTexts = React.useMemo(() => {
          const out = [];
          for (const plan of plans) if (plan) for (const f of plan) if (!f.skip) out.push(f.text);
          return out;
        }, [plans]);

        React.useEffect(() => {
          if (!active || isReasoningGroup) return;
          for (const plan of plans) {
            if (!plan) continue;
            for (const f of plan) {
              // 只翻「完整」段落；未完成的文本继续显示原文。
              if (f.complete && !f.skip) engine.request(f.text, props.sessionId, ownerSignal.signal);
            }
          }
        }, [active, plans, props.sessionId, ownerSignal]);

        const anyFailed = React.useMemo(
          () => allTexts.some((t) => engine.hasFailed(t)),
          [allTexts, version]
        );
        // groupPart==="reasoning" 时内置 AssistantMarkdown 会跳过全部 text 块
        // （只渲染 reasoning 体，由官方 CoT 插件负责）。此时没有任何可译文本
        // 会显示，直接委派、连工具条也不渲染，避免留下无意义的悬浮按钮。
        const hasTranslatable = allTexts.length > 0 && !isReasoningGroup;
        // 失败片段回原文、成功片段显示译文，避免「一处失败整段回退」。
        const effectiveShowOriginal = showOriginal;

        let newBlocks = blocks;
        if (active && hasTranslatable && !isReasoningGroup && !effectiveShowOriginal) {
          let changed = false;
          newBlocks = blocks.map((b, i) => {
            const plan = plans[i];
            if (!b || b.kind !== 'text' || !plan) return b;
            const text = plan.map((f) => (f.skip ? f.text : (engine.get(f.text) || f.text))).join('');
            if (text === b.text) return b;
            changed = true;
            return { ...b, text };
          });
          if (!changed) newBlocks = blocks;
        }

        const translatedNode = newBlocks === blocks
          ? node
          : { ...node, data: { ...data, blocks: newBlocks } };
        const builtin = h(Original, { ...props, node: translatedNode });

        // 只显示一条小工具条；失败时给出「重试」与「查看原文」。
        if (!hasTranslatable) return builtin;
        return h(React.Fragment, null,
          h(Toolbar, {
            showOriginal: effectiveShowOriginal || anyFailed,
            onToggle: () => setShowOriginal((v) => !v),
            failed: anyFailed,
            onRetry: () => engine.retry(allTexts, ownerSignal.signal),
            // 禁用自动翻译、拿不到结构信号、或者是最终回答 / 流式步骤时，
            // 只给显式的「翻译本段」手动入口，绝不静默扩大范围。
            manual: (!canAuto || !enabled) && !manual,
            onManual: () => setManual(true),
          }),
          builtin
        );
      }
      WrappedAssistantView.__aatOriginal = Original;
      return WrappedAssistantView;
    }

    // ---- 插件详情页设置卡片 ----
    const CARD = {
      display: 'flex', flexDirection: 'column', gap: '12px',
      fontSize: '13px', lineHeight: '1.6',
      color: 'var(--dsw-alias-label-primary, inherit)',
    };
    const NOTICE = {
      padding: '10px 12px', borderRadius: '6px',
      background: 'var(--dsw-alias-markdown-code-block, rgba(127,127,127,0.08))',
      borderLeft: '3px solid var(--dsw-alias-state-warning-primary, #d89614)',
      fontSize: '12px', lineHeight: '1.7',
    };
    const ROW = { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' };
    const LABEL = { minWidth: '96px', opacity: '0.85' };
    const SELECT = {
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary, inherit)',
      border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
      borderRadius: '4px', padding: '3px 6px', fontSize: '12px',
    };
    const BTN = {
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary, inherit)',
      border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
      borderRadius: '4px', padding: '4px 10px', cursor: 'pointer', fontSize: '12px',
    };

    function SettingsCard() {
      const [state, setState] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [test, setTest] = React.useState('');

      React.useEffect(() => {
        const ac = new AbortController();
        fetch(BASE + '/state', { signal: ac.signal })
          .then((r) => r.json())
          .then((s) => { engine.setSettings(s); setState(s); })
          .catch((e) => { if (!ac.signal.aborted) setError(String(e)); });
        return () => ac.abort();
      }, []);

      async function save(next) {
        setBusy(true);
        setError('');
        try {
          const r = await fetch(BASE + '/config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(next),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || 'save failed');
          const s = { ...(state || {}), ...next };
          engine.setSettings(s);
          setState(s);
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy(false);
        }
      }

      async function runTest() {
        setTest(L('请求中…', 'Requesting…'));
        try {
          const r = await fetch(BASE + '/translate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: SAMPLE, targetLanguage: 'zh', provider: (state && state.provider) || 'bing' }),
          });
          const j = await r.json();
          setTest(j.ok ? j.text : L('失败：', 'Failed: ') + (j.error || ''));
        } catch (e) {
          setTest(L('失败：', 'Failed: ') + String(e.message || e));
        }
      }

      const cur = state || { ...DEFAULTS, available: true, maxTextChars: 4000 };
      return h('div', { style: CARD, 'data-execution-narration': 'settings' },
        h('div', { style: NOTICE, role: 'note' },
          L('隐私提示：待翻译文本将被发送给第三方翻译服务（Bing 免费匿名端点），可能包含项目代码、文件内容或其他私有信息。启用即表示你已知悉。',
            'Privacy: text to be translated is sent to a third-party translation service (Bing anonymous endpoint) and may contain project code, file contents, or other private information. Enabling acknowledges this.')),
        h('div', { style: ROW },
          h('span', { style: LABEL }, L('自动翻译', 'Auto translate')),
          h('input', {
            type: 'checkbox', disabled: busy || !state,
            checked: cur.enabled !== false,
            onChange: (e) => save({ ...cur, enabled: e.target.checked }),
          }),
          h('span', { style: { opacity: 0.65, fontSize: '12px' } },
            cur.enabled !== false
              ? L('已启用：英文过程叙述自动显示为简体中文', 'On: English narration is shown in Chinese')
              : L('已关闭：显示全部原文（仍可单条手动翻译）', 'Off: original only (manual translate still available)'))),
        h('div', { style: ROW },
          h('span', { style: LABEL }, L('翻译服务', 'Service')),
          h('select', {
            style: SELECT, disabled: busy || !state, value: cur.provider || 'bing',
            onChange: (e) => save({ ...cur, provider: e.target.value }),
          },
            h('option', { value: 'bing' }, 'Bing · ' + L('免费匿名（默认）', 'free anonymous (default)')),
            h('option', { value: 'google' }, 'Google · ' + L('免费匿名', 'free anonymous')))),
        h('div', { style: ROW },
          h('span', { style: LABEL }, L('目标语言', 'Target language')),
          h('select', {
            style: SELECT, disabled: busy || !state, value: cur.targetLanguage || 'zh',
            onChange: (e) => save({ ...cur, targetLanguage: e.target.value }),
          },
            h('option', { value: 'zh' }, L('简体中文 zh（默认）', 'Simplified Chinese zh (default)')),
            h('option', { value: 'auto' }, L('跟随界面语言 auto', 'Follow UI language auto')))),
        h('div', { style: ROW },
          h('button', {
            type: 'button', style: BTN, disabled: busy || !state,
            onClick: () => save({ ...DEFAULTS }),
          }, L('恢复默认设置', 'Restore defaults')),
          h('button', { type: 'button', style: BTN, onClick: runTest }, L('试译一句', 'Test translation')),
          h('span', { style: { opacity: 0.6, fontSize: '12px' } },
            state
              ? (state.available
                  ? L('翻译服务可用', 'Translator available') + ' · ≤' + state.maxTextChars + ' ' + L('字符/段', 'chars/segment')
                  : L('未检测到官方翻译服务，将显示原文', 'Official translator missing; showing original'))
              : L('读取配置中…', 'Loading…'))),
        test ? h('div', { style: { fontSize: '12px', opacity: 0.8 } }, test) : null,
        error ? h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #d03050)' } }, error) : null
      );
    }

    // ---- apply ----
    function apply(ctx) {
      const wrapped = new Map(); // entry -> 原 component

      function findBuiltin() {
        let list;
        try { list = ctx.slots.entries('conversation.chat.node') || []; }
        catch (_) { return null; }
        // entries() 按 priority 升序；找声明了 reasoning.body 的
        // assistant-step entry（内置渲染器），跳过我们自己的包裹产物。
        for (const e of list) {
          if (!e || !e.options || e.options.key !== 'assistant-step') continue;
          if (!e.children || !e.children['conversation.chat.reasoning.body']) continue;
          return e;
        }
        return null;
      }

      function tryWrap() {
        const e = findBuiltin();
        if (!e) return;
        const already = e.component && e.component.__aatOriginal;
        if (already && wrapped.has(e)) return;      // 已是我们生成的包裹组件
        if (wrapped.has(e)) return;                 // 已被本插件包裹（防御）
        const original = already ? e.component.__aatOriginal : e.component;
        wrapped.set(e, original);
        e.component = makeWrapped(original);
      }

      ctx.effect(() => {
        const disposers = [];

        // 插件详情页配置卡片（key = 包名）。
        try {
          disposers.push(ctx.slots.inject('plugins.bundle.config', () =>
            ctx.slots.register(
              { name: 'plugins.bundle.config', key: PKG },
              SettingsCard,
            )));
        } catch (error) {
          console.error('[dsh-execution-narration] 设置卡片注册失败：', error);
        }

        // 注册变化（含 HMR 重注册 / 内置 entry 迟到）时重新包裹。
        try {
          disposers.push(ctx.slots.subscribe('conversation.chat.node', tryWrap));
        } catch (error) {
          console.error('[dsh-execution-narration] 订阅失败：', error);
        }

        // 声明周期内包裹内置渲染器；另注册哨兵触发一次版本变更，
        // 让「会话已挂载后才启用」也能立即重渲染出译文。
        try {
          disposers.push(ctx.slots.inject('conversation.chat.node', () => {
            tryWrap();
            return ctx.slots.register(
              { name: 'conversation.chat.node', key: 'aat-sentinel' },
              () => null,
            );
          }));
        } catch (error) {
          console.error('[dsh-execution-narration] assistant-step 包裹失败：', error);
        }

        // 立即尝试一次（内置 entry 可能已存在）。
        tryWrap();

        return () => {
          // 先还原组件，再释放哨兵（释放会触发重渲染，此时读到的已是原组件）。
          for (const [e, original] of wrapped) {
            try { e.component = original; } catch (_) {}
          }
          wrapped.clear();
          for (const d of disposers) { try { d(); } catch (_) {} }
          engine.dispose();
        };
      });
    }

    return { inject: ['slots'], apply };
  },
});
