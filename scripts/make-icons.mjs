#!/usr/bin/env node
/**
 * 生成 fnOS 需要的图标（无第三方依赖，纯 Node 手写 PNG 编码）。
 *
 *   ICON.PNG        64x64   （应用中心列表）
 *   ICON_256.PNG    256x256 （详情页 / 桌面）
 *   app/ui/images/icon_64.png / icon_256.png （桌面入口 app/ui/config 引用）
 *
 * 图形：135° 紫→青渐变圆角方块 + 白色「下载」符号（下箭头 + 底座横条）。
 * 采样方式：4× 超采样后盒式降采样，保证 64px 下边缘依然干净。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// ---------------------------------------------------------------- PNG 编码

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0; // filter: none
        rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

// ---------------------------------------------------------------- 几何工具

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
    const qx = Math.abs(px - cx) - (hw - r);
    const qy = Math.abs(py - cy) - (hh - r);
    const ax = Math.max(qx, 0);
    const ay = Math.max(qy, 0);
    return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdTriangle(px, py, ax, ay, bx, by, cx, cy) {
    // 三角形内部距离（负值在内），用三条边半平面近似，顶点处不做圆角
    const e0 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    const e1 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
    const e2 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
    const inside = e0 >= 0 && e1 >= 0 && e2 >= 0;
    const scale = Math.hypot(bx - ax, by - ay) + Math.hypot(cx - bx, cy - by) + Math.hypot(ax - cx, ay - cy);
    return inside ? -1 / scale : 1 / scale;
}

/** 单位坐标（0..1）下的形状遮罩，返回 0..1 覆盖率 */
function sampleGlyph(u, v) {
    // 下箭头竖杆
    const bar = sdRoundRect(u, v, 0.5, 0.335, 0.055, 0.185, 0.018) < 0;
    // 箭头三角
    const tri = sdTriangle(u, v, 0.5, 0.705, 0.268, 0.452, 0.732, 0.452) < 0;
    // 底座横条
    const base = sdRoundRect(u, v, 0.5, 0.828, 0.182, 0.036, 0.018) < 0;
    return bar || tri || base ? 1 : 0;
}

function sampleBg(u, v) {
    const d = sdRoundRect(u, v, 0.5, 0.5, 0.5, 0.5, 0.225);
    return clamp01(0.5 - d * 512); // 近似抗锯齿边缘
}

// 渐变：#6d5efc（左上）→ #12b8d8（右下）
function gradient(u, v) {
    const t = clamp01((u * 0.65 + v * 0.75) / 1.4);
    const lerp = (a, b) => Math.round(a + (b - a) * t);
    return [lerp(0x6d, 0x12), lerp(0x5e, 0xb8), lerp(0xfc, 0xd8)];
}

// ---------------------------------------------------------------- 渲染

const SS = 4; // 每轴超采样倍数

function render(size) {
    const out = Buffer.alloc(size * size * 4);
    const n = SS * SS;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            for (let sy = 0; sy < SS; sy++) {
                for (let sx = 0; sx < SS; sx++) {
                    const u = (x + (sx + 0.5) / SS) / size;
                    const v = (y + (sy + 0.5) / SS) / size;
                    const bgA = sampleBg(u, v);
                    if (bgA <= 0 && sampleGlyph(u, v) === 0) continue;
                    const [gr, gg, gb] = gradient(u, v);
                    const glyph = sampleGlyph(u, v);
                    // 白色符号按覆盖率混合到渐变底色
                    r += (gr + (255 - gr) * glyph) * bgA;
                    g += (gg + (255 - gg) * glyph) * bgA;
                    b += (gb + (255 - gb) * glyph) * bgA;
                    a += bgA;
                }
            }
            const i = (y * size + x) * 4;
            if (a > 0) {
                out[i] = Math.round(r / a);
                out[i + 1] = Math.round(g / a);
                out[i + 2] = Math.round(b / a);
                out[i + 3] = Math.round((a / n) * 255);
            }
        }
    }
    return encodePng(size, size, out);
}

function save(path, buf) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, buf);
    console.log('wrote', path, buf.length + 'B');
}

save(resolve(ROOT, 'ICON.PNG'), render(64));
save(resolve(ROOT, 'ICON_256.PNG'), render(256));
save(resolve(ROOT, 'app/ui/images/icon_64.png'), render(64));
save(resolve(ROOT, 'app/ui/images/icon_256.png'), render(256));
