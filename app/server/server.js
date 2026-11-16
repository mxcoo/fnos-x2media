/**
 * X2 媒体下载器 · fnOS 服务端
 *
 * 一个进程干三件事：
 *   1. 静态托管前端（app/server/public）
 *   2. /api/* 提供解析、下载、资源库、设置
 *   3. 下载任务在进程内排队执行，前端轮询 /api/job 拿进度
 *
 * 只用 Node 内置模块；node >= 18 即可运行（cmd/install_callback 负责准备运行时）。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import * as x2 from './lib/x2.js';
import { requestText, requestStream, envProxy } from './lib/net.js';
import {
    APP_DEST,
    VAR_DIR,
    PUBLIC_DIR,
    getSettings,
    saveSettings,
    DEFAULT_SETTINGS,
    readLibrary,
    appendLibrary,
    rewriteLibrary,
    makeItemId,
    libraryStats,
    resolveInside,
    safeName,
    assertInside,
    ensureDir
} from './lib/store.js';
import { downloadItem, downloadCover, downloadPoster, routeLabel, mimeOf } from './lib/downloader.js';
import { extractFrame, posterFromSibling, posterPathFor } from './lib/poster.js';

const VERSION = process.env.X2_VERSION || '1.0.3';
const PORT = Number(process.env.X2_PORT || 8787);
const BIND = process.env.X2_BIND || '0.0.0.0';
const STARTED_AT = Date.now();

// ---------------------------------------------------------------- 任务队列

const jobs = new Map();
const queue = [];
let running = 0;

function newJob(tweet, items) {
    const job = {
        id: crypto.randomBytes(6).toString('hex'),
        createdAt: new Date().toISOString(),
        startedAt: null,
        status: 'queued',
        tweet,
        items: items.map((i, idx) => ({
            key: String(i.id ?? idx),
            kind: i.kind,
            quality: i.quality || 0,
            url: i.url,
            downloadUrl: i.downloadUrl || '',
            filename: i.filename || '',
            ext: i.ext || '',
            thumbnail: i.thumbnail || '',
            state: 'pending',
            received: 0,
            total: 0,
            route: '',
            error: null,
            relPath: '',
            size: 0
        }))
    };
    jobs.set(job.id, job);
    // 只留最近 30 个任务在内存里
    if (jobs.size > 30) {
        const oldest = [...jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
        if (oldest && oldest.status === 'done') jobs.delete(oldest.id);
    }
    return job;
}

function enqueue(job, options) {
    queue.push({ job, options });
    drain();
}

function drain() {
    const settings = getSettings();
    const limit = settings.concurrency || 2;
    while (running < limit && queue.length) {
        const task = queue.shift();
        running++;
        runJob(task.job, task.options)
            .catch((err) => {
                task.job.status = 'done';
                task.job.fatal = err.message;
            })
            .finally(() => {
                running--;
                drain();
            });
    }
}

async function runJob(job, options = {}) {
    const settings = getSettings();
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    const written = [];

    for (const item of job.items) {
        try {
            const record = await downloadItem(item, job.tweet, job, settings);
            if (!record) continue;
            const abs = path.join(settings.root, record.relPath);
            const st = await fsp.stat(abs);
            // 视频没有内嵌预览图，落盘后立刻配一张，资源库才有得看
            if (record.kind === 'video') {
                record.thumb = await downloadPoster(job.tweet, record, abs, settings).catch(() => null);
            }
            written.push({
                id: makeItemId(record.relPath),
                tweetId: job.tweet.tweetId || '',
                user: job.tweet.user || '',
                tweetUrl: job.tweet.url || '',
                caption: job.tweet.caption || '',
                kind: record.kind,
                quality: record.quality || 0,
                ext: record.ext,
                relPath: record.relPath,
                thumb: record.thumb || null,
                size: st.size,
                mime: record.mime || mimeOf(record.ext),
                sourceUrl: record.url,
                createdAt: new Date().toISOString()
            });
        } catch (err) {
            item.state = 'failed';
            item.error = err.message;
        }
        job.progress = job.items.filter((i) => i.state === 'done' || i.state === 'failed' || i.state === 'skipped').length;
    }

    if (options.saveCover) {
        const video = job.items.find((i) => i.kind === 'video');
        const cover = await downloadCover(job.tweet, video, settings).catch(() => null);
        if (cover) {
            job.cover = cover;
            const abs = path.join(settings.root, cover);
            const st = await fsp.stat(abs).catch(() => null);
            written.push({
                id: makeItemId(cover),
                tweetId: job.tweet.tweetId || '',
                user: job.tweet.user || '',
                tweetUrl: job.tweet.url || '',
                caption: job.tweet.caption || '',
                kind: 'cover',
                quality: 0,
                ext: '.jpg',
                relPath: cover,
                size: st ? st.size : 0,
                mime: 'image/jpeg',
                sourceUrl: video ? video.thumbnail : '',
                createdAt: new Date().toISOString()
            });
        }
    }

    if (written.length) {
        appendLibrary(written);
        // 每条推文目录里留一份 meta.json，脱离应用也能看懂
        try {
            const dir = path.dirname(path.join(settings.root, written[0].relPath));
            await ensureDir(dir);
            await fsp.writeFile(
                path.join(dir, 'meta.json'),
                JSON.stringify(
                    {
                        tweet: job.tweet,
                        items: written.map((w) => ({ file: path.basename(w.relPath), kind: w.kind, quality: w.quality })),
                        savedAt: new Date().toISOString(),
                        tool: `X2 媒体下载器 ${VERSION}`
                    },
                    null,
                    2
                )
            );
        } catch {
            /* meta.json 只是便利文件，失败不影响入库 */
        }
    }

    job.saved = written;
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
}

// ---------------------------------------------------------------- HTTP 工具

const CT = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8'
};

function sendJson(res, code, obj) {
    const body = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

function fail(res, err) {
    const code = err && err.code === 'path' ? 400 : 500;
    sendJson(res, code, { ok: false, error: err && err.message ? err.message : String(err) });
}

async function readJson(req, limit = 4 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new Error('请求体过大');
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new Error('请求体不是合法 JSON');
    }
}

async function serveStatic(res, urlPath) {
    const clean = decodeURIComponent(urlPath.split('?')[0]);
    const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
    const abs = path.resolve(PUBLIC_DIR, rel);
    if (!abs.startsWith(PUBLIC_DIR)) {
        res.writeHead(403).end('forbidden');
        return;
    }
    try {
        const st = await fsp.stat(abs);
        if (st.isDirectory()) {
            res.writeHead(302, { Location: clean.replace(/\/?$/, '/') + 'index.html' }).end();
            return;
        }
        const ext = path.extname(abs).toLowerCase();
        res.writeHead(200, {
            'Content-Type': CT[ext] || 'application/octet-stream',
            'Content-Length': st.size,
            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
        });
        fs.createReadStream(abs).pipe(res);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
    }
}

/** 支持 Range 的文件流（视频拖动进度、图片预览都走它） */
async function streamFile(req, res, abs, { inline = true, download = false } = {}) {
    const st = await fsp.stat(abs);
    const ext = path.extname(abs).toLowerCase();
    const range = req.headers.range;
    const headers = {
        'Content-Type': mimeOf(ext),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=60',
        'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`
    };
    if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        if (m) {
            const start = m[1] ? Number(m[1]) : 0;
            const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
            if (start >= st.size || end < start) {
                res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
                return;
            }
            res.writeHead(206, {
                ...headers,
                'Content-Range': `bytes ${start}-${end}/${st.size}`,
                'Content-Length': end - start + 1
            });
            fs.createReadStream(abs, { start, end }).pipe(res);
            return;
        }
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    fs.createReadStream(abs).pipe(res);
}

// ---------------------------------------------------------------- 业务

async function apiResolve(body) {
    const settings = getSettings();
    const lang = x2.resolveLang(body.lang || settings.lang);
    const input = Array.isArray(body.urls) ? body.urls : x2.extractTweetUrls(body.text || '');
    const urls = [...new Set(input.map((u) => x2.normalizeTweetUrl(u)).filter(Boolean))].slice(0, 40);
    if (!urls.length) throw Object.assign(new Error('没有识别到推文链接'), { code: 'input' });

    const tweets = [];
    for (const url of urls) {
        try {
            const parsed = await x2.resolve(url, { lang, proxy: settings.proxy || envProxy(), retries: 1 });
            tweets.push({ ok: true, ...parsed });
        } catch (err) {
            tweets.push({ ok: false, url, error: err.message, code: err.code || 'error', retryAfter: err.detail || null });
        }
        if (x2.cooldown().active) break; // 已经限流就别再打后续链接
    }
    const cd = x2.cooldown();
    const throttled = cd.active && tweets.length > 0 && tweets.every((t) => !t.ok && t.code === 'ratelimit');
    return {
        ok: true,
        lang,
        tweets,
        cooldown: cd.active ? { waitMs: cd.waitMs } : null,
        ratelimit: throttled
    };
}

async function apiStartDownload(body) {
    const tweet = body.tweet || {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) throw Object.assign(new Error('没有选中任何媒体'), { code: 'input' });
    const settings = getSettings();
    await ensureDir(settings.root);
    const job = newJob(
        {
            url: x2.normalizeTweetUrl(tweet.url) || tweet.url || '',
            user: safeName(tweet.user || x2.userOf(tweet.url || ''), 'unknown', 32),
            tweetId: tweet.tweetId || x2.tweetIdOf(tweet.url || ''),
            caption: String(tweet.caption || '').slice(0, 4000),
            thumbnail: /^https?:\/\//.test(String(tweet.thumbnail || '')) ? String(tweet.thumbnail).slice(0, 800) : ''
        },
        items
    );
    enqueue(job, { saveCover: !!body.saveCover });
    return { ok: true, job: snapshot(job) };
}

const snapshot = (job) => ({
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    tweet: job.tweet,
    progress: job.items.filter((i) => ['done', 'failed', 'skipped'].includes(i.state)).length,
    total: job.items.length,
    // 字节维度的总进度：比按条目数算准得多（一个 16MB 的视频在 92% 时不该显示 0%）
    bytesReceived: job.items.reduce((sum, i) => sum + (i.received || 0), 0),
    bytesTotal: job.items.reduce((sum, i) => sum + (i.total || 0), 0),
    items: job.items.map((i) => ({
        key: i.key,
        kind: i.kind,
        quality: i.quality,
        filename: i.filename,
        state: i.state,
        received: i.received,
        total: i.total,
        route: i.route,
        error: i.error,
        relPath: i.relPath,
        size: i.size
    })),
    saved: job.saved || [],
    fatal: job.fatal || null
});

async function apiDiagnose() {
    const settings = getSettings();
    const proxy = settings.proxy || envProxy();
    const targets = [
        { name: 'x2twitter 解析接口', url: x2.SITE + '/zh-cn3' },
        { name: '媒体 CDN (video.twimg.com)', url: 'https://video.twimg.com/' },
        { name: '备用网关 (dl.snapcdn.app)', url: 'https://dl.snapcdn.app/' }
    ];
    const results = [];
    for (const t of targets) {
        const started = Date.now();
        try {
            const res = await requestText(t.url, { method: 'GET', timeout: 12000, proxy });
            results.push({
                name: t.name,
                ok: res.status > 0 && res.status < 500,
                status: res.status,
                ms: Date.now() - started
            });
        } catch (err) {
            results.push({ name: t.name, ok: false, status: 0, ms: Date.now() - started, error: err.message });
        }
    }
    let rootWritable = false;
    try {
        await ensureDir(settings.root);
        const probe = path.join(settings.root, '.write-test');
        await fsp.writeFile(probe, 'ok');
        await fsp.rm(probe, { force: true });
        rootWritable = true;
    } catch {
        rootWritable = false;
    }
    return {
        ok: true,
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        cpus: os.cpus().length,
        mem: os.totalmem(),
        uptime: Math.round((Date.now() - STARTED_AT) / 1000),
        proxy: proxy || '',
        root: settings.root,
        rootWritable,
        results
    };
}

// ---------------------------------------------------------------- 路由

async function route(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    if (p.startsWith('/api/')) {
        if (p === '/api/state' && req.method === 'GET') {
            const settings = getSettings();
            const library = readLibrary();
            return sendJson(res, 200, {
                ok: true,
                version: VERSION,
                port: PORT,
                settings,
                stats: libraryStats(library),
                defaults: DEFAULT_SETTINGS,
                root: settings.root,
                cooldown: x2.cooldown(),
                env: {
                    appdest: APP_DEST,
                    var: VAR_DIR,
                    node: process.version
                }
            });
        }

        if (p === '/api/settings' && req.method === 'POST') {
            const body = await readJson(req);
            const settings = await saveSettings(body.settings || body);
            return sendJson(res, 200, { ok: true, settings });
        }

        if (p === '/api/resolve' && req.method === 'POST') {
            return sendJson(res, 200, await apiResolve(await readJson(req)));
        }

        if (p === '/api/download' && req.method === 'POST') {
            return sendJson(res, 200, await apiStartDownload(await readJson(req)));
        }

        if (p === '/api/job' && req.method === 'GET') {
            const job = jobs.get(url.searchParams.get('id') || '');
            if (!job) return sendJson(res, 404, { ok: false, error: '任务不存在或已过期' });
            return sendJson(res, 200, { ok: true, job: snapshot(job) });
        }

        if (p === '/api/jobs' && req.method === 'GET') {
            const list = [...jobs.values()]
                .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
                .slice(0, 20)
                .map(snapshot);
            return sendJson(res, 200, { ok: true, jobs: list });
        }

        if (p === '/api/library' && req.method === 'GET') {
            const q = (url.searchParams.get('q') || '').toLowerCase().trim();
            const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000);
            let items = readLibrary();
            if (q) {
                items = items.filter((i) =>
                    [i.caption, i.user, i.tweetId, i.relPath].some((v) => String(v || '').toLowerCase().includes(q))
                );
            }
            items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
            return sendJson(res, 200, {
                ok: true,
                stats: libraryStats(readLibrary()),
                root: getSettings().root,
                items: items.slice(0, limit),
                truncated: items.length > limit
            });
        }

        if (p === '/api/file' && req.method === 'GET') {
            const settings = getSettings();
            const library = readLibrary();
            const item = library.find((i) => i.id === url.searchParams.get('id'));
            if (!item) return sendJson(res, 404, { ok: false, error: '记录不存在' });
            const abs = await resolveInside(settings.root, item.relPath);
            return streamFile(req, res, abs, { download: url.searchParams.get('dl') === '1' });
        }

        if (p === '/api/thumb' && req.method === 'GET') {
            const settings = getSettings();
            const library = readLibrary();
            const item = library.find((i) => i.id === url.searchParams.get('id'));
            if (!item) return sendJson(res, 404, { ok: false, error: '记录不存在' });
            const root = settings.root;
            const abs = path.join(root, item.relPath);
            const ok = (p) => p && fs.existsSync(p) && fs.statSync(p).size > 0;

            // 1) 下载时存的预览图  2) 图片本身  3) 同目录 cover.jpg  4) 现抽一帧并缓存
            let target = item.thumb ? path.join(root, item.thumb) : null;
            if (!ok(target)) target = item.kind === 'image' || item.kind === 'cover' ? abs : null;
            if (!ok(target)) target = path.join(path.dirname(abs), 'cover.jpg');
            if (!ok(target)) {
                const poster = posterPathFor(abs);
                if (ok(poster)) target = poster;
                else target = (await extractFrame(abs, poster, { width: 640 }).catch(() => null)) || null;
            }
            // 同一条推文的别的文件已经配过图，直接抄一份，省掉一次回查
            if (!ok(target)) target = (await posterFromSibling(abs).catch(() => null)) || null;
            // 老记录的兜底：本机没有 ffmpeg 时，回解析接口再取一次推文缩略图（结果缓存在磁盘，只查一次）
            if (!ok(target) && item.tweetId) {
                const url = item.tweetUrl || `https://x.com/i/status/${item.tweetId}`;
                const parsed = await x2
                    .resolve(url, { lang: x2.resolveLang(getSettings().lang), proxy: getSettings().proxy || envProxy(), retries: 0 })
                    .catch(() => null);
                const src = parsed && (parsed.thumbnail || (parsed.items || []).map((i) => i.thumbnail).find(Boolean));
                if (src) {
                    const rel = await downloadPoster({ thumbnail: src }, { thumbnail: src }, abs, settings).catch(() => null);
                    if (rel) target = path.join(root, rel);
                }
            }
            if (!ok(target)) return sendJson(res, 404, { ok: false, error: '没有预览图' });

            assertInside(root, target);
            return streamFile(req, res, target);
        }

        if (p === '/api/item/delete' && req.method === 'POST') {
            const body = await readJson(req);
            const settings = getSettings();
            const library = readLibrary();
            const idx = library.findIndex((i) => i.id === body.id);
            if (idx < 0) return sendJson(res, 404, { ok: false, error: '记录不存在' });
            const item = library[idx];
            if (body.withFile) {
                const abs = await resolveInside(settings.root, item.relPath);
                await fsp.rm(abs, { force: true });
                for (const derived of [item.thumb, posterPathFor(abs)]) {
                    if (!derived) continue;
                    const p = path.isAbsolute(derived) ? derived : path.join(settings.root, derived);
                    await resolveInside(settings.root, p).then((x) => fsp.rm(x, { force: true })).catch(() => {});
                }
            }
            library.splice(idx, 1);
            rewriteLibrary(library);
            return sendJson(res, 200, { ok: true, removed: item.relPath, withFile: !!body.withFile });
        }

        if (p === '/api/diagnose' && req.method === 'GET') {
            return sendJson(res, 200, await apiDiagnose());
        }

        if (p === '/api/log' && req.method === 'GET') {
            const lines = Math.min(Number(url.searchParams.get('lines')) || 200, 2000);
            const file = path.join(VAR_DIR, 'info.log');
            try {
                const text = await fsp.readFile(file, 'utf8');
                return sendJson(res, 200, { ok: true, log: text.split('\n').slice(-lines).join('\n') });
            } catch {
                return sendJson(res, 200, { ok: true, log: '' });
            }
        }

        return sendJson(res, 404, { ok: false, error: '未知接口 ' + p });
    }

    if (p === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
        return;
    }

    return serveStatic(res, p);
}

const server = http.createServer((req, res) => {
    const started = Date.now();
    route(req, res)
        .catch((err) => {
            if (!res.headersSent) fail(res, err);
            else res.end();
        })
        .finally(() => {
            if (process.env.X2_ACCESS_LOG === '1') {
                console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
            }
        });
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

server.listen(PORT, BIND, async () => {
    const settings = getSettings();
    await ensureDir(settings.root).catch(() => {});
    console.log(`[x2media] v${VERSION} listening on ${BIND}:${PORT}`);
    console.log(`[x2media] var=${VAR_DIR} root=${settings.root} node=${process.version}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
        console.log(`[x2media] ${sig} received, shutting down`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
    });
}
