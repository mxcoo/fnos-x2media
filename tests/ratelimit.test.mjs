/**
 * 限流（Cloudflare 1015）与结果缓存的行为测试。
 * 起一个假 x2twitter，通过 X2_SITE 指过去，不碰真站。
 *   node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const jwt = (payload) => `h.${b64url(payload)}.s`;

const MEDIA = 'https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/abc.mp4';
const RESULT_HTML = `
<div class="item">
  <img class="thumb" src="https://pbs.twimg.com/media/AAA.jpg?name=small">
  <h3>限流测试推文</h3>
  <p>0:12</p>
  <input type="hidden" id="TwitterId" value="2122058829173301489">
  <a class="button" href="https://dl.snapcdn.app/get?token=${jwt({ url: MEDIA, filename: 'X2Twitter.com_1280p.mp4' })}">下载 MP4 (1280p)</a>
</div>`;

let mode = 'limit';   // limit | limit-noheader | ok | need-token
let hits = 0;
let sawToken = 0;

const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        hits += 1;
        if (mode === 'limit') {
            res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '30' });
            res.end('error code: 1015\n');
            return;
        }
        if (mode === 'limit-noheader') {
            res.writeHead(429, { 'content-type': 'text/plain' });
            res.end('error code: 1015\n');
            return;
        }
        if (/userverify/.test(req.url)) {
            sawToken += 1;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ token: 'fake-token' }));
            return;
        }
        if (mode === 'need-token' && sawToken === 0) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: 'fail', statusCode: 401, msg: 'token 校验失败，请重试' }));
            return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', data: RESULT_HTML }));
    });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.X2_SITE = base;
process.env.X2_CALL_GAP = '0';

const x2 = await import('../app/server/lib/x2.js');

const URL1 = 'https://x.com/fgcshiyuchen/status/2122058829173301489';

test('429 + Retry-After 识别为限流，而不是「不是 JSON」', async () => {
    x2.resetState();
    hits = 0;
    mode = 'limit';

    const err = await x2.resolve(URL1, { retries: 1 }).then(
        () => null,
        (e) => e
    );
    assert.ok(err, '应当抛错');
    assert.equal(err.code, 'ratelimit');
    assert.match(err.message, /1015/);
    assert.equal(err.detail, 30, 'detail 里带剩余秒数');
    assert.equal(hits, 1, '限流不做重试');

    const cd = x2.cooldown();
    assert.equal(cd.active, true);
    assert.ok(cd.waitMs > 25000 && cd.waitMs <= 30000, `冷却时长应约 30s，实际 ${cd.waitMs}`);
});

test('冷却期内再解析直接失败，不再打接口', async () => {
    const before = hits;
    const err = await x2.resolve(URL1, { retries: 1 }).then(() => null, (e) => e);
    assert.ok(err);
    assert.equal(err.code, 'ratelimit');
    assert.match(err.message, /冷却中/);
    assert.equal(hits, before, '冷却期不应产生新请求');
});

test('没带 Retry-After 时退化成默认冷却', async () => {
    x2.resetState();
    mode = 'limit-noheader';
    const err = await x2.resolve(URL1, { retries: 1 }).then(() => null, (e) => e);
    assert.equal(err.code, 'ratelimit');
    const cd = x2.cooldown();
    assert.ok(cd.waitMs > 50000 && cd.waitMs <= 60000, `默认冷却应约 60s，实际 ${cd.waitMs}`);
});

test('默认走匿名搜索：只打 ajaxSearch，不碰会被限流的 userverify', async () => {
    x2.resetState();
    mode = 'ok';
    hits = 0;
    sawToken = 0;

    const first = await x2.resolve(URL1, { retries: 1 });
    assert.equal(first.tweetId, '2122058829173301489');
    assert.ok(first.items.length >= 1);
    assert.equal(hits, 1, '匿名搜索一次搞定');
    assert.equal(sawToken, 0, '没有调用 userverify');

    const second = await x2.resolve(URL1, { retries: 1 });
    assert.equal(second.cached, true);
    assert.equal(hits, 1, '同一链接命中缓存，不再请求');
});

test('搜索接口要求令牌时自动回落到 userverify', async () => {
    x2.resetState();
    mode = 'need-token';
    hits = 0;
    sawToken = 0;

    const r = await x2.resolve(URL1, { retries: 1 });
    assert.ok(r.items.length >= 1);
    assert.equal(sawToken, 1, '取了一次令牌');
    assert.equal(hits, 3, 'ajaxSearch(要求令牌) → userverify → ajaxSearch(成功)');
});

test.after(() => server.close());
