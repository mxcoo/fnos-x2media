/**
 * x2twitter 解析客户端（fnOS 版）
 *
 * 逻辑移植自 x2twitter-eagle-plugin/js/api.js（MIT）。区别：
 *   - 只跑 Node，不再兼容 Eagle 的渲染进程；
 *   - 网络层换成 ./net.js，支持 HTTP 代理与超时重试；
 *   - 多返回一个 caption 字段（推文文案），用作入库文件名与备注。
 *
 * 流程：
 *   POST /api/ajaxSearch  { q, lang, cftoken }  → { status, data } data 是含下载按钮的 HTML 片段
 *   POST /api/userverify  { url }              → { token }      仅当搜索接口要求令牌时才会调用
 *
 * 实测 /api/ajaxSearch 不校验令牌（cftoken 传空串照样返回结果），而 /api/userverify 被
 * Cloudflare 按 IP 限得很死（error code: 1015）。所以默认走匿名搜索，令牌是兜底路径：
 * 少一次请求，也就不会莫名其妙撞 1015。
 * 下载按钮 https://dl.snapcdn.app/get?token=<JWT>，JWT 载荷里直接写着真实媒体地址与文件名。
 */
import { requestText, sleep } from './net.js';

export const SITE = (process.env.X2_SITE || 'https://x2twitter.com').replace(/\/+$/, '');
const SEARCH_PAGE = SITE + '/zh-cn3';

/** 两次 /api/userverify 之间至少隔这么久：这个接口按 IP 限得很死（CF 规则 1015）。 */
const MIN_CALL_GAP = Number(process.env.X2_CALL_GAP || 4000);
/** 同一链接的解析结果缓存多久：重复点解析不再打扰接口。 */
const RESULT_TTL = Number(process.env.X2_RESULT_TTL || 10 * 60 * 1000);
/** 收到 429 但没带 Retry-After 时，保守地冷却这么久。 */
const DEFAULT_COOLDOWN_MS = 60 * 1000;
const MAX_COOLDOWN_MS = 30 * 60 * 1000;

const resultCache = new Map();
const inflight = new Map();
let cooldownUntil = 0;
let lastCallAt = 0;

/** 当前是否处在限流冷却里（前端据此禁用解析按钮） */
export function cooldown() {
    const left = cooldownUntil - Date.now();
    return left > 0
        ? { active: true, waitMs: left, until: cooldownUntil }
        : { active: false, waitMs: 0, until: 0 };
}

/** 测试用：清空缓存与冷却状态 */
export function resetState() {
    resultCache.clear();
    inflight.clear();
    cooldownUntil = 0;
    lastCallAt = 0;
}

const RATE_BODY = /error code:\s*10(15|11)|too many requests|rate limited/i;

function retryAfterMs(res) {
    const h = (res && res.headers) || {};
    const raw = h['retry-after'] || h['Retry-After'] || '';
    const sec = Number(String(raw).trim());
    if (Number.isFinite(sec) && sec > 0) return Math.min(sec * 1000, MAX_COOLDOWN_MS);
    return DEFAULT_COOLDOWN_MS;
}

function tripCooldown(res) {
    const ms = retryAfterMs(res);
    cooldownUntil = Date.now() + ms;
    lastCallAt = Date.now();
    const sec = Math.ceil(ms / 1000);
    const hint = sec > 300
        ? `需要等约 ${Math.ceil(sec / 60)} 分钟；在设置里填代理换个出口 IP 可以立刻恢复`
        : `约 ${sec} 秒后再试；或在设置里填代理换个出口 IP`;
    return x2Error('ratelimit', `x2twitter 接口限流（Cloudflare 1015），${hint}`, sec);
}

/** 冷却期内直接失败，不做无谓请求；否则保证两次调用之间的最小间隔 */
async function gate() {
    const cd = cooldown();
    if (cd.active) {
        const sec = Math.ceil(cd.waitMs / 1000);
        throw x2Error('ratelimit', `x2twitter 限流冷却中，约 ${sec} 秒后可再试`, sec);
    }
    const gap = Date.now() - lastCallAt;
    if (gap > 0 && gap < MIN_CALL_GAP) await sleep(MIN_CALL_GAP - gap);
    lastCallAt = Date.now();
}

const BROWSER_HEADERS = {
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: SEARCH_PAGE,
    Origin: SITE
};

const LANG_MAP = {
    zh_CN: 'zh-cn',
    zh_TW: 'zh-tw',
    zh_HK: 'zh-tw',
    en: 'en',
    ja_JP: 'ja',
    ko_KR: 'ko',
    es_ES: 'es',
    de_DE: 'de',
    ru_RU: 'ru',
    fr_FR: 'fr',
    pt_BR: 'pt',
    it_IT: 'it',
    vi_VN: 'vi',
    th_TH: 'th',
    tr_TR: 'tr',
    id_ID: 'id',
    ar_SA: 'ar'
};

// ---------------------------------------------------------------- 工具

function formEncode(obj) {
    return Object.keys(obj)
        .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]))
        .join('&');
}

function stripTags(html) {
    return String(html || '').replace(/<[^>]*>/g, ' ');
}

function decodeEntities(text) {
    return String(text || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#0*39;/g, "'")
        .replace(/&#x27;/gi, "'")
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

function cleanText(html) {
    return decodeEntities(stripTags(html)).replace(/\s+/g, ' ').trim();
}

function base64UrlDecode(input) {
    let s = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64').toString('utf8');
}

export function x2Error(code, message, detail) {
    const err = new Error(message || code);
    err.name = 'X2Error';
    err.code = code;
    err.detail = detail ?? null;
    return err;
}

function looksBlocked(res) {
    const body = String(res.body || '');
    return (
        res.status === 403 ||
        res.status === 503 ||
        /<title>\s*Just a moment/i.test(body) ||
        /cf-challenge|cf_chl_opt|challenge-platform/i.test(body)
    );
}

// ---------------------------------------------------------------- 链接

/**
 * 从任意文本里提取推文链接并规范化。
 * 支持 x.com / twitter.com / mobile.twitter.com / vxtwitter / fxtwitter /
 * fixupx / fixvx / twittpr，以及裸状态 ID。
 */
export function normalizeTweetUrl(input) {
    const text = String(input || '').trim();
    if (!text) return null;

    const direct =
        /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:#!\/)?([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})/i.exec(
            text
        );
    if (direct) return `https://x.com/${direct[1]}/status/${direct[2]}`;

    const alt = /^(?:https?:\/\/)?(?:www\.)?(?:vxtwitter|fxtwitter|fixupx|fixvx|twittpr)\.com\//i.exec(text);
    if (alt) {
        const nested = /status(?:es)?\/(\d{5,25})/i.exec(text);
        const altUser =
            /^https?:\/\/(?:www\.)?(?:vxtwitter|fxtwitter|fixupx|fixvx|twittpr)\.com\/([A-Za-z0-9_]{1,15})\//i.exec(
                text
            );
        if (nested) return `https://x.com/${(altUser && altUser[1]) || 'i'}/status/${nested[1]}`;
    }

    const loose = /(?:x|twitter)\.com\/(?:i|([A-Za-z0-9_]{1,15}))\/status(?:es)?\/(\d{5,25})/i.exec(text);
    if (loose) return `https://x.com/${loose[1] || 'i'}/status/${loose[2]}`;

    if (/^(?:\d{15,25})$/.test(text)) return `https://x.com/i/status/${text}`;
    return null;
}

/** 从多行文本里提取去重后的推文链接 */
export function extractTweetUrls(text) {
    const seen = new Set();
    const out = [];
    const push = (u) => {
        if (u && !seen.has(u)) {
            seen.add(u);
            out.push(u);
        }
    };
    String(text || '')
        .split(/[\r\n,，\s]+/)
        .forEach((line) => push(normalizeTweetUrl(line)));
    if (!out.length) {
        const re = /(?:x|twitter)\.com\/[^\s"'<>]*status(?:es)?\/\d+/gi;
        let m;
        while ((m = re.exec(String(text || '')))) push(normalizeTweetUrl(m[0]));
    }
    return out;
}

export function tweetIdOf(url) {
    const m = /status(?:es)?\/(\d+)/.exec(String(url || ''));
    return m ? m[1] : '';
}

export function userOf(url) {
    const m = /x\.com\/([^/]+)\/status/.exec(String(url || ''));
    return m && m[1] !== 'i' ? m[1] : '';
}

// ---------------------------------------------------------------- 接口

export function resolveLang(locale) {
    if (!locale) return 'zh-cn';
    if (LANG_MAP[locale]) return LANG_MAP[locale];
    const base = String(locale).split('_')[0].toLowerCase();
    for (const key of Object.keys(LANG_MAP)) {
        if (key.toLowerCase() === String(locale).toLowerCase()) return LANG_MAP[key];
    }
    return LANG_MAP[base] || 'en';
}

async function fetchToken(tweetUrl, opts = {}) {
    const res = await requestText(`${SITE}/api/userverify`, {
        method: 'POST',
        body: formEncode({ url: tweetUrl }),
        timeout: opts.timeout || 20000,
        proxy: opts.proxy,
        headers: {
            ...BROWSER_HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json, text/javascript, */*; q=0.01'
        }
    });
    if (res.status === 429 || RATE_BODY.test(String(res.body || ''))) throw tripCooldown(res);
    if (looksBlocked(res)) throw x2Error('blocked', '解析接口被 Cloudflare 拦截', res.status);
    let json = null;
    try {
        json = JSON.parse(res.body);
    } catch {
        if (res.status !== 200) throw x2Error('network', 'HTTP ' + res.status, res.status);
        throw x2Error('blocked', '令牌响应不是 JSON（多半被 Cloudflare 挡了）', res.status);
    }
    if (!json || !json.token) throw x2Error('token', '没有拿到访问令牌', json);
    return json.token;
}

async function search(tweetUrl, token, lang, opts = {}) {
    const res = await requestText(`${SITE}/api/ajaxSearch`, {
        method: 'POST',
        body: formEncode({ q: tweetUrl, lang: lang || 'zh-cn', cftoken: token }),
        timeout: opts.timeout || 45000,
        proxy: opts.proxy,
        headers: {
            ...BROWSER_HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json, text/javascript, */*; q=0.01'
        }
    });
    if (res.status === 429 || RATE_BODY.test(String(res.body || ''))) throw tripCooldown(res);
    if (looksBlocked(res)) throw x2Error('blocked', '解析接口被 Cloudflare 拦截', res.status);
    if (res.status === 429) throw x2Error('limit', '请求过于频繁（429）', 429);
    if (res.status !== 200) throw x2Error('network', 'HTTP ' + res.status, res.status);

    let json = null;
    try {
        json = JSON.parse(res.body);
    } catch {
        throw x2Error('blocked', '解析响应不是 JSON', res.status);
    }
    if (json.status !== 'ok') {
        if (json.statusCode === 429) throw tripCooldown(res);
        if ([401, 403].includes(json.statusCode) || /token|verify|验证|驗證/i.test(String(json.msg || ''))) {
            throw x2Error('token', json.msg || '搜索接口要求访问令牌', json.statusCode);
        }
        if (json.statusCode === 404 || json.statusCode === 326) {
            throw x2Error('media', json.msg || '没有找到媒体', json.statusCode);
        }
        throw x2Error('network', json.msg || '解析失败', json.statusCode);
    }
    if (json.msg) throw x2Error('media', json.msg, json.statusCode);
    const html = json.data || '';
    if (!html.trim()) throw x2Error('media', '解析结果为空', 0);
    return html;
}

// ---------------------------------------------------------------- 解析

/** 解码下载链接里的 JWT，拿到真实媒体地址与建议文件名 */
export function decodeDownloadUrl(href) {
    const m = /[?&]token=([^&]+)/.exec(String(href || ''));
    if (!m) return null;
    let payload = null;
    try {
        payload = JSON.parse(base64UrlDecode(m[1].split('.')[1] || ''));
    } catch {
        return null;
    }
    if (!payload || !payload.url) return null;
    return { url: String(payload.url), filename: String(payload.filename || '') };
}

const stripQuery = (url) => String(url || '').split('?')[0];

function isVideoUrl(url, filename) {
    const u = String(url || '');
    const f = String(filename || '');
    if (/video\.twimg\.com/i.test(u)) return true;
    if (/\.(mp4|m3u8|webm|mov)(\?|$)/i.test(u)) return true;
    if (/\.(mp4|webm|mov)$/i.test(f)) return true;
    return false;
}

function extOf(name, url) {
    const m = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(String(name || ''));
    if (m) return '.' + m[1].toLowerCase();
    const u = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(stripQuery(url));
    return u ? '.' + u[1].toLowerCase() : '';
}

function qualityOf(label, filename) {
    const m = /(\d{3,4})\s*p/i.exec(String(label || ''));
    if (m) return parseInt(m[1], 10);
    const f = /_(\d{3,4})p/i.exec(String(filename || ''));
    if (f) return parseInt(f[1], 10);
    return 0;
}

/** 解析 ajaxSearch 返回的 HTML 片段 → { tweetId, title, duration, thumbnail, items[] } */
export function parseResultHtml(html) {
    const src = String(html || '');
    const result = { tweetId: '', title: '', duration: '', thumbnail: '', items: [] };

    const idTag = /<input[^>]*id="TwitterId"[^>]*>/i.exec(src);
    if (idTag) {
        const idVal = /value="(\d+)"/i.exec(idTag[0]);
        if (idVal) result.tweetId = idVal[1];
    }

    const titleMatch = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(src);
    if (titleMatch) result.title = cleanText(titleMatch[1]);

    const durMatch = /<p[^>]*>\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*<\/p>/i.exec(src);
    if (durMatch) result.duration = durMatch[1];

    const images = [];
    const imgRe = /<img\b[^>]*?src="([^"]+)"/gi;
    let im;
    while ((im = imgRe.exec(src))) images.push({ index: im.index, src: decodeEntities(im[1]) });
    if (images.length) result.thumbnail = images[0].src;

    const anchors = [];
    const aRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let am;
    while ((am = aRe.exec(src))) {
        const attrs = am[1];
        const hrefMatch = /href="([^"]+)"/i.exec(attrs);
        if (!hrefMatch) continue;
        const href = decodeEntities(hrefMatch[1]);
        if (!/^https:\/\/dl\.snapcdn\.app\/get\?/i.test(href)) continue;
        anchors.push({
            index: am.index,
            href,
            label: cleanText(am[2]),
            audioUrl: decodeEntities((/data-audioUrl="([^"]+)"/i.exec(attrs) || [])[1] || '')
        });
    }

    const seen = new Set();
    anchors.forEach((a) => {
        const payload = decodeDownloadUrl(a.href);
        if (!payload) return;
        const key = stripQuery(payload.url);
        if (seen.has(key)) return;
        seen.add(key);

        const kind = isVideoUrl(payload.url, payload.filename) ? 'video' : 'image';
        let thumb = '';
        for (let i = images.length - 1; i >= 0; i--) {
            if (images[i].index < a.index) {
                thumb = images[i].src;
                break;
            }
        }

        result.items.push({
            kind,
            url: payload.url,
            downloadUrl: a.href, // dl.snapcdn.app 网关，CDN 不通时的第二线路
            filename: payload.filename,
            label: a.label,
            quality: qualityOf(a.label, payload.filename),
            ext: extOf(payload.filename, payload.url),
            thumbnail: thumb,
            audioUrl: a.audioUrl
        });
    });

    // 视频帖里的“下载图片”其实就是封面，单独标 kinds，方便 UI 默认不勾
    if (result.items.some((i) => i.kind === 'video')) {
        const thumbKey = stripQuery(result.thumbnail);
        result.items.forEach((i) => {
            if (i.kind === 'image' && stripQuery(i.url) === thumbKey) i.kind = 'cover';
        });
    }

    const order = { video: 0, image: 1, cover: 2 };
    result.items.sort((a, b) => {
        if (a.kind !== b.kind) return order[a.kind] - order[b.kind];
        return (b.quality || 0) - (a.quality || 0);
    });

    return result;
}

/** 完整解析一条推文链接 */
export async function resolve(tweetUrl, options = {}) {
    const url = normalizeTweetUrl(tweetUrl) || String(tweetUrl);
    const lang = options.lang || 'zh-cn';
    const key = url + '|' + lang;

    const hit = resultCache.get(key);
    if (hit && Date.now() - hit.at < RESULT_TTL) return { ...hit.value, cached: true };
    if (inflight.has(key)) return inflight.get(key);

    const task = resolveUncached(url, lang, options)
        .then((parsed) => {
            resultCache.set(key, { at: Date.now(), value: parsed });
            if (resultCache.size > 300) {
                const oldest = [...resultCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
                if (oldest) resultCache.delete(oldest[0]);
            }
            return parsed;
        })
        .finally(() => inflight.delete(key));

    inflight.set(key, task);
    return task;
}

async function resolveUncached(url, lang, options = {}) {
    const maxAttempts = (options.retries ?? 1) + 1;
    let lastErr = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await gate();
            let html = null;
            try {
                html = await search(url, '', lang, options);
            } catch (err) {
                if (err.code !== 'token') throw err;
                // 少见：站点开始校验令牌了，走 userverify 拿一个再来
                const token = await fetchToken(url, options);
                html = await search(url, token, lang, options);
            }
            const parsed = parseResultHtml(html);
            if (!parsed.items.length) throw x2Error('media', '这条推文里没有可下载的媒体', 0);
            parsed.url = url;
            parsed.tweetId = parsed.tweetId || tweetIdOf(url);
            parsed.user = userOf(url);
            parsed.lang = lang;
            parsed.caption = parsed.title || '';
            return parsed;
        } catch (err) {
            lastErr = err;
            // 限流不重试：重试只会让冷却时间更长
            const retryable = ['network', 'blocked', 'limit'].includes(err.code);
            if (!retryable || attempt === maxAttempts) break;
            await sleep(900 * attempt);
        }
    }
    throw lastErr;
}
