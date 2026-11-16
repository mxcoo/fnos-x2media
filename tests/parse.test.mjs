/**
 * 纯解析逻辑单测（不联网）。
 *   node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeTweetUrl,
    extractTweetUrls,
    decodeDownloadUrl,
    parseResultHtml,
    tweetIdOf,
    userOf,
    resolveLang
} from '../app/server/lib/x2.js';
import { safeName, folderFor, DEFAULT_SETTINGS } from '../app/server/lib/store.js';

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const jwt = (payload) => `h.${b64url(payload)}.s`;

const VIDEO = 'https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/abc.mp4';
const IMAGE = 'https://pbs.twimg.com/media/AAA.jpg?name=large';

const html = `
<div class="item">
  <img class="thumb" src="https://pbs.twimg.com/media/AAA.jpg?name=small">
  <h3>一条测试推文 <b>#tag</b></h3>
  <p>0:12</p>
  <input type="hidden" id="TwitterId" value="1840000000000000000">
  <a class="button" href="https://dl.snapcdn.app/get?token=${jwt({ url: VIDEO, filename: 'X2Twitter.com_1280p.mp4' })}">下载 MP4 (1280p)</a>
  <a class="button" href="https://dl.snapcdn.app/get?token=${jwt({ url: IMAGE, filename: 'image.jpg' })}">下载 JPG</a>
</div>`;

test('normalizeTweetUrl 覆盖各种写法', () => {
    assert.equal(normalizeTweetUrl('https://x.com/foo/status/1234567890123456'), 'https://x.com/foo/status/1234567890123456');
    assert.equal(normalizeTweetUrl('x.com/foo/statuses/1234567890123456?s=20'), 'https://x.com/foo/status/1234567890123456');
    assert.equal(normalizeTweetUrl('https://twitter.com/bar/status/1234567890123456'), 'https://x.com/bar/status/1234567890123456');
    assert.equal(normalizeTweetUrl('https://fixupx.com/baz/status/1234567890123456'), 'https://x.com/baz/status/1234567890123456');
    assert.equal(normalizeTweetUrl('1234567890123456'), 'https://x.com/i/status/1234567890123456');
    assert.equal(normalizeTweetUrl('随便一段话'), null);
});

test('extractTweetUrls 去重并按行提取', () => {
    const urls = extractTweetUrls('https://x.com/a/status/1111111111111111\nhttps://x.com/a/status/1111111111111111, https://x.com/b/status/2222222222222222');
    assert.deepEqual(urls, ['https://x.com/a/status/1111111111111111', 'https://x.com/b/status/2222222222222222']);
});

test('decodeDownloadUrl 还原 JWT 载荷', () => {
    const got = decodeDownloadUrl(`https://dl.snapcdn.app/get?token=${jwt({ url: VIDEO, filename: 'v.mp4' })}`);
    assert.equal(got.url, VIDEO);
    assert.equal(got.filename, 'v.mp4');
    assert.equal(decodeDownloadUrl('https://dl.snapcdn.app/get?token=bad'), null);
});

test('parseResultHtml 抽出文案、时长、媒体与封面', () => {
    const r = parseResultHtml(html);
    assert.equal(r.tweetId, '1840000000000000000');
    assert.equal(r.title, '一条测试推文 #tag');
    assert.equal(r.duration, '0:12');
    assert.equal(r.items.length, 2);

    const [video, cover] = r.items;
    assert.equal(video.kind, 'video');
    assert.equal(video.quality, 1280);
    assert.equal(video.ext, '.mp4');
    assert.ok(video.downloadUrl.startsWith('https://dl.snapcdn.app/get?'));
    assert.equal(cover.kind, 'cover');
    assert.equal(cover.ext, '.jpg');
});

test('tweetId / user / lang 解析', () => {
    assert.equal(tweetIdOf('https://x.com/foo/status/9876543210'), '9876543210');
    assert.equal(userOf('https://x.com/foo/status/9876543210'), 'foo');
    assert.equal(userOf('https://x.com/i/status/9876543210'), '');
    assert.equal(resolveLang('zh_CN'), 'zh-cn');
    assert.equal(resolveLang('ja_JP'), 'ja');
    assert.equal(resolveLang('en-US'), 'en');
});

test('safeName 去掉非法字符并限长', () => {
    assert.equal(safeName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
    assert.equal(safeName('   .hidden.  '), 'hidden');
    assert.equal(safeName('', 'fallback'), 'fallback');
    assert.ok(safeName('x'.repeat(200)).length <= 80);
});

test('folderFor 按模板生成子目录', () => {
    const settings = { ...DEFAULT_SETTINGS, folderTemplate: '{user}/{tweetId}' };
    const rel = folderFor({ user: 'jack', tweetId: '123' }, settings);
    assert.equal(rel, 'jack/123');
    const flat = folderFor({ user: 'jack', tweetId: '123' }, { ...settings, folderTemplate: 'x2-{date}' });
    assert.match(flat, /^x2-\d{8}$/);
});
