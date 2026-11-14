/**
 * tests/cases/decode.test.mjs — 解码与质量判定
 *
 * 用真实 GBK 字节序列构造，不依赖网络：
 *   贵州茅台（GBK）= B9 F3 D6 DD C3 A9 CC A8
 *   在 UTF-8 下这些字节是无效序列 → 会产生替换字符
 */
import { decodeBody, assessQuality, looksMojibake, parseCharset } from '../../lib/decode.js';

const GBK_GUIZHOU_MAOTAI = new Uint8Array([0xb9, 0xf3, 0xd6, 0xdd, 0xc3, 0xa9, 0xcc, 0xa8]);
const UTF8_SAME = new TextEncoder().encode('贵州茅台');

export const name = 'decode';

export async function run(t) {
  // 1. 声明正确：GBK 字节 + 声明 gbk
  const a = decodeBody(GBK_GUIZHOU_MAOTAI, 'text/html; charset=GBK');
  t.eq(a.text, '贵州茅台', 'GBK 字节按声明解码正确');
  t.eq(a.replacementChars, 0, '声明正确时零替换字符');
  t.eq(a.encodingOk, true, 'encodingOk=true');

  // 2. 声明错误：GBK 字节但声明 utf-8 → 必须回退
  const b = decodeBody(GBK_GUIZHOU_MAOTAI, 'text/html; charset=utf-8');
  t.eq(b.text, '贵州茅台', '声明错误时回退 gb18030 仍能解对');
  t.eq(b.encodingOk, true, '回退后零替换字符');
  t.eq(b.encoding, 'gb18030', '记录实际使用的编码');

  // 3. 无声明：GBK 字节 → 默认 utf-8 失败后回退
  const c = decodeBody(GBK_GUIZHOU_MAOTAI, 'text/html');
  t.eq(c.text, '贵州茅台', '无 charset 声明时也能回退解对');

  // 4. UTF-8 字节不误判
  const d = decodeBody(UTF8_SAME, 'application/json; charset=UTF-8');
  t.eq(d.text, '贵州茅台', 'UTF-8 内容正常解码');
  t.eq(d.encoding, 'utf-8', 'UTF-8 不触发回退');

  // 5. 纯坏字节
  const junk = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
  const e = decodeBody(junk, 'text/html; charset=utf-8');
  t.eq(e.encodingOk, false, '无法解码时 encodingOk=false');
  t.ok(e.replacementChars > 0, '坏字节产生替换字符');

  // 6. 固化 mojibake 检测
  t.eq(looksMojibake('1~锟斤拷锟斤拷茅台'), true, '识别「锟斤拷」类固化乱码');
  t.eq(looksMojibake('贵州茅台'), false, '正常中文不误判');

  // 7. charset 解析
  t.eq(parseCharset('text/html; charset=GB18030'), 'gb18030', '解析 GB18030');
  t.eq(parseCharset('application/json; charset="UTF-8"'), 'utf-8', '解析带引号的 UTF-8');
  t.eq(parseCharset('application/json'), null, '无 charset 返回 null');

  // 8. 质量判定
  const q1 = assessQuality('<html>' + '内容'.repeat(200) + '</html>', 'text/html');
  t.eq(q1.loginWall, false, '正常页面不判登录墙');
  t.eq(q1.isArticle, true, '长 HTML 判为正文页');

  const q2 = assessQuality('<div>请先登录后查看</div>', 'text/html');
  t.eq(q2.loginWall, true, '识别登录墙');

  const q3 = assessQuality('<div>请输入验证码</div>', 'text/html');
  t.eq(q3.captcha, true, '识别验证码');

  const q4 = assessQuality('短', 'text/html');
  t.eq(q4.tooShort, true, '短内容标记 tooShort');
}
