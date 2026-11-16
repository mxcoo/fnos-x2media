/**
 * HTTP(S) 基础能力：普通文本请求、流式下载、以及可选的 HTTP 代理（CONNECT 隧道）。
 *
 * 只用 Node 内置模块，不引第三方依赖 —— FPK 里不需要 node_modules。
 * 代理来源优先级：显式传参 > 进程环境（HTTPS_PROXY / HTTP_PROXY / ALL_PROXY）。
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const DEFAULT_HEADERS = {
    'User-Agent': UA,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
};

export function envProxy() {
    const raw =
        process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy ||
        process.env.ALL_PROXY ||
        process.env.all_proxy ||
        '';
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed) || /^socks/i.test(trimmed)) return trimmed;
    return 'http://' + trimmed;
}

/** socks 协议本实现不支持，明确返回 null，避免出现"设置了代理却无效"的静默失败 */
function usableProxy(proxy) {
    if (!proxy) return null;
    if (/^socks/i.test(proxy)) return null;
    return proxy;
}

function parseProxy(proxy) {
    const p = new URL(/^https?:\/\//i.test(proxy) ? proxy : 'http://' + proxy);
    return {
        host: p.hostname,
        port: Number(p.port) || 8080,
        auth: p.username
            ? 'Basic ' + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')
            : null
    };
}

/** 在代理上开一条到 host:port 的隧道；https 目标再套一层 TLS */
function tunnel(proxy, host, port, { servername, timeout }) {
    const { host: phost, port: pport, auth } = parseProxy(proxy);
    return new Promise((resolve, reject) => {
        const socket = net.connect(pport, phost);
        const fail = (err) => {
            socket.destroy();
            reject(err);
        };
        socket.setTimeout(timeout || 20000, () => fail(new Error(`proxy timeout ${phost}:${pport}`)));
        socket.once('error', fail);
        socket.once('connect', () => {
            const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`];
            if (auth) lines.push(`Proxy-Authorization: ${auth}`);
            socket.write(lines.join('\r\n') + '\r\n\r\n');

            let buf = '';
            const onData = (chunk) => {
                buf += chunk.toString('latin1');
                const idx = buf.indexOf('\r\n\r\n');
                if (idx < 0) return;
                socket.removeListener('data', onData);
                socket.removeAllListeners('timeout');
                const status = Number((/^HTTP\/1\.[01] (\d{3})/.exec(buf) || [])[1]);
                if (status !== 200) return fail(new Error(`proxy CONNECT ${status}`));
                if (port === 443) {
                    const secure = tls.connect({ socket, servername: servername || host });
                    secure.once('error', fail);
                    secure.once('secureConnect', () => resolve(secure));
                } else {
                    resolve(socket);
                }
            };
            socket.on('data', onData);
        });
    });
}

function openRequest(target, { method = 'GET', headers = {}, body = null, timeout = 30000, proxy = null }) {
    const url = target instanceof URL ? target : new URL(target);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const port = Number(url.port) || (isHttps ? 443 : 80);
    const useProxy = usableProxy(proxy);

    const options = {
        method,
        headers,
        host: url.hostname,
        port,
        path: url.pathname + url.search
    };

    if (!useProxy) {
        return { req: lib.request(url, options), isHttps, url };
    }
    if (!isHttps) {
        // 明文目标：把绝对 URI 直接发给代理
        const { host: phost, port: pport, auth } = parseProxy(useProxy);
        const h = { ...headers, Host: url.host };
        if (auth) h['Proxy-Authorization'] = auth;
        return {
            req: http.request({ host: phost, port: pport, method, path: url.toString(), headers: h }),
            isHttps,
            url
        };
    }
    // https 目标：先 CONNECT 隧道，响应前无法同步建连，这里用惰性连接
    return {
        lazy: () =>
            tunnel(useProxy, url.hostname.replace(/^\[|\]$/g, ''), port, {
                servername: url.hostname,
                timeout
            }).then(
                (socket) =>
                    new Promise((resolve, reject) => {
                        const req = https.request({ ...options, createConnection: () => socket }, resolve);
                        req.once('error', reject);
                        req.end(body || undefined);
                    })
            ),
        isHttps,
        url,
        body
    };
}

/** 发起请求，把整个响应体读成 utf8 字符串（用于 x2twitter 的 JSON 接口） */
export async function requestText(target, opts = {}) {
    const { timeout = 30000, redirects = 0 } = opts;
    const url = target instanceof URL ? target.toString() : String(target);
    const headers = { ...DEFAULT_HEADERS, ...(opts.headers || {}) };

    const res = await new Promise((resolve, reject) => {
        const handle = openRequest(url, { ...opts, headers, timeout });
        const onResponse = (res) => {
            const status = res.statusCode || 0;
            if (status >= 300 && status < 400 && res.headers.location && redirects < 5) {
                res.resume();
                const next = new URL(res.headers.location, url).toString();
                resolve({ redirect: next });
                return;
            }
            const chunks = [];
            res.setEncoding('utf8');
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status, headers: res.headers, body: chunks.join('') }));
            res.on('error', reject);
        };

        if (handle.lazy) {
            handle.lazy().then(onResponse, reject);
        } else {
            const req = handle.req;
            req.on('response', onResponse);
            req.on('error', reject);
            req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
            if (opts.body) req.write(opts.body);
            req.end();
        }
    });

    if (res.redirect) return requestText(res.redirect, { ...opts, redirects: redirects + 1 });
    return res;
}

/** 打开流式响应（用于下载媒体文件，不占内存） */
export async function requestStream(target, opts = {}) {
    const { timeout = 60000, redirects = 0 } = opts;
    const url = target instanceof URL ? target.toString() : String(target);
    const headers = { ...DEFAULT_HEADERS, ...(opts.headers || {}) };

    const res = await new Promise((resolve, reject) => {
        const handle = openRequest(url, { ...opts, headers, timeout });
        const onResponse = (res) => {
            const status = res.statusCode || 0;
            if (status >= 300 && status < 400 && res.headers.location && redirects < 6) {
                res.resume();
                resolve({ redirect: new URL(res.headers.location, url).toString() });
                return;
            }
            resolve({ status, headers: res.headers, stream: res });
        };

        if (handle.lazy) {
            handle.lazy().then(onResponse, reject);
        } else {
            const req = handle.req;
            req.on('response', onResponse);
            req.on('error', reject);
            req.setTimeout(timeout, () => req.destroy(new Error('连接超时')));
            req.end();
        }
    });

    if (res.redirect) return requestStream(res.redirect, { ...opts, redirects: redirects + 1 });
    return res;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
