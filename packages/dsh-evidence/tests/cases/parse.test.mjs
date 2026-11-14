/**
 * tests/cases/parse.test.mjs — 抽取（article / table / json）
 *
 * 断言重点：
 *   1. 噪声（脚本、导航、页脚、head）不进正文
 *   2. 每个 span 都能在返回的 text 上 slice 出对应片段
 *   3. 实体解码、textSeg 与 db.js 的 segmentCJK 一致（中文逐字空格）
 *   4. 表格：caption / 行数 / 合并单元格与错行要标出来
 *   5. JSON 目标：解析成功给出 json，解析失败给出 JSON_PARSE_FAILED
 */
import { extract, decodeEntities, stripTags, joinLines, MIN_LINE_CHARS } from '../../lib/parse.js';
import { segmentCJK } from '../../lib/db.js';

const HTML = `<!doctype html>
<html><head><title>标题不该进正文</title>
<script>window.__DATA__ = "脚本内容不该进正文";</script>
<style>.a{color:red}</style>
</head>
<body>
<nav><a href="/">首页</a><a href="/news">新闻</a></nav>
<article>
  <h1>贵州茅台2024年年报解读</h1>
  <p>公司2024年实现营业收入1741.44亿元，同比增长15.66%，归母净利润862.28亿元。</p>
  <p>分产品看，茅台酒收入1458.28亿元，系列酒收入246.84亿元，直销渠道占比继续提升。</p>
</article>
<footer>版权所有 仅供参考</footer>
</body></html>`;

const TABLE_HTML = `<html><body><article>
<p>下表为公司近三年营业收入与净利润的汇总，单位：亿元。</p>
<table>
<caption>营业收入与净利润</caption>
<tbody>
<tr><th>年度</th><th>营业收入</th><th>净利润</th></tr>
<tr><td>2022</td><td>1275.54</td><td>627.16</td></tr>
<tr><td>2023</td><td>1505.60</td><td>747.34</td></tr>
</tbody>
</table>
</article></body></html>`;

const MERGED_HTML = `<html><body><table>
<tr><td rowspan="2">合并</td><td>2023</td></tr>
<tr><td>2024</td></tr>
</table></body></html>`;

const RAGGED_HTML = `<html><body><table>
<tr><td>a</td><td>b</td><td>c</td></tr>
<tr><td>d</td></tr>
</table></body></html>`;

export const name = 'parse';

export async function run(t) {
  // 1. 正文抽取：保留长行，噪声全部剔除
  {
    const r = extract(HTML, { target: 'article' });
    t.ok(r.text.includes('贵州茅台2024年年报解读'), '保留标题行');
    t.ok(r.text.includes('营业收入1741.44亿元'), '保留正文段落');
    t.eq(r.text.includes('脚本内容不该进正文'), false, '剔除 script');
    t.eq(r.text.includes('标题不该进正文'), false, '剔除 head/title');
    t.eq(r.text.includes('版权所有'), false, '剔除 footer');
    t.eq(r.text.includes('首页'), false, '剔除短导航行');
    t.ok(r.spans.length >= 3, '至少 3 个 span');
  }

  // 2. 每个 span 都能 slice 出非空片段，且顺序单调
  {
    const r = extract(HTML, { target: 'article' });
    const slices = r.spans.map((s) => r.text.slice(s.start, s.end));
    t.eq(slices.every((s) => s.length > 0), true, '所有 span 可切片且非空');
    const monotonic = r.spans.every((s, i) => i === 0 || s.start > r.spans[i - 1].end);
    t.eq(monotonic, true, 'span 单调递增且不重叠');
    t.ok(slices[0].includes('贵州茅台2024年年报解读'), '第一个 span 是标题行');
  }

  // 3. 实体解码
  {
    t.eq(decodeEntities('贵州茅台&amp;五粮液&nbsp;&#39;s&#x4E1A;&#32489;'), "贵州茅台&五粮液 's业绩", '命名/十进制/十六进制实体都能解');
    const r = extract('<html><body><article><p>贵州茅台&amp;五粮液 2024 年合计营收 2000 亿元以上</p></article></body></html>');
    t.ok(r.text.includes('贵州茅台&五粮液'), '正文里实体已解码');
  }

  // 4. textSeg 与 db.js 的 segmentCJK 一致
  {
    const r = extract(HTML, { target: 'article' });
    t.eq(r.textSeg, segmentCJK(r.text), 'textSeg 走同一份 segmentCJK');
    t.ok(r.textSeg.includes(' 茅 台 '), '中文逐字切分');
  }

  // 5. 表格：caption / 行数 / 单元格
  {
    const r = extract(TABLE_HTML, { target: 'table' });
    t.eq(r.tables.length, 1, '识别出 1 张表');
    t.eq(r.tables[0].caption, '营业收入与净利润', 'caption 保留');
    t.eq(r.tables[0].rows.length, 3, '3 行（表头 + 2 数据行）');
    t.eq(r.tables[0].rows[1], ['2022', '1275.54', '627.16'], '单元格按列取到');
    t.eq(r.qualityFlags.includes('NO_TABLE'), false, '有表时不标 NO_TABLE');
  }

  // 6. 合并单元格 / 错行要标出来
  {
    t.eq(extract(MERGED_HTML).qualityFlags.includes('TABLE_MERGED_CELLS'), true, 'rowspan 标 TABLE_MERGED_CELLS');
    t.eq(extract(RAGGED_HTML).qualityFlags.includes('TABLE_LOSSY'), true, '列数不一致标 TABLE_LOSSY');
    t.eq(extract('<html><body><p>没有表格的一段足够长的正文内容用于占位测试</p></body></html>', { target: 'table' }).qualityFlags.includes('NO_TABLE'), true, '无表时标 NO_TABLE');
  }

  // 7. JSON 目标
  {
    const ok = extract('{"symbol":"600519","close":1741.44}', { target: 'json' });
    t.eq(ok.json?.close, 1741.44, 'JSON 解析成功');
    t.ok(ok.spans.length === 1 && ok.spans[0].end === ok.text.length, 'JSON 全文一个 span');
    const bad = extract('{"symbol":', { target: 'json' });
    t.eq(bad.qualityFlags.includes('JSON_PARSE_FAILED'), true, '坏 JSON 标 JSON_PARSE_FAILED');
    t.eq(bad.json, undefined, '坏 JSON 不返回半成品');
  }

  // 8. 空输入 / 超短正文
  {
    const empty = extract('   ');
    t.eq(empty.text, '', '空输入 text 为空');
    t.eq(empty.qualityFlags, ['EMPTY'], '空输入标 EMPTY');
    const short = extract('<html><body><p>太短</p></body></html>');
    t.eq(short.qualityFlags.includes('SHORT_TEXT'), true, '短正文标 SHORT_TEXT');
  }

  // 9. joinLines 只留够长的行，span 与换行符对齐
  {
    const { text, spans } = joinLines(['很长的一行内容足够通过阈值', '短', '另一行也足够长的正文内容']);
    t.eq(spans.length, 2, '两条长行');
    t.eq(text.length, spans[0].end - spans[0].start + 1 + spans[1].end - spans[1].start, '换行符计入偏移');
    t.eq(text.slice(spans[1].start, spans[1].end), '另一行也足够长的正文内容', '第二个 span 精确命中');
    t.ok('短'.length < MIN_LINE_CHARS, 'MIN_LINE_CHARS 阈值生效');
  }

  // 10. stripTags 只用于取文本：标签内属性里的尖括号不应吞掉正文
  {
    t.eq(stripTags('<p class="a">贵州茅台</p>'), '贵州茅台', 'stripTags 去标签');
  }
}
