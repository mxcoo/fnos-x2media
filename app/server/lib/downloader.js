/**
 * 多线路下载器。
 *
 * 一条媒体有四个候选线路，按顺序尝试，任一成功即停：
 *   1. CDN 直连        video.twimg.com / pbs.twimg.com
 *   2. CDN + 代理      走设置里的 HTTP 代理（CONNECT 隧道）
 *   3. X2Twitter 网关   dl.snapcdn.app/get?token=…（Cloudflare 回源）
 *   4. 网关 + 代理
 *
 * 下载先写 .part，成功后原子改名，失败保留错误文本供前端展示。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { requestStream, envProxy } from './net.js';
import { ensureDir, folderFor, pickTargetPath, safeName, getSettings } from './store.js';
import { extractFrame, posterPathFor } from './poster.js';

const MIME_BY_EXT = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.m4a': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp'
};

export function mimeOf(ext) {
    return MIME_BY_EXT[String(ext || '').toLowerCase()] || 'application/octet-stream';
}

function routeList(item, settings) {
    const configured = (settings.proxy || '').trim() || envProxy();
    const routes = [{ name: 'cdn', url: item.url, proxy: null }];
    if (configured) routes.push({ name: 'cdn-proxy', url: item.url, proxy: configured });
    if (item.downloadUrl) {
        routes.push({ name: 'gateway', url: item.downloadUrl, proxy: null });
        if (configured) routes.push({ name: 'gateway-proxy', url: item.downloadUrl, proxy: configured });
    }
    return routes;
}

const ROUTE_LABEL = {
    cdn: 'CDN 直连',
    'cdn-proxy': 'CDN · 代理',
    gateway: '备用线路',
    'gateway-proxy': '备用线路 · 代理'
};

export function routeLabel(name) {
    return ROUTE_LABEL[name] || name;
}

async function downloadOnce(route, dest, onProgress) {
    const res = await requestStream(route.url, {
        proxy: route.proxy,
        timeout: 60000,
        headers: {
            Referer: 'https://x.com/',
            Accept: '*/*'
        }
    });
    if (res.status !== 200) {
        res.stream.resume();
        throw new Error(`HTTP ${res.status}`);
    }
    const total = Number(res.headers['content-length'] || 0);
    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(dest);
        let received = 0;
        const stream = res.stream;
        stream.on('data', (chunk) => {
            received += chunk.length;
            if (onProgress) onProgress(received, total);
        });
        stream.on('error', (err) => {
            out.destroy();
            reject(err);
        });
        out.on('error', reject);
        out.on('finish', () => resolve(received));
        stream.pipe(out);
    });
    const stat = await fsp.stat(dest);
    if (!stat.size) throw new Error('下载到 0 字节');
    return { size: stat.size, contentType: res.headers['content-type'] || '' };
}

/** 下载单个媒体项；返回写库用的记录 */
export async function downloadItem(item, tweet, job, settings = getSettings()) {
    const root = settings.root;
    const relDir = folderFor(tweet, settings);
    const dir = await ensureDir(path.join(root, relDir));

    const ext = (item.ext || '').toLowerCase();
    const baseName = safeName(
        String(item.filename || '').replace(/\.[a-z0-9]{2,5}$/i, '') ||
            `${tweet.user || 'x'}_${tweet.tweetId || ''}_${item.quality || ''}p`,
        'x2media',
        96
    );
    let finalPath = await pickTargetPath(dir, baseName, ext, settings);
    if (!finalPath) {
        item.state = 'skipped';
        item.error = '同名文件已存在（设置：跳过）';
        return null;
    }

    const partPath = finalPath + '.part';
    const errors = [];
    for (const route of routeList(item, settings)) {
        item.route = routeLabel(route.name);
        item.state = 'downloading';
        item.received = 0;
        item.total = 0;
        try {
            const { size } = await downloadOnce(route, partPath, (received, total) => {
                item.received = received;
                item.total = total;
            });
            await fsp.rename(partPath, finalPath);
            item.state = 'done';
            item.size = size;
            item.error = null;
            item.relPath = path.relative(root, finalPath).split(path.sep).join('/');
            item.mime = mimeOf(ext);
            item.finishedAt = new Date().toISOString();
            return item;
        } catch (err) {
            errors.push(`${routeLabel(route.name)}: ${err.message}`);
            await fsp.rm(partPath, { force: true }).catch(() => {});
        }
    }

    item.state = 'failed';
    item.error = errors.join(' / ') || '全部线路失败';
    return null;
}

/**
 * 给已下载的视频配一张预览图，落在视频旁边：`<视频名>.poster.jpg`。
 * 先抓推文缩略图（快、清晰、和推文一致），失败再本地抽帧（ffmpeg 不可用就放弃）。
 */
export async function downloadPoster(tweet, item, videoAbs, settings = getSettings()) {
    const root = settings.root;
    const dest = posterPathFor(videoAbs);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
        return path.relative(root, dest).split(path.sep).join('/');
    }

    const src = item && (item.thumbnail || (tweet && tweet.thumbnail));
    if (src) {
        const configured = (settings.proxy || '').trim() || envProxy();
        const routes = [{ url: src, proxy: null }];
        if (configured) routes.push({ url: src, proxy: configured });
        for (const route of routes) {
            const tmp = dest + '.part';
            try {
                await downloadOnce({ name: 'thumb', url: route.url, proxy: route.proxy }, tmp, null);
                await fsp.rename(tmp, dest);
                return path.relative(root, dest).split(path.sep).join('/');
            } catch {
                await fsp.rm(tmp, { force: true }).catch(() => {});
            }
        }
    }

    const frame = await extractFrame(videoAbs, dest).catch(() => null);
    return frame ? path.relative(root, dest).split(path.sep).join('/') : null;
}

/** 保存视频封面（可选） */
export async function downloadCover(tweet, item, settings = getSettings()) {
    if (!item || !item.thumbnail) return null;
    const root = settings.root;
    const dir = await ensureDir(path.join(root, folderFor(tweet, settings)));
    const dest = path.join(dir, 'cover.jpg');
    if (fs.existsSync(dest)) return path.relative(root, dest).split(path.sep).join('/');
    try {
        await downloadOnce({ name: 'cdn', url: item.thumbnail, proxy: null }, dest, null);
        return path.relative(root, dest).split(path.sep).join('/');
    } catch {
        await fsp.rm(dest, { force: true }).catch(() => {});
        return null;
    }
}

export async function sha1File(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha1');
        const rs = fs.createReadStream(file);
        rs.on('data', (c) => h.update(c));
        rs.on('end', () => resolve(h.digest('hex')));
        rs.on('error', reject);
    });
}
