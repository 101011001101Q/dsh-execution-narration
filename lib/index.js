/**
 * 执行过程叙述机器翻译 —— Host 半边。
 *
 * 职责（刻意很薄）：
 *   1. 声明配置 schema（enabled / provider / targetLanguage，live() 守卫兼容
 *      宿主 peer 有无 .volatile() 两种情况；见 Config 处说明），
 *      改设置不重启插件）。
 *   2. 注册三条包私有 HTTP 路由，供浏览器半边调用：
 *        GET  /plugins/dsh-execution-narration/state      当前配置 + 服务能力
 *        POST /plugins/dsh-execution-narration/translate  调官方 ctx.translator
 *        POST /plugins/dsh-execution-narration/config     写配置 / 恢复默认
 *
 * 翻译引擎完全复用宿主内置的官方 `translator` 服务
 * （@deepseek-ai/dsh-experimental-translator，Bing 免费匿名端点，
 *   自带 Session 绑定持久缓存、单飞去重、超时、取消、maxTextChars 限制）。
 * 本插件不实现任何翻译逻辑、不写 Session 原始消息、不改模型上下文。
 *
 * `translator` 用 ctx.get 软取：缺服务时插件照常加载，只是 /state 回报
 * available=false，浏览器半边自动退回"显示原文"，不影响 DSH 其它功能。
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';

const PKG = 'dsh-execution-narration';
const BASE = '/plugins/dsh-execution-narration';

const DEFAULTS = Object.freeze({
  enabled: true,
  provider: 'bing',
  targetLanguage: 'zh',
});

/** 解析宿主 peer `@deepseek-ai/schemastery`（从入口文件与宿主安装目录两处候选解析）。 */
function schemastery() {
  const candidates = [import.meta.url];
  const hermes = process.env.HERMES_HOME ?? join(process.env.LOCALAPPDATA ?? '', 'hermes');
  if (hermes) candidates.push(join(hermes, 'node', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  let lastError;
  for (const base of candidates) {
    try {
      return createRequire(base)('@deepseek-ai/schemastery');
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`无法加载 @deepseek-ai/schemastery：${lastError?.message ?? lastError}`);
}

const z = schemastery();

/**
 * 插件配置。只暴露第一版需要的三个字段；provider 仅列免费匿名端点。
 *
 * `.volatile()` 让字段可原地更新（configEditor.edit 不重启插件）——但它是
 * schemastery 的可选扩展：本机宿主 peer 的 schema 对象**没有** `volatile`
 * 方法（实测 `z.boolean().default(true).volatile === undefined`）。直接调用会
 * 在插件激活时抛「...volatile is not a function」，导致整行 entry 加载失败。
 * 因此用下面的 `live()` 守卫：有就调、没有就原样用。
 * 无论哪种形态，下面的 `valueOf()` 都兼容（`.get()` 投影 或 普通值）。
 */
const live = (schema) => (typeof schema.volatile === 'function' ? schema.volatile() : schema);
export const Config = z.object({
  enabled: live(z.boolean().default(DEFAULTS.enabled)),
  provider: live(z.union(['bing', 'google']).default(DEFAULTS.provider)),
  targetLanguage: live(z.union(['zh', 'auto']).default(DEFAULTS.targetLanguage)),
});

/** 兼容 volatile 投影（config.x.get()）与普通值两种形态。 */
function valueOf(field, fallback) {
  if (field === undefined || field === null) return fallback;
  if (typeof field.get === 'function') {
    const v = field.get();
    return v === undefined ? fallback : v;
  }
  return field;
}

function readConfig(config) {
  return {
    enabled: valueOf(config?.enabled, DEFAULTS.enabled) !== false,
    provider: valueOf(config?.provider, DEFAULTS.provider),
    targetLanguage: valueOf(config?.targetLanguage, DEFAULTS.targetLanguage),
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/** 读一个小的 JSON 请求体（上限 256 KB，容纳 maxTextChars=4000 的正文绰绰有余）。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 256 * 1024) {
        finish(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) return finish(null);
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        finish(null);
      }
    });
    req.on('error', () => finish(null));
  });
}

function buildRoutes(ctx, state, getTranslator) {
  return [
    {
      kind: 'exact',
      path: `${BASE}/state`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        const t = getTranslator();
        return sendJson(res, 200, {
          ...state(),
          available: Boolean(t),
          maxTextChars: typeof t?.maxTextChars === 'number' ? t.maxTextChars : 4000,
        });
      },
    },
    {
      kind: 'exact',
      path: `${BASE}/translate`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        const body = await readJsonBody(req);
        const t = getTranslator();
        const current = state();
        if (!t) return sendJson(res, 503, { ok: false, error: 'translator service unavailable' });
        // 注意：`enabled` 只控制浏览器半边的「自动翻译」。手动「翻译本段」与
        // 设置卡的「试译一句」在关闭自动翻译时仍应可用，因此这里不按 enabled
        // 拒绝请求（关闭自动翻译 ≠ 禁止翻译）。
        if (!body || typeof body.text !== 'string' || body.text.length === 0) {
          return sendJson(res, 400, { ok: false, error: 'invalid request' });
        }

        const limit = typeof t.maxTextChars === 'number' ? t.maxTextChars : 4000;
        if (body.text.length > limit) {
          return sendJson(res, 413, { ok: false, error: 'text exceeds maxTextChars' });
        }

        // 只接受本插件配置允许的值，避免把任意 provider / 语言透传给官方服务。
        const provider = body.provider === 'google' ? 'google' : current.provider === 'google' ? 'google' : 'bing';
        let targetLanguage = typeof body.targetLanguage === 'string' && body.targetLanguage.length <= 16
          ? body.targetLanguage
          : current.targetLanguage;
        if (targetLanguage === 'auto') targetLanguage = 'zh'; // auto 由浏览器半边解析成界面语言

        const request = {
          text: body.text,
          targetLanguage,
          provider,
          sourceLanguage: 'auto',
        };
        // 带上 SessionId 才能命中官方服务的持久缓存（重复打开 Session 不再重复请求）。
        if (typeof body.sessionId === 'string' && body.sessionId) request.sessionId = body.sessionId;

        const controller = new AbortController();
        res.on('close', () => controller.abort());

        try {
          let spec;
          try {
            spec = t.resolve(request);
          } catch (error) {
            // 只回稳定错误码，不透传 message：官方 resolve 目前只抛长度/会话类
            // 错误（不含正文），但不应把「未来某个版本可能带正文」当作前提。
            return sendJson(res, 400, { ok: false, error: `invalid translation request: ${error?.code ?? 'error'}` });
          }
          let translated;
          try {
            translated = await t.translate(spec, controller.signal);
          } catch (error) {
            // 官方服务在 Session 未激活时拒绝写入持久缓存：先激活再重试一次，
            // 与官方思考翻译插件的 CotTranslationController 相同。
            if (error?.code !== 'TRANSLATION_SESSION_INACTIVE' || !request.sessionId) throw error;
            const sc = ctx.get('sessionController');
            if (sc && typeof sc.resolveAgent === 'function') {
              const result = await sc.resolveAgent(request.sessionId);
              if (result && typeof result === 'object' && 'error' in result) throw result.error;
            }
            controller.signal.throwIfAborted();
            translated = await t.translate(t.resolve(request), controller.signal);
          }
          return sendJson(res, 200, { ok: true, text: translated });
        } catch (error) {
          if (controller.signal.aborted) return; // 客户端已断开
          // 不回显原文与第三方响应，只给一个稳定错误。
          return sendJson(res, 502, { ok: false, error: `translation failed: ${error?.code ?? 'error'}` });
        }
      },
    },
    {
      kind: 'exact',
      path: `${BASE}/config`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        const body = await readJsonBody(req);
        const editor = ctx.get('configEditor');
        const entry = ctx.fiber?.entry;
        if (!editor || !entry) {
          return sendJson(res, 503, { ok: false, error: 'configuration cannot be saved in this profile' });
        }
        const next = {
          enabled: typeof body?.enabled === 'boolean' ? body.enabled : DEFAULTS.enabled,
          provider: body?.provider === 'google' ? 'google' : DEFAULTS.provider,
          targetLanguage: body?.targetLanguage === 'auto' ? 'auto' : DEFAULTS.targetLanguage,
        };
        try {
          await editor.edit(entry, () => next);
          return sendJson(res, 200, { ok: true, ...next });
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    },
  ];
}

/** Host 插件入口：注册路由，返回后由 fiber 统一清理。 */
export function apply(ctx, config) {
  const state = () => readConfig(config);
  const getTranslator = () => ctx.get('translator');
  const routes = buildRoutes(ctx, state, getTranslator);

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const disposers = [];
      for (const route of routes) {
        try {
          disposers.push(webCtx.webServer.register(route));
        } catch (error) {
          console.error(`[${PKG}] 路由注册失败 ${route.path}:`, error);
        }
      }
      return () => {
        for (const dispose of disposers) {
          try { dispose(); } catch { /* 已释放 */ }
        }
      };
    });
  });

  if (!getTranslator()) {
    console.warn(`[${PKG}] 未检测到官方 translator 服务；插件将以"显示原文"模式运行。`);
  }
}
