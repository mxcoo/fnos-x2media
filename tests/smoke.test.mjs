/**
 * 端到端冒烟：真起一个服务进程 + 真下载（源站用本机 HTTP 服务模拟 CDN）。
 *   node --test tests/smoke.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PAYLOAD = Buffer.from('FAKE-MP4-BYTES-'.repeat(4096));
const POSTER = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(512, 0x20), Buffer.from([0xff, 0xd9])]);

function startSourceServer() {
    const server = http.createServer((req, res) => {
        if (req.url.startsWith('/thumb.jpg')) {
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': POSTER.length });
            res.end(POSTER);
            return;
        }
        if (req.url.startsWith('/media.mp4')) {
            res.writeHead(200, {
                'Content-Type': 'video/mp4',
                'Content-Length': PAYLOAD.length,
                'Accept-Ranges': 'bytes'
            });
            res.end(PAYLOAD);
            return;
        }
        res.writeHead(404).end('no');
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { tries = 60, gap = 200 } = {}) {
    let last;
    for (let i = 0; i < tries; i++) {
        try {
            const v = await fn();
            if (v) return v;
        } catch (err) {
            last = err;
        }
        await wait(gap);
    }
    throw last || new Error('等待超时');
}

test('服务启动、下载入库、文件可读', async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'x2media-test-'));
    const port = 18000 + Math.floor(Math.random() * 2000);
    const source = await startSourceServer();
    const srcPort = source.address().port;

    const child = spawn(process.execPath, [path.join(ROOT, 'app/server/server.js')], {
        env: {
            ...process.env,
            X2_VAR: tmp,
            X2_PORT: String(port),
            X2_APPDEST: ROOT,
            X2_VERSION: 'test',
            X2_BIND: '127.0.0.1',
            HTTPS_PROXY: '',
            HTTP_PROXY: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let logs = '';
    child.stdout.on('data', (c) => { logs += c; });
    child.stderr.on('data', (c) => { logs += c; });

    t.after(async () => {
        child.kill('SIGKILL');
        source.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    const base = `http://127.0.0.1:${port}`;
    await waitFor(async () => {
        const r = await fetch(base + '/healthz');
        return r.ok;
    });

    // 静态页 + state
    const home = await fetch(base + '/');
    assert.match(await home.text(), /X2 媒体下载器/);

    const state = await (await fetch(base + '/api/state')).json();
    assert.equal(state.ok, true);
    assert.equal(state.settings.root, path.join(tmp, 'downloads'));

    // 设置可写
    const saved = await (
        await fetch(base + '/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: { concurrency: 3, lang: 'en' } })
        })
    ).json();
    assert.equal(saved.settings.concurrency, 3);
    assert.equal(saved.settings.lang, 'en');

    // 下载任务：一条推文一个视频
    const started = await (
        await fetch(base + '/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tweet: {
                    url: 'https://x.com/tester/status/1840000000000000123',
                    user: 'tester',
                    tweetId: '1840000000000000123',
                    caption: '冒烟测试',
                    thumbnail: `http://127.0.0.1:${srcPort}/thumb.jpg`
                },
                items: [
                    {
                        kind: 'video',
                        quality: 1080,
                        url: `http://127.0.0.1:${srcPort}/media.mp4`,
                        downloadUrl: '',
                        filename: 'smoke_1080p.mp4',
                        ext: '.mp4',
                        thumbnail: `http://127.0.0.1:${srcPort}/thumb.jpg`
                    }
                ]
            })
        })
    ).json();
    assert.equal(started.ok, true);

    // 字节维度的进度字段：前端靠它画总进度条 / 速度 / 剩余时间
    assert.equal(started.job.bytesReceived, 0);
    assert.equal(started.job.bytesTotal, 0);
    assert.ok('startedAt' in started.job);

    const job = await waitFor(async () => {
        const r = await (await fetch(base + `/api/job?id=${started.job.id}`)).json();
        return r.job.status === 'done' ? r.job : null;
    });
    assert.equal(job.items[0].state, 'done', logs);
    assert.equal(job.items[0].size, PAYLOAD.length);
    assert.equal(job.bytesTotal, job.items[0].total, '完成任务也有字节总量');
    assert.equal(job.bytesReceived, job.items[0].total);
    assert.ok(job.startedAt, '开始时间应写入快照');

    const expected = path.join(tmp, 'downloads', 'tester', '1840000000000000123', 'smoke_1080p.mp4');
    assert.ok(fs.existsSync(expected), '文件应落在模板目录下');
    assert.equal(fs.statSync(expected).size, PAYLOAD.length);

    const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(expected), 'meta.json'), 'utf8'));
    assert.equal(meta.tweet.user, 'tester');

    // 预览图：视频旁边应落一张 .poster.jpg，并且 /api/thumb 能读到
    const poster = expected.replace(/\.mp4$/, '.poster.jpg');
    assert.ok(fs.existsSync(poster), '视频落盘后应生成预览图');
    assert.equal(fs.statSync(poster).size, POSTER.length);

    // 资源库 + 文件读取（含 Range）
    const lib = await (await fetch(base + '/api/library')).json();
    assert.equal(lib.stats.count, 1);
    const id = lib.items[0].id;

    const fileRes = await fetch(base + `/api/file?id=${id}`);
    assert.equal(fileRes.status, 200);
    assert.equal((await fileRes.arrayBuffer()).byteLength, PAYLOAD.length);

    const thumbRes = await fetch(base + `/api/thumb?id=${id}`);
    assert.equal(thumbRes.status, 200);
    assert.equal((await thumbRes.arrayBuffer()).byteLength, POSTER.length);

    const ranged = await fetch(base + `/api/file?id=${id}`, { headers: { Range: 'bytes=0-9' } });
    assert.equal(ranged.status, 206);
    assert.equal((await ranged.arrayBuffer()).byteLength, 10);

    // 同名再下一次应加序号
    const again = await (
        await fetch(base + '/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tweet: { url: 'https://x.com/tester/status/1840000000000000123', user: 'tester', tweetId: '1840000000000000123', caption: '冒烟测试' },
                items: [{ kind: 'video', quality: 1080, url: `http://127.0.0.1:${srcPort}/media.mp4`, filename: 'smoke_1080p.mp4', ext: '.mp4' }]
            })
        })
    ).json();
    const job2 = await waitFor(async () => {
        const r = await (await fetch(base + `/api/job?id=${again.job.id}`)).json();
        return r.job.status === 'done' ? r.job : null;
    });
    assert.equal(job2.items[0].state, 'done');
    assert.ok(fs.existsSync(expected.replace(/\.mp4$/, '_1.mp4')), '重名应追加 _1');

    // 诊断接口不应崩
    const diag = await (await fetch(base + '/api/diagnose')).json();
    assert.equal(diag.ok, true);
    assert.equal(diag.rootWritable, true);
});
