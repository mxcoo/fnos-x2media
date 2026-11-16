/**
 * 运行时数据：设置、资源库索引、目录与文件名规范化。
 *
 * 目录约定（由 cmd/main 通过环境变量传入）：
 *   X2_APPDEST = ${TRIM_APPDEST}   应用安装目录（只读，代码在这里）
 *   X2_VAR     = ${TRIM_PKGVAR}    可写目录（设置、索引、日志、默认下载目录）
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const APP_DEST = process.env.X2_APPDEST || path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const VAR_DIR = process.env.X2_VAR || path.join(process.env.HOME || '/tmp', '.x2media');
export const SERVER_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const PUBLIC_DIR = path.join(SERVER_DIR, 'public');

const SETTINGS_FILE = path.join(VAR_DIR, 'settings.json');
const LIBRARY_FILE = path.join(VAR_DIR, 'library.jsonl');

export const DEFAULT_SETTINGS = {
    // 下载根目录：默认放在应用私有目录，安装后可在「设置」里改成共享文件夹
    root: path.join(VAR_DIR, 'downloads'),
    // 每条推文一个子目录：{user} {tweetId} {date} 可用
    folderTemplate: '{user}/{tweetId}',
    lang: 'zh_cn',
    concurrency: 2,
    saveCover: false,
    // HTTP 代理，例如 http://192.168.1.2:7890；留空则跟随进程环境变量
    proxy: '',
    // 解析成功后自动勾选最高画质（前端行为，存这里为了记住用户选择）
    autoBestQuality: true,
    // 同名文件已存在时的策略：rename 追加序号 / skip 跳过 / overwrite 覆盖
    conflict: 'rename'
};

fs.mkdirSync(VAR_DIR, { recursive: true });

let cache = null;

export function getSettings() {
    if (cache) return cache;
    let stored = {};
    try {
        stored = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch {
        stored = {};
    }
    cache = { ...DEFAULT_SETTINGS, ...stored };
    if (!path.isAbsolute(cache.root)) cache.root = path.join(VAR_DIR, cache.root);
    return cache;
}

export async function saveSettings(patch = {}) {
    const next = { ...getSettings() };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (patch[key] === undefined) continue;
        if (key === 'concurrency') {
            const n = Number(patch[key]);
            next[key] = Math.min(6, Math.max(1, Number.isFinite(n) ? Math.round(n) : 2));
        } else if (key === 'saveCover' || key === 'autoBestQuality') {
            next[key] = !!patch[key];
        } else if (key === 'conflict') {
            next[key] = ['rename', 'skip', 'overwrite'].includes(patch[key]) ? patch[key] : 'rename';
        } else {
            next[key] = String(patch[key]).trim();
        }
    }
    next.root = path.resolve(next.root || DEFAULT_SETTINGS.root);
    fs.mkdirSync(VAR_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 4) + '\n');
    cache = next;
    return next;
}

// ---------------------------------------------------------------- 命名

export function safeName(input, fallback = 'untitled', maxLen = 80) {
    let s = String(input || '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/^[.\s]+|[.\s]+$/g, '');
    if (!s) s = fallback;
    if (s.length > maxLen) s = s.slice(0, maxLen).trim();
    return s || fallback;
}

function dateStamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** 按模板算出相对下载根目录的子目录 */
export function folderFor(tweet, settings = getSettings()) {
    const vars = {
        user: safeName(tweet.user || 'unknown', 'unknown', 32),
        tweetId: safeName(tweet.tweetId || 'unknown', 'unknown', 32),
        date: dateStamp(),
        id: crypto.createHash('sha1').update(String(tweet.url || '')).digest('hex').slice(0, 8)
    };
    const tpl = settings.folderTemplate || '{user}/{tweetId}';
    const segments = tpl
        .split(/[\\/]+/)
        .map((seg) => seg.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)))
        .map((seg) => safeName(seg, 'x', 48))
        .filter(Boolean);
    return segments.join(path.sep);
}

/** 目录必须落在下载根之内，防止越界读写 */
export function assertInside(root, target) {
    const rel = path.relative(path.resolve(root), path.resolve(target));
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw Object.assign(new Error('路径越界'), { code: 'path' });
    }
    return target;
}

export async function resolveInside(root, relPath) {
    const abs = path.resolve(root, String(relPath || ''));
    assertInside(root, abs);
    return abs;
}

/** 重名时按设置决定：rename 追加 _1、skip 返回 null、overwrite 直接覆盖 */
export async function pickTargetPath(dir, baseName, ext, settings = getSettings()) {
    const conflict = settings.conflict || 'rename';
    const cleanBase = safeName(baseName, 'x2media', 96);
    let candidate = path.join(dir, cleanBase + ext);
    if (conflict === 'overwrite') return candidate;
    let n = 1;
    while (fs.existsSync(candidate)) {
        if (conflict === 'skip') return null;
        if (n > 500) throw new Error('同名文件过多：' + cleanBase);
        candidate = path.join(dir, `${cleanBase}_${n}${ext}`);
        n++;
    }
    return candidate;
}

export async function ensureDir(dir) {
    await fsp.mkdir(dir, { recursive: true });
    return dir;
}

// ---------------------------------------------------------------- 资源库

export function readLibrary() {
    let text = '';
    try {
        text = fs.readFileSync(LIBRARY_FILE, 'utf8');
    } catch {
        return [];
    }
    const items = [];
    for (const line of text.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
            items.push(JSON.parse(s));
        } catch {
            /* 单行损坏不影响其余记录 */
        }
    }
    return items;
}

export function appendLibrary(items) {
    if (!items.length) return;
    const payload = items.map((i) => JSON.stringify(i)).join('\n') + '\n';
    fs.appendFileSync(LIBRARY_FILE, payload);
}

export function rewriteLibrary(items) {
    const tmp = LIBRARY_FILE + '.tmp';
    fs.writeFileSync(tmp, items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''));
    fs.renameSync(tmp, LIBRARY_FILE);
}

export function makeItemId(relPath) {
    return crypto.createHash('sha1').update(relPath).digest('hex').slice(0, 16);
}

export function libraryStats(items) {
    let bytes = 0;
    const tweets = new Set();
    for (const i of items) {
        bytes += Number(i.size) || 0;
        if (i.tweetId) tweets.add(i.tweetId);
    }
    return { count: items.length, bytes, tweets: tweets.size };
}
