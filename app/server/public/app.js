/* X2 媒体下载器 · 前端（无框架，ESM） */

const params = new URLSearchParams(location.search);
const forcedTheme = params.get('theme');
if (forcedTheme === 'dark' || forcedTheme === 'light') {
    document.documentElement.dataset.theme = forcedTheme;
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
    settings: null,
    results: [],       // [{ok, url, user, tweetId, caption, duration, thumbnail, items[]}]
    jobs: new Map(),   // jobId -> {timer, job}
    library: [],
    pollTimer: null,
    cooldownUntil: 0   // 接口限流冷却截止时间（毫秒时间戳）
};

// ---------------------------------------------------------------- 基础工具

function toast(msg, isError = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('err', !!isError);
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 2600);
}

function bytes(n) {
    const v = Number(n) || 0;
    if (!v) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let x = v;
    while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
    return `${x >= 100 || i === 0 ? Math.round(x) : x.toFixed(1)} ${units[i]}`;
}

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

async function api(path, options = {}) {
    const res = await fetch(path, {
        method: options.method || 'GET',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch { data = { ok: false, error: `HTTP ${res.status}` }; }
    if (!res.ok || data.ok === false) {
        const e = new Error((data && data.error) || `HTTP ${res.status}`);
        e.status = res.status;
        e.data = data;
        throw e;
    }
    return data;
}

const KIND_LABEL = { video: '视频', image: '图片', cover: '封面' };
const STATE_LABEL = { pending: '等待', downloading: '下载中', done: '完成', failed: '失败', skipped: '跳过' };

// ---------------------------------------------------------------- 启动

async function boot() {
    bindUi();
    try {
        const st = await api('/api/state');
        state.settings = st.settings;
        $('#serviceMeta').textContent = `v${st.version} · 端口 ${st.port} · Node ${st.env.node} · 已存 ${st.stats.count} 个文件`;
        $('#libCount').textContent = st.stats.count;
        $('#optCover').checked = !!st.settings.saveCover;
        fillSettingsForm(st.settings);
        fillStatus(st);
        if (!st.settings.saveCover) $('#setCover').checked = false;
        if (st.cooldown && st.cooldown.active) startCooldown(st.cooldown.waitMs);
        // 允许直接开在某个页签：/?tab=library
        const tab = params.get('tab');
        if (['download', 'library', 'status'].includes(tab)) switchTab(tab);
    } catch (err) {
        $('#serviceMeta').textContent = '服务未就绪：' + err.message;
        toast('连接后端失败：' + err.message, true);
    }
    loadLibrary();
}

function bindUi() {
    $$('#tabs .tab').forEach((btn) => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    $('#btnResolve').addEventListener('click', doResolve);
    $('#btnClear').addEventListener('click', () => { $('#links').value = ''; renderResults(); });
    $('#links').addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') doResolve();
    });
    $('#btnSettings').addEventListener('click', () => { $('#drawer').hidden = false; });
    $('#btnCloseDrawer').addEventListener('click', () => { $('#drawer').hidden = true; });
    $('#drawer').addEventListener('click', (e) => { if (e.target.id === 'drawer') $('#drawer').hidden = true; });
    $('#btnSaveSettings').addEventListener('click', saveSettingsFromForm);
    $('#btnResetSettings').addEventListener('click', () => { fillSettingsForm(state.settings); toast('已还原为当前生效设置'); });
    $('#btnRefreshLib').addEventListener('click', loadLibrary);
    $('#btnDiagnose').addEventListener('click', runDiagnose);
    $('#btnLog').addEventListener('click', toggleLog);

    let searchTimer = null;
    $('#search').addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(loadLibrary, 220);
    });
}

function switchTab(name) {
    $$('#tabs .tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === name));
    $$('.panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === name));
    if (name === 'library') loadLibrary();
}

// ---------------------------------------------------------------- 解析

/**
 * 默认勾选哪些：视频只勾最高画质那一条（同一条推文的 1080p/852p/568p 是同一素材的不同清晰度，
 * 全勾会重复下载）；纯图片推文没有画质之分，图片全勾；封面默认不勾。
 */
function defaultPick(items) {
    const list = items || [];
    const videos = list.filter((it) => it.kind === 'video');
    if (videos.length) {
        const best = videos.reduce((a, b) => ((b.quality || 0) > (a.quality || 0) ? b : a), videos[0]);
        return [best.url];
    }
    return list.filter((it) => it.kind === 'image').map((it) => it.url);
}

async function doResolve() {
    const raw = $('#links').value.trim();
    if (!raw) { toast('先粘一条推文链接', true); return; }
    if (state.cooldownUntil > Date.now()) { toast('接口还在限流冷却中，等倒计时走完', true); return; }
    const btn = $('#btnResolve');
    btn.disabled = true;
    btn.textContent = '解析中…';
    try {
        const data = await api('/api/resolve', {
            method: 'POST',
            body: { text: raw, lang: state.settings ? state.settings.lang : 'zh_cn' }
        });
        if (data.cooldown) startCooldown(data.cooldown.waitMs);
        const autoBest = !state.settings || state.settings.autoBestQuality !== false;
        state.results = data.tweets.map((t, i) => ({
            ...t,
            key: t.url || `err-${i}`,
            selected: new Set(autoBest ? defaultPick(t.items) : (t.items || []).filter((it) => it.kind !== 'cover').map((it) => it.url))
        }));
        renderResults();
        const okCount = state.results.filter((t) => t.ok).length;
        if (data.ratelimit) toast('接口限流了，等倒计时结束再解析', true);
        else toast(okCount ? `解析到 ${okCount} 条推文` : '没有解析成功，看看下面的原因', !okCount);
    } catch (err) {
        if (err.data && err.data.cooldown) startCooldown(err.data.cooldown.waitMs);
        toast('解析失败：' + err.message, true);
    } finally {
        if (!state.cooldownUntil || state.cooldownUntil <= Date.now()) {
            btn.disabled = false;
            btn.textContent = '解析媒体';
        }
    }
}

// ---------------------------------------------------------------- 限流倒计时

let cooldownTimer = null;

function startCooldown(waitMs) {
    const ms = Math.max(0, Number(waitMs) || 0);
    if (!ms) return;
    state.cooldownUntil = Date.now() + ms;
    const btn = $('#btnResolve');
    clearInterval(cooldownTimer);
    const tick = () => {
        const left = state.cooldownUntil - Date.now();
        if (left <= 0) {
            clearInterval(cooldownTimer);
            cooldownTimer = null;
            state.cooldownUntil = 0;
            btn.disabled = false;
            btn.textContent = '解析媒体';
            btn.classList.remove('is-cooling');
            return;
        }
        const sec = Math.ceil(left / 1000);
        btn.disabled = true;
        btn.classList.add('is-cooling');
        btn.textContent = sec >= 60
            ? `限流 ${Math.ceil(sec / 60)}分${sec % 60 ? '钟' : ''}…`
            : `限流 ${sec}s`;
    };
    tick();
    cooldownTimer = setInterval(tick, 500);
}

function renderResults() {
    const box = $('#results');
    const guide = document.getElementById('guide');
    if (!state.results.length) {
        box.innerHTML = '';
        if (guide) guide.hidden = false;
        return;
    }
    if (guide) guide.hidden = true;

    box.innerHTML = state.results.map((tw, idx) => {
        if (!tw.ok) {
            return `<article class="tweet">
                <div class="tweet-head">
                    <div class="tweet-meta">
                        <p class="tweet-title err-text">解析失败</p>
                        <div class="tweet-sub">${esc(tw.url || '')} · ${esc(tw.error || '未知错误')}</div>
                    </div>
                </div>
            </article>`;
        }
        const items = tw.items.map((it) => {
            const checked = tw.selected.has(it.url) ? 'checked' : '';
            return `<label class="item">
                <input type="checkbox" data-tweet="${idx}" data-url="${esc(it.url)}" ${checked} />
                <span class="tag ${it.kind}">${KIND_LABEL[it.kind] || it.kind}</span>
                <span class="item-name">${esc(it.filename || it.url)}</span>
                <span class="tag">${it.quality ? it.quality + 'p' : (it.ext || '')}</span>
            </label>`;
        }).join('');

        return `<article class="tweet" data-idx="${idx}">
            <div class="tweet-head">
                ${tw.thumbnail ? `<img class="tweet-cover" src="${esc(tw.thumbnail)}" alt="" referrerpolicy="no-referrer" />` : '<div class="tweet-cover"></div>'}
                <div class="tweet-meta">
                    <p class="tweet-title">${esc(tw.caption || '（无文案）')}</p>
                    <div class="tweet-sub">
                        @${esc(tw.user || '—')} · ${esc(tw.tweetId || '')}
                        ${tw.duration ? ' · ' + esc(tw.duration) : ''} · ${tw.items.length} 个媒体 ·
                        <a href="${esc(tw.url)}" target="_blank" rel="noreferrer">原文</a>
                    </div>
                </div>
            </div>
            <div class="items">${items}</div>
            <div class="tweet-foot">
                <label class="check"><input type="checkbox" data-all="${idx}" /> 全选</label>
                <span class="hint">${tw.items.some((it) => it.kind === 'video') ? '同一素材的多个清晰度默认只勾最高的一条' : ''}</span>
                <span class="grow"></span>
                <button class="btn tiny ghost" data-copy="${idx}">仅复制直链</button>
                <button class="btn tiny primary" data-dl="${idx}">下载选中项</button>
            </div>
        </article>`;
    }).join('');

    $$('input[type="checkbox"][data-tweet]', box).forEach((cb) => {
        cb.addEventListener('change', () => {
            const tw = state.results[Number(cb.dataset.tweet)];
            if (!tw) return;
            if (cb.checked) tw.selected.add(cb.dataset.url);
            else tw.selected.delete(cb.dataset.url);
            const all = $('input[data-all="' + cb.dataset.tweet + '"]', box);
            if (all) all.checked = tw.selected.size === tw.items.length;
        });
    });
    $$('input[data-all]', box).forEach((cb) => {
        cb.addEventListener('change', () => {
            const tw = state.results[Number(cb.dataset.all)];
            if (!tw) return;
            tw.selected = cb.checked ? new Set(tw.items.map((i) => i.url)) : new Set();
            renderResults();
        });
    });
    $$('button[data-dl]', box).forEach((btn) => {
        btn.addEventListener('click', () => startDownload(Number(btn.dataset.dl), btn));
    });
    $$('button[data-copy]', box).forEach((btn) => {
        btn.addEventListener('click', () => copyLinks(Number(btn.dataset.copy)));
    });
}

async function copyLinks(idx) {
    const tw = state.results[idx];
    if (!tw) return;
    const text = tw.items.filter((i) => tw.selected.has(i.url)).map((i) => i.url).join('\n');
    if (!text) { toast('没有选中项', true); return; }
    try {
        await navigator.clipboard.writeText(text);
        toast('直链已复制，可粘进下载器');
    } catch {
        toast('浏览器不允许写剪贴板', true);
    }
}

async function startDownload(idx, btn) {
    const tw = state.results[idx];
    if (!tw || !tw.ok) return;
    const items = tw.items.filter((i) => tw.selected.has(i.url));
    if (!items.length) { toast('先勾选要下载的媒体', true); return; }

    btn.disabled = true;
    btn.textContent = '已提交';
    try {
        const data = await api('/api/download', {
            method: 'POST',
            body: {
                tweet: {
                    url: tw.url,
                    user: tw.user,
                    tweetId: tw.tweetId,
                    caption: tw.caption,
                    thumbnail: tw.thumbnail || ''
                },
                items,
                saveCover: $('#optCover').checked
            }
        });
        trackJob(data.job.id);
        toast('已加入下载队列');
    } catch (err) {
        toast('提交失败：' + err.message, true);
        btn.disabled = false;
        btn.textContent = '下载选中项';
    }
}

// ---------------------------------------------------------------- 任务轮询

function trackJob(id) {
    pollJob(id);
    if (!state.pollTimer) {
        state.pollTimer = setInterval(() => {
            const ids = [...state.jobs.keys()].filter((k) => state.jobs.get(k).timer !== null);
            if (!ids.length) return;
            ids.forEach(pollJob);
        }, 700);
    }
}

async function pollJob(id) {
    const slot = state.jobs.get(id) || { timer: true, job: null, speed: 0, last: null };
    state.jobs.set(id, slot);
    try {
        const data = await api('/api/job?id=' + encodeURIComponent(id));
        slot.job = data.job;
        sampleSpeed(slot, data.job);
        if (data.job.status === 'done' || data.job.status === 'failed') {
            slot.timer = null;
            if (data.job.status === 'done') loadLibrary();
            setTimeout(() => { const el = $('#job-' + id); if (el) el.remove(); }, 8000);
        }
    } catch (err) {
        slot.timer = null;
        slot.error = err.message;
    }
    renderJobs();
}

/** 用两次轮询之间的增量算速度，指数平滑一下，避免数字乱跳 */
function sampleSpeed(slot, job) {
    const running = job.status === 'running';
    if (!running) { slot.speed = 0; slot.last = null; return; }
    const now = Date.now();
    const bytes = (job.items || []).reduce((sum, i) => sum + (i.received || 0), 0);
    const prev = slot.last;
    slot.last = { at: now, bytes };
    if (!prev) return;
    const dt = (now - prev.at) / 1000;
    if (dt <= 0) return;
    const inst = Math.max(0, (bytes - prev.bytes) / dt);
    slot.speed = slot.speed ? slot.speed * 0.6 + inst * 0.4 : inst;
}

/** 总体百分比：有字节总量就按字节算，否则退回按条目算 */
function jobPercent(job) {
    const total = job.bytesTotal || 0;
    if (total > 0) return Math.min(100, Math.round(((job.bytesReceived || 0) / total) * 100));
    const n = job.total || 1;
    return Math.round(((job.progress || 0) / n) * 100);
}

function fmtEta(sec) {
    const s = Math.max(0, Math.round(sec));
    if (s < 60) return s + ' 秒';
    if (s < 3600) return Math.floor(s / 60) + ' 分' + (s % 60 ? (s % 60) + ' 秒' : '');
    return Math.floor(s / 3600) + ' 小时' + Math.round((s % 3600) / 60) + ' 分';
}

function elapsedText(job) {
    if (!job.startedAt) return '';
    const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
    const sec = Math.max(0, Math.round((end - Date.parse(job.startedAt)) / 1000));
    return sec < 1 ? '不到 1 秒' : fmtEta(sec);
}

function renderJobs() {
    const box = $('#jobPanel');
    const entries = [...state.jobs.entries()].filter(([, s]) => s.job);
    if (!entries.length) { box.innerHTML = ''; return; }

    box.innerHTML = entries.map(([id, slot]) => {
        const job = slot.job;
        const pct = jobPercent(job);
        const running = job.status === 'running' || job.status === 'queued';
        const unknownTotal = !(job.bytesTotal > 0);
        const recv = job.bytesReceived || 0;
        const tot = job.bytesTotal || 0;
        const speed = slot.speed || 0;
        const eta = speed > 0 && tot > recv ? (tot - recv) / speed : 0;

        const allItemsDone = (job.items || []).length > 0
            && (job.items || []).every((i) => ['done', 'failed', 'skipped'].includes(i.state));
        const headState = job.status === 'queued' ? '排队中'
            : job.status === 'running' && allItemsDone ? '收尾中（封面 / 预览图）'
            : job.status === 'running' ? `下载中 ${pct}%`
            : job.status === 'failed' ? '失败'
            : `完成 ${job.progress || 0}/${job.total || 0}`;

        const meta = [];
        if (tot > 0) meta.push(`${bytes(recv)} / ${bytes(tot)}`);
        else if (recv > 0) meta.push(bytes(recv));
        if (running && speed > 0) meta.push(`${bytes(speed)}/s`);
        if (running && eta > 0) meta.push(`还剩 ${fmtEta(eta)}`);
        if (!running && job.startedAt) meta.push(`用时 ${elapsedText(job)}`);

        const rows = (job.items || []).map((it) => {
            const bad = it.state === 'failed';
            const down = it.state === 'downloading';
            const itemPct = it.total ? Math.min(100, Math.round((it.received / it.total) * 100))
                : (it.state === 'done' ? 100 : 0);
            const sizeText = it.total && down ? `${bytes(it.received || 0)} / ${bytes(it.total)}`
                : (it.size ? bytes(it.size) : '');
            const tail = down ? `${itemPct}%` : sizeText;
            const bar = down
                ? `<div class="minibar${it.total ? '' : ' is-indeterminate'}"><i style="width:${itemPct}%"></i></div>`
                : '';
            return `<div class="job-item">
                <div class="progress-line">
                    <span class="tag ${bad ? 'cover' : it.kind}">${KIND_LABEL[it.kind] || it.kind}</span>
                    <span class="item-file">${esc(it.filename || '')}</span>
                    <span class="item-state">${STATE_LABEL[it.state] || it.state}${it.route ? ' · ' + esc(it.route) : ''}</span>
                    <span class="item-num">${tail}</span>
                </div>
                ${bar}
                ${bad ? `<div class="progress-line err-text">${esc(it.error || '')}</div>` : ''}
            </div>`;
        }).join('');

        return `<div class="job" id="job-${job.id}">
            <div class="job-head">
                <span class="job-title">@${esc((job.tweet && job.tweet.user) || '—')} · ${esc((job.tweet && job.tweet.tweetId) || '')}</span>
                <span class="job-state">${headState}</span>
            </div>
            <div class="bar${running && unknownTotal ? ' is-indeterminate' : ''}"><i style="width:${pct}%"></i></div>
            ${meta.length ? `<div class="job-meta">${meta.join(' · ')}</div>` : ''}
            ${rows}
        </div>`;
    }).join('');
}

// ---------------------------------------------------------------- 资源库

async function loadLibrary() {
    const q = $('#search').value.trim();
    try {
        const data = await api('/api/library?limit=300&q=' + encodeURIComponent(q));
        state.library = data.items;
        $('#libCount').textContent = data.stats.count;
        $('#libStats').textContent = `${data.stats.count} 个文件 · ${data.stats.tweets} 条推文 · ${bytes(data.stats.bytes)}`;
        renderGrid();
        if (state.settings) {
            $('#libStats').title = '下载目录：' + (data.root || state.settings.root);
        }
        $('#serviceMeta').textContent = $('#serviceMeta').textContent.replace(/已存 \d+ 个文件/, `已存 ${data.stats.count} 个文件`);
    } catch (err) {
        toast('读取资源库失败：' + err.message, true);
    }
}

function renderGrid() {
    const grid = $('#grid');
    const empty = $('#gridEmpty');
    if (!state.library.length) {
        grid.innerHTML = '';
        empty.hidden = false;
        return;
    }
    empty.hidden = true;
    $('#grid').innerHTML = state.library.map((it) => {
        const isImg = it.kind === 'image' || it.kind === 'cover' || /^image\//.test(it.mime || '');
        const src = `/api/thumb?id=${encodeURIComponent(it.id)}`;
        const thumb = isImg
            ? `<a href="/api/file?id=${encodeURIComponent(it.id)}" target="_blank" rel="noreferrer"><img loading="lazy" src="${src}" alt="" /></a>`
            : `<a href="/api/file?id=${encodeURIComponent(it.id)}" target="_blank" rel="noreferrer" title="播放">
                   <img loading="lazy" src="${src}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'glyph',textContent:'▶'}))" />
                   <span class="play">▶</span>
               </a>`;
        const name = it.relPath.split('/').pop();
        return `<article class="tile">
            <div class="tile-thumb">${thumb}</div>
            <div class="tile-body">
                <div class="tile-name" title="${esc(it.relPath)}">${esc(name)}</div>
                <div class="tile-sub">@${esc(it.user || '—')} · ${bytes(it.size)}${it.quality ? ' · ' + it.quality + 'p' : ''}</div>
                <div class="tile-sub">${esc((it.caption || '').slice(0, 60) || it.createdAt.slice(0, 10))}</div>
            </div>
            <div class="tile-actions">
                <a class="btn tiny ghost" href="/api/file?id=${encodeURIComponent(it.id)}" target="_blank" rel="noreferrer">打开</a>
                <a class="btn tiny ghost" href="/api/file?id=${encodeURIComponent(it.id)}&dl=1">下载</a>
                <span class="grow"></span>
                <button class="btn tiny danger" data-del="${esc(it.id)}">删</button>
            </div>
        </article>`;
    }).join('');

    $$('button[data-del]').forEach((btn) => {
        btn.addEventListener('click', () => deleteItem(btn.dataset.del));
    });
}

async function deleteItem(id) {
    const item = state.library.find((i) => i.id === id);
    if (!item) return;
    const withFile = confirm(`删除记录并同时删掉磁盘文件？\n\n${item.relPath}\n\n确定 = 连文件一起删；取消 = 只删记录`);
    try {
        await api('/api/item/delete', { method: 'POST', body: { id, withFile } });
        toast(withFile ? '文件和记录都已删除' : '只删除了记录');
        loadLibrary();
    } catch (err) {
        toast('删除失败：' + err.message, true);
    }
}

// ---------------------------------------------------------------- 设置

function fillSettingsForm(s) {
    if (!s) return;
    $('#setRoot').value = s.root || '';
    $('#setFolder').value = s.folderTemplate || '';
    $('#setConcurrency').value = s.concurrency || 2;
    $('#setConflict').value = s.conflict || 'rename';
    $('#setLang').value = s.lang || 'zh_cn';
    $('#setProxy').value = s.proxy || '';
    $('#setCover').checked = !!s.saveCover;
    $('#setAutoBest').checked = s.autoBestQuality !== false;
    $('#optCover').checked = !!s.saveCover;
}

async function saveSettingsFromForm() {
    const settings = {
        root: $('#setRoot').value.trim(),
        folderTemplate: $('#setFolder').value.trim(),
        concurrency: Number($('#setConcurrency').value) || 2,
        conflict: $('#setConflict').value,
        lang: $('#setLang').value,
        proxy: $('#setProxy').value.trim(),
        saveCover: $('#setCover').checked,
        autoBestQuality: $('#setAutoBest').checked
    };
    try {
        const data = await api('/api/settings', { method: 'POST', body: { settings } });
        state.settings = data.settings;
        fillSettingsForm(data.settings);
        $('#drawer').hidden = true;
        toast('设置已保存');
        const st = await api('/api/state');
        $('#serviceMeta').textContent = `v${st.version} · 端口 ${st.port} · Node ${st.env.node} · 已存 ${st.stats.count} 个文件`;
    } catch (err) {
        toast('保存失败：' + err.message, true);
    }
}

// ---------------------------------------------------------------- 状态页

function fillStatus(st) {
    $('#statusKv').innerHTML = `
        <dt>版本</dt><dd>v${esc(st.version)}</dd>
        <dt>服务端口</dt><dd>${esc(String(st.port))}</dd>
        <dt>Node</dt><dd>${esc(st.env.node)}</dd>
        <dt>安装目录</dt><dd>${esc(st.env.appdest)}</dd>
        <dt>数据目录</dt><dd>${esc(st.env.var)}</dd>
        <dt>下载目录</dt><dd>${esc(st.root)}</dd>
        <dt>已入库</dt><dd>${st.stats.count} 个文件 / ${st.stats.tweets} 条推文 / ${bytes(st.stats.bytes)}</dd>`;
}

async function runDiagnose() {
    const box = $('#diagBox');
    box.innerHTML = '<div class="diag-row">正在诊断…</div>';
    try {
        const d = await api('/api/diagnose');
        const rows = d.results.map((r) => `<div class="diag-row">
            <span class="dot ${r.ok ? 'ok' : 'bad'}"></span>
            <span style="flex:1">${esc(r.name)}</span>
            <span>${r.ok ? 'HTTP ' + r.status : esc(r.error || '失败')}</span>
            <span>${r.ms}ms</span>
        </div>`).join('');
        box.innerHTML = rows + `<div class="diag-row">
            <span class="dot ${d.rootWritable ? 'ok' : 'bad'}"></span>
            <span style="flex:1">下载目录可写</span>
            <span>${esc(d.root)}</span>
        </div>
        <div class="diag-row"><span class="dot ${d.proxy ? 'ok' : 'bad'}"></span>
            <span style="flex:1">代理</span><span>${d.proxy ? esc(d.proxy) : '未配置'}</span>
        </div>
        <div class="diag-row"><span class="dot ok"></span><span style="flex:1">运行环境</span>
            <span>${esc(d.node)} · ${esc(d.platform)} · ${d.cpus} 核 · 运行 ${d.uptime}s</span>
        </div>`;
        $('#statusKv').insertAdjacentHTML('beforeend', '');
    } catch (err) {
        box.innerHTML = `<div class="diag-row err-text">诊断失败：${esc(err.message)}</div>`;
    }
}

async function toggleLog() {
    const pre = $('#logBox');
    if (!pre.hidden) { pre.hidden = true; return; }
    try {
        const d = await api('/api/log?lines=300');
        pre.textContent = d.log || '（日志为空）';
        pre.hidden = false;
        pre.scrollTop = pre.scrollHeight;
    } catch (err) {
        toast('读取日志失败：' + err.message, true);
    }
}

boot();
