/**
 * 预览图（poster）生成。
 *
 * 优先级：推文缩略图（pbs.twimg.com 的 jpg）→ 本地抽帧（ffmpeg）→ 无。
 * 抽帧结果缓存成 `<视频名>.poster.jpg`，同一文件只跑一次。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

let ffmpegPath;

/** 找 ffmpeg：环境变量优先，其次 PATH；找不到就返回 null（不报错，走降级） */
export function findFfmpeg() {
    if (ffmpegPath !== undefined) return ffmpegPath;
    const candidates = [process.env.X2_FFMPEG, 'ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/ffmpeg/ffmpeg'];
    for (const bin of candidates) {
        if (!bin) continue;
        try {
            const r = spawnSync(bin, ['-version'], { timeout: 5000, stdio: 'ignore' });
            if (r.status === 0) {
                ffmpegPath = bin;
                return ffmpegPath;
            }
        } catch {
            /* 试下一个 */
        }
    }
    ffmpegPath = null;
    return null;
}

/** 抽一帧当封面：先试第 1 秒（避开黑场），失败退回第 0 帧 */
export function extractFrame(videoAbs, outAbs, { at = 1, width = 720, timeout = 30000 } = {}) {
    const bin = findFfmpeg();
    if (!bin) return Promise.resolve(null);

    const run = (seek) =>
        new Promise((resolve) => {
            const args = ['-y', '-loglevel', 'error', '-ss', String(seek), '-i', videoAbs, '-frames:v', '1'];
            if (width) args.push('-vf', `scale=${width}:-2`);
            args.push(outAbs);
            const child = spawn(bin, args, { stdio: 'ignore' });
            const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
            child.on('error', () => {
                clearTimeout(timer);
                resolve(false);
            });
            child.on('close', (code) => {
                clearTimeout(timer);
                resolve(code === 0 && fs.existsSync(outAbs) && fs.statSync(outAbs).size > 0);
            });
        });

    return (async () => {
        if (await run(at)) return outAbs;
        await fsp.rm(outAbs, { force: true }).catch(() => {});
        if (at > 0 && (await run(0))) return outAbs;
        await fsp.rm(outAbs, { force: true }).catch(() => {});
        return null;
    })();
}

/**
 * 同一推文目录里已经有别的 poster 时，直接复制一份，免得为一条推文反复回查接口。
 * 返回复制出的路径，没有同款就返回 null。
 */
export async function posterFromSibling(videoAbs) {
    const dir = path.dirname(videoAbs);
    const dest = posterPathFor(videoAbs);
    let names;
    try {
        names = await fsp.readdir(dir);
    } catch {
        return null;
    }
    for (const name of names) {
        if (!name.endsWith('.poster.jpg') && name !== 'cover.jpg') continue;
        const src = path.join(dir, name);
        if (src === dest) continue;
        try {
            if (!fs.statSync(src).size) continue;
            await fsp.copyFile(src, dest);
            return dest;
        } catch {
            /* 换下一个候选 */
        }
    }
    return null;
}

/** 视频对应的 poster 缓存路径 */
export function posterPathFor(videoAbs) {
    return videoAbs.replace(/\.[a-z0-9]{2,5}$/i, '') + '.poster.jpg';
}

export async function ffmpegAvailable() {
    return !!findFfmpeg();
}

export { path as _path };
