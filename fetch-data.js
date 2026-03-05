const { PDFParse } = require('pdf-parse');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── 下载 PDF ─────────────────────────────────────────────
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        download(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    req.on('error', reject);
  });
}

// ── 解析 PDF 文本 ─────────────────────────────────────────
function parseTransactions(text) {
  const transactions = [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  let currentCurrency = null;
  let currentDuration = null;
  let inData = false;

  const rowRegex = /^(\d{2}\s+\w{3}\s+\d{4}),\s+[\d:]+\s+([\d,]+)\s+([\d.]+)%/;

  for (const line of lines) {
    const sectionMatch = line.match(/^(SGD|USD|EUR)\s+(1 Month|6 Month|12 Month|24 Month)\s+Contracts$/);
    if (sectionMatch) {
      currentCurrency = sectionMatch[1];
      currentDuration = sectionMatch[2];
      inData = false;
      continue;
    }

    if (!currentCurrency) continue;
    if (line.startsWith('Issued (SGT)')) { inData = true; continue; }
    if (line.startsWith('T: +65') || line.startsWith('www.') || line.startsWith('Silver Bullion')
        || line.startsWith('P: (65)') || line.startsWith('Registration')
        || line.startsWith('Total of') || line.startsWith('Issued 2')
        || line.startsWith('Page ') || line.startsWith('-- ')) continue;

    if (!inData) continue;

    const match = line.match(rowRegex);
    if (match) {
      const dateStr = match[1];
      const volume = parseInt(match[2].replace(/,/g, ''), 10);
      const rate = parseFloat(match[3]);
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) continue;
      transactions.push({
        date: date.toISOString().split('T')[0],
        currency: currentCurrency,
        duration: currentDuration,
        volume,
        rate,
      });
    }
  }

  return transactions;
}

// ── 聚合数据：按周 + 币种 ──────────────────────────────────
function aggregateByWeek(transactions) {
  const groups = {};

  for (const tx of transactions) {
    const d = new Date(tx.date);
    const day = d.getDay();
    const diff = (day === 0 ? -6 : 1 - day);
    const monday = new Date(d);
    monday.setDate(d.getDate() + diff);
    const week = monday.toISOString().split('T')[0];

    const key = `${week}|${tx.currency}|${tx.duration}`;
    if (!groups[key]) groups[key] = { week, currency: tx.currency, duration: tx.duration, rates: [], volume: 0 };
    groups[key].rates.push(tx.rate);
    groups[key].volume += tx.volume;
  }

  return Object.values(groups).map(g => ({
    week: g.week,
    currency: g.currency,
    duration: g.duration,
    avgRate: g.rates.reduce((a, b) => a + b, 0) / g.rates.length,
    volume: g.volume,
    count: g.rates.length,
  })).sort((a, b) => a.week.localeCompare(b.week));
}
// ── 通用 HTTP GET 文本 ────────────────────────────────────
function fetchText(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', Accept: 'text/html,application/json,*/*', ...extraHeaders };
    const req = https.get(url, { headers }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = ''; res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── 基准利率抓取 ──────────────────────────────────────────

// USD：美国财政部国债收益率
async function fetchUSD() {
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve&field_tdr_date_value_month=${ym}`;
  const html = await fetchText(url);

  // 找到表头行，确认列索引
  const headerMatch = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/i);
  const headers = [];
  if (headerMatch) {
    let m; const re = /<th[^>]*>([\s\S]*?)<\/th>/gi;
    while ((m = re.exec(headerMatch[0])) !== null) headers.push(m[1].replace(/<[^>]+>/g, '').trim());
  }

  // 找所有数据行，取最后一行
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let lastDataRow = null;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    if (m[1].includes('<td')) lastDataRow = m[1];
  }
  if (!lastDataRow) throw new Error('no data row');

  const cells = [];
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  while ((m = cellRe.exec(lastDataRow)) !== null) cells.push(m[1].replace(/<[^>]+>/g, '').trim());

  // 按列名取值
  const idx = (name) => headers.findIndex(h => h.replace(/\s+/g,'').toLowerCase() === name.replace(/\s+/g,'').toLowerCase());
  const get = (name) => { const i = idx(name); return i >= 0 && cells[i] && cells[i] !== 'N/A' ? parseFloat(cells[i]) : null; };

  const date = cells[0] || '';
  return {
    source: 'U.S. Treasury Daily Yield Curve',
    sourceUrl: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/',
    date,
    rates: {
      '1 Month':  get('1 Mo'),
      '6 Month':  get('6 Mo'),
      '12 Month': get('1 Yr'),
      '24 Month': get('2 Yr'),
    },
  };
}

// EUR：ECB 存款便利利率（政策利率，适用于所有期限作为欧元基准）
async function fetchEUR() {
  const html = await fetchText('https://www.ecb.europa.eu/stats/policy_and_exchange_rates/key_ecb_interest_rates/html/index.en.html');

  // 找 Deposit facility 行的利率
  const m = html.match(/Deposit facility[\s\S]{0,5000}?<td[^>]*>\s*([\-\d.]+)\s*<\/td>/i);
  if (!m) throw new Error('ECB rate not found');
  const rate = parseFloat(m[1]);

  // 找生效日期
  const dates = [...html.matchAll(/(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/g)].map(m=>m[1]).filter(d=>!d.includes('1970'));
  const dateM = dates.length ? [null, dates[0]] : null;
  const date = dateM ? dateM[1] : '';

  return {
    source: 'ECB Deposit Facility Rate',
    sourceUrl: 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/key_ecb_interest_rates/html/index.en.html',
    date,
    note: 'ECB政策利率，适用于所有期限（非商业银行定存利率）',
    rates: {
      '1 Month':  rate,
      '6 Month':  rate,
      '12 Month': rate,
      '24 Month': rate,
    },
  };
}

// SGD：先尝试 MAS API，失败则抓 HSBC Singapore 定存利率（静态 HTML）
async function fetchSGD() {
  // 1. 先试 MAS eservices
  try {
    const url = 'https://eservices.mas.gov.sg/api/action/datastore/search.json?resource_id=9a0bf149-308c-4bd2-832d-76c8e6cb47ed&limit=1&sort=end_of_week_date%20desc';
    const text = await fetchText(url);
    if (text.trimStart().startsWith('<')) throw new Error('maintenance');
    const json = JSON.parse(text);
    const record = json?.result?.records?.[0];
    if (!record) throw new Error('no record');
    const get = (...keys) => { for (const k of keys) { const v = record[k]; if (v != null && v !== '') return parseFloat(v); } return null; };
    return {
      source: 'MAS SGS Bond Yields (Weekly)',
      sourceUrl: 'https://eservices.mas.gov.sg',
      date: record.end_of_week_date || '',
      note: '新加坡政府债券收益率（无风险基准，非银行定存）',
      rates: {
        '1 Month':  get('1_month','benchmark_1m','1mo'),
        '6 Month':  get('6_month','benchmark_6m','6mo'),
        '12 Month': get('1_year','benchmark_1y','1yr'),
        '24 Month': get('2_year','benchmark_2y','2yr'),
      },
    };
  } catch(e) {
    // 2. 回退到 HSBC Singapore 定存利率（静态 HTML，无需 JS 渲染）
    const html = await fetchText('https://www.hsbc.com.sg/accounts/products/time-deposit/');
    // 抓取 "<tenure>, <rate> p.a." 格式的表格行
    const rows = [];
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let m;
    while ((m = rowRe.exec(html)) !== null) {
      const cells = [];
      const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let cm;
      while ((cm = cellRe.exec(m[1])) !== null) {
        cells.push(cm[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
      }
      if (cells.length >= 2) rows.push(cells);
    }
    const rateMap = {};
    for (const cells of rows) {
      const tenor = cells[0].toLowerCase();
      const rateStr = cells.find(c => c.includes('p.a.') || c.includes('%'));
      if (!rateStr) continue;
      const rv = parseFloat(rateStr);
      if (isNaN(rv)) continue;
      if (tenor.includes('1-month') || tenor === '1 month') rateMap['1 Month'] = rv;
      else if (tenor.includes('6-month') || tenor === '6 month') rateMap['6 Month'] = rv;
      else if (tenor.includes('12-month') || tenor.includes('1-year') || tenor === '12 month') rateMap['12 Month'] = rv;
      else if (tenor.includes('24-month') || tenor.includes('2-year') || tenor === '24 month') rateMap['24 Month'] = rv;
    }
    if (!rateMap['1 Month'] && !rateMap['6 Month']) throw new Error('HSBC rate parse failed');
    // 没有 24M 则用 12M 代替
    if (!rateMap['24 Month'] && rateMap['12 Month']) rateMap['24 Month'] = rateMap['12 Month'];
    const today = new Date().toISOString().split('T')[0];
    return {
      source: 'HSBC Singapore SGD Fixed Deposit',
      sourceUrl: 'https://www.hsbc.com.sg/accounts/products/time-deposit/',
      date: today,
      note: 'HSBC新加坡标准定存利率（促销利率，最低存款要求不同）',
      rates: rateMap,
    };
  }
}

// 统一入口，每个失败独立处理
async function fetchBenchmarkRates() {
  const benchmarkPath = path.join(__dirname, 'benchmark.json');
  let cached = {};
  try { cached = JSON.parse(fs.readFileSync(benchmarkPath, 'utf8')); } catch(e) {}

  const results = { fetchedAt: new Date().toISOString() };

  for (const [key, fn, label] of [['USD', fetchUSD, 'USD'], ['EUR', fetchEUR, 'EUR'], ['SGD', fetchSGD, 'SGD']]) {
    try {
      results[key] = await fn();
      console.log(`  ${label} 基准利率获取成功 (${results[key].date})`);
    } catch(e) {
      console.warn(`  ${label} 基准利率获取失败: ${e.message}，使用缓存`);
      results[key] = cached[key] ? { ...cached[key], fromCache: true } : null;
    }
  }

  fs.writeFileSync(benchmarkPath, JSON.stringify(results, null, 2));
  return results;
}

// ── 聚合数据：按周 + 币种 ──────────────────────────────────
function aggregateByWeek(transactions) {
  const groups = {};
  for (const tx of transactions) {
    const d = new Date(tx.date);
    const day = d.getDay();
    const diff = (day === 0 ? -6 : 1 - day);
    const monday = new Date(d); monday.setDate(d.getDate() + diff);
    const week = monday.toISOString().split('T')[0];
    const key = `${week}|${tx.currency}|${tx.duration}`;
    if (!groups[key]) groups[key] = { week, currency: tx.currency, duration: tx.duration, rates: [], volume: 0 };
    groups[key].rates.push(tx.rate);
    groups[key].volume += tx.volume;
  }
  return Object.values(groups).map(g => ({
    week: g.week, currency: g.currency, duration: g.duration,
    avgRate: g.rates.reduce((a, b) => a + b, 0) / g.rates.length,
    volume: g.volume, count: g.rates.length,
  })).sort((a, b) => a.week.localeCompare(b.week));
}

// ── 主流程 ────────────────────────────────────────────────
async function main() {
  const today = new Date().toISOString().split('T')[0];
  const sixMonthsAgo = new Date(); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const fromDate = sixMonthsAgo.toISOString().split('T')[0];

  const url = `https://www.silverbullion.com.sg/Report/LoanTransactions/PDF?FromDate=${fromDate}&ToDate=${today}`;
  const pdfPath = path.join(__dirname, 'transactions.pdf');

  console.log(`下载报告: ${fromDate} 至 ${today}...`);
  await download(url, pdfPath);
  console.log(`下载完成: ${(fs.statSync(pdfPath).size / 1024).toFixed(0)} KB`);

  console.log('解析 PDF...');
  const buffer = fs.readFileSync(pdfPath);
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  await parser.destroy();

  const transactions = parseTransactions(result.text);
  console.log(`解析到 ${transactions.length} 条成交记录`);

  const byCurrency = {};
  for (const tx of transactions) byCurrency[tx.currency] = (byCurrency[tx.currency] || 0) + 1;
  console.log('各币种记录数:', byCurrency);

  const weekly = aggregateByWeek(transactions);

  console.log('获取基准利率...');
  const benchmark = await fetchBenchmarkRates();

  const data = {
    updatedAt: new Date().toISOString(), fromDate, toDate: today, transactions, weekly,
  };

  fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(data, null, 2));
  console.log('数据已保存至 data.json');

  generateHTML(data, benchmark);
  console.log('监控页面已生成: index.html');
  console.log('用浏览器打开: open index.html');
}

// ── 生成 HTML ─────────────────────────────────────────────
function generateHTML(data, benchmark) {
  const dataJson      = JSON.stringify(data);
  const benchmarkJson = JSON.stringify(benchmark || {});
  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Silver Bullion P2P 贷款监控</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; color: #1a1a2e; }
header { background: #fff; border-bottom: 1px solid #e0e4ed; padding: 14px 24px; display: flex; align-items: center; gap: 12px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); position: sticky; top: 0; z-index: 10; }
header h1 { font-size: 17px; font-weight: 700; color: #b8860b; }
header .sub { font-size: 11px; color: #aaa; margin-top: 2px; }
.header-right { margin-left: auto; display: flex; align-items: center; gap: 14px; }
.updated { font-size: 11px; color: #bbb; }
.countdown { font-size: 11px; color: #aaa; }
.countdown span { color: #b8860b; font-weight: 600; font-variant-numeric: tabular-nums; }
.refresh-btn { padding: 5px 14px; border: 1px solid #b8860b; background: #fff; color: #b8860b; border-radius: 20px; cursor: pointer; font-size: 12px; font-weight: 600; transition: all 0.2s; }
.refresh-btn:hover { background: #b8860b; color: #fff; }
.stats-strip { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; padding: 16px 24px 0; }
.stat-card { background: #fff; border: 1px solid #e0e4ed; border-radius: 8px; padding: 12px 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
.stat-card .label { font-size: 11px; color: #999; margin-bottom: 3px; }
.stat-card .value { font-size: 20px; font-weight: 700; }
.stat-card .sub-value { font-size: 11px; color: #aaa; margin-top: 2px; }
.sgd { color: #e03131; } .usd { color: #2f9e44; } .eur { color: #1971c2; }
.workspace { display: grid; grid-template-columns: 340px 1fr; gap: 16px; padding: 16px 24px 24px; align-items: start; }
@media (max-width: 1100px) { .workspace { grid-template-columns: 1fr; } }
.tools-panel { background: #fff; border: 1px solid #e0e4ed; border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,0.05); overflow: hidden; }
.tool-tabs { display: flex; border-bottom: 1px solid #e0e4ed; }
.tool-tab { flex: 1; padding: 10px 6px; border: none; background: #f8f9fb; color: #888; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
.tool-tab.active { background: #fff; color: #b8860b; box-shadow: inset 0 -2px 0 #b8860b; }
.tool-tab:hover:not(.active) { color: #b8860b; background: #fff; }
.tool-body { padding: 16px; }
.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.field label { font-size: 11px; color: #999; font-weight: 600; }
.field select, .field input[type=number], .field input[type=date] { padding: 8px 10px; border: 1px solid #d0d5e0; border-radius: 6px; font-size: 13px; color: #333; background: #fafbfc; outline: none; width: 100%; }
.field select:focus, .field input:focus { border-color: #b8860b; }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.calc-btn { width: 100%; padding: 9px; background: #b8860b; color: #fff; border: none; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; transition: background 0.2s; margin-top: 4px; }
.calc-btn:hover { background: #9a700a; }
.result-box { margin-top: 14px; display: none; }
.result-box.show { display: block; }
.result-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.r-item { background: #f8f9fb; border-radius: 7px; padding: 10px 12px; }
.r-item .rl { font-size: 10px; color: #aaa; margin-bottom: 3px; }
.r-item .rv { font-size: 16px; font-weight: 700; color: #333; }
.r-item.hi { background: #fff8e6; border: 1px solid #f0d080; }
.r-item.hi .rv { color: #b8860b; }
.r-item.green { background: #f0f7f0; border: 1px solid #b2d8b2; }
.r-item.green .rv { color: #27ae60; }
.result-summary { margin-top: 10px; background: #f0f7f0; border: 1px solid #b2d8b2; border-radius: 7px; padding: 12px; }
.result-summary .rs-label { font-size: 11px; color: #666; margin-bottom: 8px; font-weight: 600; }
.result-summary .rs-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 8px; }
.rs-col .rsl { font-size: 10px; color: #999; }
.rs-col .rsv { font-size: 15px; font-weight: 700; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
.badge.active { background: #e6f4ea; color: #27ae60; }
.badge.done { background: #f0f0f0; color: #888; }
/* Benchmark */
.bench-source-block { background: #f8f9fb; border: 1px solid #e8eaf0; border-radius: 7px; padding: 10px 12px; margin-bottom: 12px; font-size: 11px; }
.bench-source-block .bsb-cur { font-weight: 700; color: #333; margin-bottom: 4px; }
.bench-source-block .bsb-src { color: #aaa; margin-bottom: 6px; }
.bench-source-block .bsb-rates { display: flex; gap: 8px; flex-wrap: wrap; }
.bsb-rate { background: #fff; border: 1px solid #e0e4ed; border-radius: 5px; padding: 4px 8px; }
.bsb-rate .bsr-dur { font-size: 10px; color: #aaa; }
.bsb-rate .bsr-val { font-size: 13px; font-weight: 700; color: #333; }
.bench-matrix { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 14px; }
.bench-matrix th { background: #f8f9fb; color: #888; font-weight: 600; padding: 7px 5px; text-align: center; border: 1px solid #e8eaf0; font-size: 11px; }
.bench-matrix td { padding: 5px 4px; border: 1px solid #e8eaf0; text-align: center; }
.bench-matrix td:first-child { font-weight: 700; background: #f8f9fb; color: #555; font-size: 11px; }
.bench-matrix input[type=number] { width: 58px; padding: 5px 4px; border: 1px solid #d0d5e0; border-radius: 4px; font-size: 12px; text-align: center; background: #fafbfc; outline: none; }
.bench-matrix input[type=number]:focus { border-color: #b8860b; }
.bench-matrix input.auto-filled { background: #f0f7f0; border-color: #b2d8b2; color: #27ae60; }
.bench-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 12px; }
.bench-table th { background: #f8f9fb; color: #888; font-weight: 600; padding: 7px 8px; border: 1px solid #e8eaf0; font-size: 11px; }
.bench-table td { padding: 7px 8px; border: 1px solid #e8eaf0; text-align: center; font-size: 12px; }
.bench-table td:first-child { text-align: left; font-weight: 600; }
.spread-pos { color: #27ae60; font-weight: 700; }
.spread-neg { color: #e03131; font-weight: 700; }
.spread-zero { color: #aaa; }
.bench-hint { font-size: 11px; color: #aaa; line-height: 1.6; margin-bottom: 12px; }
.auto-tag { display: inline-block; font-size: 9px; background: #e6f4ea; color: #27ae60; border-radius: 3px; padding: 1px 4px; font-weight: 600; vertical-align: middle; margin-left: 3px; }
/* Charts */
.charts-panel { display: flex; flex-direction: column; gap: 14px; }
.chart-filters { background: #fff; border: 1px solid #e0e4ed; border-radius: 10px; padding: 12px 16px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
.chart-filters span { font-size: 12px; color: #666; }
.filter-btn { padding: 5px 13px; border: 1px solid #d0d5e0; background: #fff; color: #555; border-radius: 20px; cursor: pointer; font-size: 12px; transition: all 0.2s; }
.filter-btn.active { background: #b8860b; color: #fff; border-color: #b8860b; font-weight: 600; }
.filter-btn:hover:not(.active) { border-color: #b8860b; color: #b8860b; }
.cur-btn { padding: 5px 12px; border: 1px solid #d0d5e0; background: #fff; color: #888; border-radius: 20px; cursor: pointer; font-size: 12px; font-weight: 700; transition: all 0.2s; }
.cur-btn.active { color: #fff; border-color: transparent; font-weight: 700; }
.cur-btn.active.sgd { background: #e03131; }
.cur-btn.active.usd { background: #2f9e44; }
.cur-btn.active.eur { background: #1971c2; }
.cur-btn.active.all { background: #555; }
.cur-btn:hover:not(.active) { border-color: #b8860b; color: #b8860b; }
.toggle-wrap { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.toggle-wrap label { font-size: 12px; color: #666; cursor: pointer; user-select: none; }
.toggle { position: relative; display: inline-block; width: 36px; height: 20px; }
.toggle input { opacity: 0; width: 0; height: 0; }
.toggle-slider { position: absolute; inset: 0; background: #ccc; border-radius: 20px; cursor: pointer; transition: .2s; }
.toggle-slider:before { content:''; position: absolute; width: 14px; height: 14px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: .2s; }
.toggle input:checked + .toggle-slider { background: #27ae60; }
.toggle input:checked + .toggle-slider:before { transform: translateX(16px); }
.charts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 900px) { .charts-grid { grid-template-columns: 1fr; } }
.card { background: #fff; border: 1px solid #e0e4ed; border-radius: 10px; padding: 16px; box-shadow: 0 1px 4px rgba(0,0,0,0.05); }
.card h2 { font-size: 11px; color: #aaa; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
.chart-wrap { position: relative; height: 260px; }
</style>
</head>
<body>
<header>
  <div>
    <h1>Silver Bullion P2P 贷款市场监控</h1>
    <div class="sub">数据来源: silverbullion.com.sg · 近半年成交记录</div>
  </div>
  <div class="header-right">
    <div class="updated" id="updatedAt"></div>
    <div class="countdown">下次刷新: <span id="countdown">4:00:00</span></div>
    <button class="refresh-btn" onclick="location.reload()">立即刷新</button>
  </div>
</header>

<div class="stats-strip" id="stats"></div>

<div class="workspace">
  <!-- 左：工具面板 -->
  <div class="tools-panel">
    <div class="tool-tabs">
      <button class="tool-tab active" data-tool="estimator">利率估算</button>
      <button class="tool-tab" data-tool="history">订单回顾</button>
      <button class="tool-tab" data-tool="benchmark">基准对比</button>
    </div>

    <!-- 利率估算 -->
    <div class="tool-body" id="toolEstimator">
      <div class="field-row">
        <div class="field"><label>币种</label>
          <select id="estCur"><option value="SGD">SGD</option><option value="USD" selected>USD</option><option value="EUR">EUR</option></select>
        </div>
        <div class="field"><label>期限</label>
          <select id="estDur"><option value="1 Month">1 个月</option><option value="6 Month" selected>6 个月</option><option value="12 Month">12 个月</option><option value="24 Month">24 个月</option></select>
        </div>
      </div>
      <div class="field"><label>出借金额</label><input type="text" id="estAmt" value="100,000" inputmode="decimal" /></div>
      <button class="calc-btn" onclick="calcEstimate()">估算建议利率</button>
      <div class="result-box" id="estResult"></div>
      <div style="font-size:12px;color:#aaa;margin-top:10px;display:none" id="estNodata">该条件近30天暂无成交记录</div>
    </div>

    <!-- 订单回顾 -->
    <div class="tool-body" id="toolHistory" style="display:none">
      <div class="field-row">
        <div class="field"><label>币种</label>
          <select id="hisCur"><option value="SGD">SGD</option><option value="USD" selected>USD</option><option value="EUR">EUR</option></select>
        </div>
        <div class="field"><label>期限</label>
          <select id="hisDur"><option value="1 Month">1 个月</option><option value="6 Month" selected>6 个月</option><option value="12 Month">12 个月</option><option value="24 Month">24 个月</option></select>
        </div>
      </div>
      <div class="field"><label>出借金额</label><input type="text" id="hisAmt" value="100,000" inputmode="decimal" /></div>
      <div class="field"><label>出借日期</label><input type="date" id="hisDate" /></div>
      <div class="field"><label>年利率 (%)</label><input type="number" id="hisRate" placeholder="例如 5.50" min="0" step="0.1" /></div>
      <button class="calc-btn" onclick="calcHistory()">查看净收益</button>
      <div class="result-box" id="hisResult"></div>
    </div>

    <!-- 基准对比 -->
    <div class="tool-body" id="toolBenchmark" style="display:none">
      <p class="bench-hint">绿色数字为自动获取的官方基准利率，可手动修改。点击「生成对比」查看与 P2P 净年化的利差。</p>
      <div id="benchSources"></div>
      <table class="bench-matrix">
        <thead><tr><th>币种</th><th>1M</th><th>6M</th><th>12M</th><th>24M</th></tr></thead>
        <tbody>
          <tr><td>SGD</td>
            <td><input type="number" class="bank-rate" data-cur="SGD" data-dur="1 Month" step="0.01" placeholder="—" /></td>
            <td><input type="number" class="bank-rate" data-cur="SGD" data-dur="6 Month" step="0.01" placeholder="—" /></td>
            <td><input type="number" class="bank-rate" data-cur="SGD" data-dur="12 Month" step="0.01" placeholder="—" /></td>
            <td><input type="number" class="bank-rate" data-cur="SGD" data-dur="24 Month" step="0.01" placeholder="—" /></td>
          </tr>
          <tr><td>USD</td>
            <td><input type="number" class="bank-rate" data-cur="USD" data-dur="1 Month" step="0.01" placeholder="—" /></td>
            <td><input type="number" class="bank-rate" data-cur="USD" data-dur="6 Month" step="0.01" placeholder="—" /></td>
            <td><input type="number" class="bank-rate" data-cur="USD" data-dur="12 Month" step="0.01" placeholder="—" /></td>
            <td><input type="number" class="bank-rate" data-cur="USD" data-dur="24 Month" step="0.01" placeholder="—" /></td>
          </tr>
          <tr><td>EUR</td>
            <td><input type="number" class="bank-rate" data-cur="EUR" data-dur="1 Month" step="0.01" placeholder="—" /></td>
            <td><input type="number" class="bank-rate" data-cur="EUR" data-dur="6 Month" step="0.01" placeholder="—" /></td>
            <td><input type="number" class="bank-rate" data-cur="EUR" data-dur="12 Month" step="0.01" placeholder="—" /></td>
            <td><input type="number" class="bank-rate" data-cur="EUR" data-dur="24 Month" step="0.01" placeholder="—" /></td>
          </tr>
        </tbody>
      </table>
      <button class="calc-btn" onclick="calcBenchmark()">生成对比</button>
      <div id="benchResult"></div>
    </div>
  </div>

  <!-- 右：图表 -->
  <div class="charts-panel">
    <div class="chart-filters">
      <span>币种:</span>
      <button class="cur-btn all" data-cur="ALL">全部</button>
      <button class="cur-btn active usd" data-cur="USD">USD</button>
      <button class="cur-btn sgd" data-cur="SGD">SGD</button>
      <button class="cur-btn eur" data-cur="EUR">EUR</button>
      <span style="width:1px;height:18px;background:#e0e4ed;margin:0 2px"></span>
      <span>期限:</span>
      <button class="filter-btn active" data-dur="all">全部</button>
      <button class="filter-btn" data-dur="1 Month">1 个月</button>
      <button class="filter-btn" data-dur="6 Month">6 个月</button>
      <button class="filter-btn" data-dur="12 Month">12 个月</button>
      <button class="filter-btn" data-dur="24 Month">24 个月</button>
      <div class="toggle-wrap">
        <label for="netToggle">净年化</label>
        <label class="toggle"><input type="checkbox" id="netToggle" checked><span class="toggle-slider"></span></label>
      </div>
      <div class="toggle-wrap" id="spreadToggleWrap" style="display:none">
        <label for="spreadToggle" style="color:#b8860b;font-weight:600">利差区间</label>
        <label class="toggle"><input type="checkbox" id="spreadToggle"><span class="toggle-slider" style="background:#b8860b"></span></label>
      </div>
    </div>
    <div class="charts-grid">
      <div class="card"><h2 id="ratechartTitle">平均净年化利率趋势（扣管理费）</h2><div class="chart-wrap"><canvas id="rateChart"></canvas></div></div>
      <div class="card"><h2>周成交量趋势</h2><div class="chart-wrap"><canvas id="volumeChart"></canvas></div></div>
      <div class="card" style="grid-column:1/-1"><h2 id="scatterchartTitle">净年化利率散点图（每笔交易）</h2><div class="chart-wrap" style="height:300px"><canvas id="scatterChart"></canvas></div></div>
      <div class="card" style="grid-column:1/-1"><h2 id="volscatterTitle" style="display:flex;justify-content:space-between;align-items:center"><span>历史成交规模散点图</span><div class="toggle-wrap" style="margin-left:0"><label style="font-size:11px;color:#aaa;font-weight:normal" for="volMedianToggle">日中位数</label><label class="toggle" style="width:30px;height:17px"><input type="checkbox" id="volMedianToggle" checked><span class="toggle-slider"></span></label></div></h2><div class="chart-wrap" style="height:300px"><canvas id="volScatterChart"></canvas></div></div>
    </div>
  </div>
</div>

<script>
const RAW       = ${dataJson};
const BENCHMARK = ${benchmarkJson};
const CURRENCIES = ['SGD','USD','EUR'];
const DURATIONS  = ['1 Month','6 Month','12 Month','24 Month'];
const COLORS = { SGD:'#e03131', USD:'#2f9e44', EUR:'#1971c2' };
let currentDur = 'all', currentCur = 'USD', showNet = true, showSpread = false, showVolMedian = true;
let rateChart, volumeChart, scatterChart, volScatterChart;

function adminFee(dur) { return dur === '1 Month' ? 1.0 : 0.5; }
function toNet(rate, dur) { return rate - adminFee(dur); }
function fmtM(n){ return n==null?'—':n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtI(n){ return n==null?'—':Math.round(n).toLocaleString('en-US'); }

document.getElementById('updatedAt').textContent = '更新: ' + new Date(RAW.updatedAt).toLocaleString('zh-CN');
document.getElementById('hisDate').value = new Date().toISOString().split('T')[0];

// ── 倒计时 ────────────────────────────────────────────────
(function(){
  const at = Date.now() + 14400000;
  function tick(){
    const r = Math.max(0, at - Date.now());
    if (!r) { location.reload(); return; }
    document.getElementById('countdown').textContent =
      String(Math.floor(r/3600000)).padStart(1,'0')+':'+String(Math.floor((r%3600000)/60000)).padStart(2,'0')+':'+String(Math.floor((r%60000)/1000)).padStart(2,'0');
  }
  tick(); setInterval(tick,1000); setTimeout(()=>location.reload(),14400000);
})();

// ── Tabs ──────────────────────────────────────────────────
document.querySelectorAll('.tool-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool-tab').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    ['toolEstimator','toolHistory','toolBenchmark'].forEach(id=>document.getElementById(id).style.display='none');
    const map={estimator:'toolEstimator',history:'toolHistory',benchmark:'toolBenchmark'};
    document.getElementById(map[btn.dataset.tool]).style.display='';
  });
});

// ── 基准利率：预填 + 来源说明 ─────────────────────────────
(function initBenchmark(){
  const srcEl = document.getElementById('benchSources');
  const curMap = { SGD: BENCHMARK.SGD, USD: BENCHMARK.USD, EUR: BENCHMARK.EUR };
  let srcHtml = '';

  CURRENCIES.forEach(cur => {
    const b = curMap[cur];
    if (!b) return;
    const cached = b.fromCache ? ' <span style="color:#e0a000">(缓存)</span>' : '';
    const note = b.note ? \`<div style="font-size:10px;color:#bbb;margin-top:2px">\${b.note}</div>\` : '';
    let rateHtml = DURATIONS.map(dur => {
      const v = b.rates?.[dur];
      return v != null ? \`<div class="bsb-rate"><div class="bsr-dur">\${dur.replace(' Month','M')}</div><div class="bsr-val">\${v.toFixed(2)}%</div></div>\` : '';
    }).join('');
    srcHtml += \`
      <div class="bench-source-block">
        <div class="bsb-cur">\${cur} <span class="auto-tag">自动</span>\${cached}</div>
        <div class="bsb-src"><a href="\${b.sourceUrl}" target="_blank" style="color:#b8860b;text-decoration:none">\${b.source}</a> · \${b.date}</div>
        \${note}
        <div class="bsb-rates">\${rateHtml}</div>
      </div>\`;

    // 预填输入框
    DURATIONS.forEach(dur => {
      const v = b.rates?.[dur];
      if (v == null) return;
      const input = document.querySelector(\`.bank-rate[data-cur="\${cur}"][data-dur="\${dur}"]\`);
      if (input && !input.value) { input.value = v.toFixed(2); input.classList.add('auto-filled'); }
    });
  });

  if (!srcHtml) srcHtml = '<p class="bench-hint" style="color:#e0a000">自动获取基准利率失败，请手动填写</p>';
  srcEl.innerHTML = srcHtml;

  // 手动修改时移除绿色样式
  document.querySelectorAll('.bank-rate').forEach(el => {
    el.addEventListener('input', () => el.classList.remove('auto-filled'));
  });
})();

// ── localStorage 持久化（手动改的值） ─────────────────────
const LS_KEY = 'sb_bank_rates_v2';
function saveBankRates(){
  const obj={};
  document.querySelectorAll('.bank-rate').forEach(el=>{
    if(el.value && !el.classList.contains('auto-filled')) obj[\`\${el.dataset.cur}|\${el.dataset.dur}\`]=el.value;
  });
  localStorage.setItem(LS_KEY,JSON.stringify(obj));
}
function loadBankRates(){
  try{
    const obj=JSON.parse(localStorage.getItem(LS_KEY)||'{}');
    document.querySelectorAll('.bank-rate').forEach(el=>{
      const v=obj[\`\${el.dataset.cur}|\${el.dataset.dur}\`];
      if(v){ el.value=v; el.classList.remove('auto-filled'); }
    });
  }catch(e){}
}
document.querySelectorAll('.bank-rate').forEach(el=>el.addEventListener('change',saveBankRates));
loadBankRates();

// ── Stats ─────────────────────────────────────────────────
function buildStats(txs){
  const c=document.getElementById('stats'); c.innerHTML='';
  CURRENCIES.forEach(cur=>{
    const sub=txs.filter(t=>t.currency===cur);
    if(!sub.length){ c.innerHTML+=\`<div class="stat-card"><div class="label">\${cur}</div><div class="value \${cur.toLowerCase()}">无数据</div></div>\`; return; }
    const vol=sub.reduce((s,t)=>s+t.volume,0);
    const last=sub[sub.length-1];
    const dr=t=>showNet?toNet(t.rate,t.duration):t.rate;
    c.innerHTML+=\`<div class="stat-card"><div class="label">\${cur} · \${sub.length} 笔</div><div class="value \${cur.toLowerCase()}">\${dr(last).toFixed(2)}%</div><div class="sub-value">最新\${showNet?'净年化':'毛利率'} · 均值 \${(sub.reduce((s,t)=>s+dr(t),0)/sub.length).toFixed(2)}% · \${fmtI(vol)}</div></div>\`;
  });
}

// ── Charts ────────────────────────────────────────────────
const TC={
  interaction:{mode:'index',intersect:false},
  plugins:{
    tooltip:{mode:'index',intersect:false,backgroundColor:'rgba(255,255,255,0.95)',borderColor:'#e0e4ed',borderWidth:1,titleColor:'#333',bodyColor:'#555',padding:10,
      callbacks:{label:ctx=>\` \${ctx.dataset.label}: \${ctx.parsed.y!=null?ctx.parsed.y.toFixed(2):'-'}\`}},
    legend:{labels:{color:'#444',boxWidth:12}},
  },
};
function filterData(dur){
  const wAll=currentCur==='ALL'?RAW.weekly:RAW.weekly.filter(function(d){return d.currency===currentCur;});
  const tAll=currentCur==='ALL'?RAW.transactions:RAW.transactions.filter(function(t){return t.currency===currentCur;});
  return{weekly:dur==='all'?wAll:wAll.filter(function(d){return d.duration===dur;}),txs:dur==='all'?tAll:tAll.filter(function(t){return t.duration===dur;})};
}
function getBenchRate(dur){
  const b = BENCHMARK[currentCur];
  if(!b||!b.rates) return null;
  return b.rates[dur]??null;
}
function buildCharts(dur){
  var isAll=currentCur==='ALL';
  var fd=filterData(dur); var weekly=fd.weekly; var txs=fd.txs;
  // 统计栏始终显示全部三种币种（仅按期限筛选，不按币种筛选）
  var statsT=dur==='all'?RAW.transactions:RAW.transactions.filter(function(t){return t.duration===dur;});
  buildStats(statsT);
  var rl=showNet?'净年化 % p.a.':'毛利率 % p.a.';
  var curColor=isAll?'#888':COLORS[currentCur];
  document.getElementById('ratechartTitle').textContent=(showNet?'净年化利率趋势':'毛利率趋势')+' · '+(isAll?'全部币种':currentCur)+(dur!=='all'?' · '+dur.replace(' Month','M'):'');
  document.getElementById('scatterchartTitle').textContent=(showNet?'净年化':'毛利率')+'散点图 · '+(isAll?'全部币种':currentCur)+(dur!=='all'?' · '+dur.replace(' Month','M'):'');
  document.getElementById('volscatterTitle').textContent='历史成交规模散点图 · '+(isAll?'全部币种':currentCur)+(dur!=='all'?' · '+dur.replace(' Month','M'):'');
  var aw=[...new Set(weekly.map(function(d){return d.week;}))].sort();
  var bt={type:'time',time:{unit:'week',tooltipFormat:'yyyy-MM-dd'},grid:{color:'#eaeef5'},ticks:{color:'#aaa',maxTicksLimit:10}};
  var by={grid:{color:'#eaeef5'},ticks:{color:'#aaa'}};

  // 利率趋势
  var rDS=[];
  if(isAll){
    CURRENCIES.forEach(function(cur){
      var cw=weekly.filter(function(d){return d.currency===cur;});
      var bw={};cw.forEach(function(d){bw[d.week]=showNet?toNet(d.avgRate,d.duration):d.avgRate;});
      rDS.push({label:cur+' P2P',data:aw.map(function(w){return{x:w,y:bw[w]!=null?bw[w]:null};}),borderColor:COLORS[cur],backgroundColor:'transparent',tension:0.3,pointRadius:3,spanGaps:false});
    });
    showSpread=false;document.getElementById('spreadToggle').checked=false;
    document.getElementById('spreadToggleWrap').style.display='none';
  } else {
    var bw={};weekly.forEach(function(d){bw[d.week]=showNet?toNet(d.avgRate,d.duration):d.avgRate;});
    var benchRaw=dur!=='all'?getBenchRate(dur):null;
    var bLabel=benchRaw!=null?(BENCHMARK[currentCur]&&BENCHMARK[currentCur].source?BENCHMARK[currentCur].source:'基准').split(' ').slice(0,3).join(' '):'基准';
    if(showSpread&&benchRaw!=null){
      rDS.push({label:bLabel+' '+dur.replace(' Month','M'),data:aw.map(function(w){return{x:w,y:benchRaw};}),borderColor:curColor+'99',borderDash:[5,4],borderWidth:1.5,backgroundColor:'transparent',pointRadius:0,tension:0,spanGaps:true,order:1});
      rDS.push({label:currentCur+' P2P',data:aw.map(function(w){return{x:w,y:bw[w]!=null?bw[w]:null};}),borderColor:curColor,backgroundColor:'transparent',tension:0.3,pointRadius:3,spanGaps:false,fill:{target:0,above:'rgba(39,174,96,0.18)',below:'rgba(224,49,49,0.18)'},order:0});
    } else {
      rDS.push({label:currentCur+' P2P',data:aw.map(function(w){return{x:w,y:bw[w]!=null?bw[w]:null};}),borderColor:curColor,backgroundColor:'transparent',tension:0.3,pointRadius:3,spanGaps:false});
      if(dur!=='all'&&benchRaw!=null) rDS.push({label:bLabel+' '+dur.replace(' Month','M'),data:aw.map(function(w){return{x:w,y:benchRaw};}),borderColor:curColor,borderDash:[5,4],borderWidth:1.5,backgroundColor:'transparent',pointRadius:0,tension:0,spanGaps:true});
    }
    document.getElementById('spreadToggleWrap').style.display=(dur!=='all'&&benchRaw!=null)?'flex':'none';
    if(dur==='all'||benchRaw==null){showSpread=false;document.getElementById('spreadToggle').checked=false;}
  }

  // 成交量趋势
  var vDS=[];
  if(isAll){
    CURRENCIES.forEach(function(cur){
      var cw=weekly.filter(function(d){return d.currency===cur;});
      var vbw={};cw.forEach(function(d){vbw[d.week]=(vbw[d.week]||0)+d.volume;});
      vDS.push({label:cur,data:aw.map(function(w){return{x:w,y:vbw[w]!=null?vbw[w]:null};}),borderColor:COLORS[cur],backgroundColor:COLORS[cur]+'22',tension:0.3,pointRadius:3,fill:false,spanGaps:false});
    });
  } else {
    var vbw={};weekly.forEach(function(d){vbw[d.week]=d.volume;});
    vDS=[{label:currentCur,data:aw.map(function(w){return{x:w,y:vbw[w]!=null?vbw[w]:null};}),borderColor:curColor,backgroundColor:curColor+'22',tension:0.3,pointRadius:3,fill:true,spanGaps:false}];
  }

  // 利率散点
  var sDS=[];
  if(isAll){
    CURRENCIES.forEach(function(cur){
      var ct=txs.filter(function(t){return t.currency===cur;});
      sDS.push({label:cur+' P2P',data:ct.map(function(t){return{x:t.date,y:showNet?toNet(t.rate,t.duration):t.rate};}),backgroundColor:COLORS[cur]+'cc',pointRadius:4,type:'scatter'});
    });
  } else {
    sDS=[{label:currentCur+' P2P',data:txs.map(function(t){return{x:t.date,y:showNet?toNet(t.rate,t.duration):t.rate};}),backgroundColor:curColor+'cc',pointRadius:4,type:'scatter'}];
    if(dur!=='all'){var br=getBenchRate(dur);if(br!=null)sDS.push({type:'line',label:'基准 '+dur.replace(' Month','M'),data:[{x:RAW.fromDate,y:br},{x:RAW.toDate,y:br}],borderColor:curColor,borderDash:[5,4],borderWidth:1.5,backgroundColor:'transparent',pointRadius:0,tension:0});}
  }

  // 成交规模散点 + 每日中位数趋势线
  var DARK_CLR={SGD:'#7b0000',USD:'#0a3d1f',EUR:'#001f5b'};
  function dailyMed(tList){var byD={};tList.forEach(function(t){if(!byD[t.date])byD[t.date]=[];byD[t.date].push(t.volume);});return Object.keys(byD).sort().map(function(d){var sv=byD[d].slice().sort(function(a,b){return a-b;});return{x:d,y:sv[Math.floor(sv.length/2)]};});}
  var vsDS=[];
  if(isAll){
    CURRENCIES.forEach(function(cur){
      var ct=txs.filter(function(t){return t.currency===cur;});
      if(!ct.length)return;
      vsDS.push({label:cur,data:ct.map(function(t){return{x:t.date,y:t.volume};}),backgroundColor:COLORS[cur]+'99',pointRadius:3,type:'scatter'});
      if(showVolMedian)vsDS.push({type:'line',label:cur+' 日中位数',data:dailyMed(ct),borderColor:DARK_CLR[cur],borderWidth:2,backgroundColor:'transparent',pointRadius:2,pointHitRadius:12,pointHoverRadius:4,tension:0.3,spanGaps:false});
    });
  } else {
    vsDS=[{label:currentCur+' 成交',data:txs.map(function(t){return{x:t.date,y:t.volume};}),backgroundColor:curColor+'99',pointRadius:3,type:'scatter'}];
    if(txs.length&&showVolMedian){vsDS.push({type:'line',label:'日中位数',data:dailyMed(txs),borderColor:'#333',borderWidth:2,backgroundColor:'transparent',pointRadius:3,pointHitRadius:12,pointHoverRadius:5,tension:0.3,spanGaps:false});}
  }

  if(rateChart)rateChart.destroy();
  rateChart=new Chart(document.getElementById('rateChart'),{type:'line',data:{datasets:rDS},options:{responsive:true,maintainAspectRatio:false,...TC,scales:{x:bt,y:{...by,title:{display:true,text:rl,color:'#aaa'}}}}});
  if(volumeChart)volumeChart.destroy();
  volumeChart=new Chart(document.getElementById('volumeChart'),{type:'line',data:{datasets:vDS},options:{responsive:true,maintainAspectRatio:false,...TC,plugins:{...TC.plugins,tooltip:{...TC.plugins.tooltip,callbacks:{label:function(ctx){return ' '+ctx.dataset.label+': '+(ctx.parsed.y!=null?Math.round(ctx.parsed.y).toLocaleString('en-US'):'-');}}}},scales:{x:bt,y:{...by,ticks:{...by.ticks,callback:function(v){return v.toLocaleString('en-US');}}}}}});
  if(scatterChart)scatterChart.destroy();
  scatterChart=new Chart(document.getElementById('scatterChart'),{type:'scatter',data:{datasets:sDS},options:{responsive:true,maintainAspectRatio:false,plugins:{...TC.plugins,tooltip:{...TC.plugins.tooltip,mode:'nearest',intersect:false}},interaction:{mode:'nearest',intersect:false},scales:{x:{...bt,time:{unit:'week',tooltipFormat:'yyyy-MM-dd'}},y:{...by,title:{display:true,text:rl,color:'#aaa'}}}}});
  if(volScatterChart)volScatterChart.destroy();
  volScatterChart=new Chart(document.getElementById('volScatterChart'),{type:'scatter',data:{datasets:vsDS},options:{responsive:true,maintainAspectRatio:false,plugins:{...TC.plugins,tooltip:{...TC.plugins.tooltip,mode:'nearest',intersect:false,callbacks:{label:function(ctx){return ' '+ctx.dataset.label+': '+(ctx.parsed.y!=null?Math.round(ctx.parsed.y).toLocaleString('en-US'):'-');},footer:function(items){if(!items.length)return[];var x=items[0].raw?items[0].raw.x:null;if(!x)return[];var lines=[];items[0].chart.data.datasets.forEach(function(ds){if(ds.label&&ds.label.indexOf('中位数')>=0){for(var i=0;i<ds.data.length;i++){if(ds.data[i].x===x){lines.push(ds.label+': '+Math.round(ds.data[i].y).toLocaleString('en-US'));break;}}}});return lines;}}}},interaction:{mode:'nearest',intersect:false},scales:{x:{...bt,time:{unit:'week',tooltipFormat:'yyyy-MM-dd'}},y:{...by,ticks:{...by.ticks,callback:function(v){return v.toLocaleString('en-US');}},title:{display:true,text:'成交规模',color:'#aaa'}}}}});
}
document.querySelectorAll('.filter-btn').forEach(btn=>{btn.addEventListener('click',()=>{document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');currentDur=btn.dataset.dur;buildCharts(currentDur);});});
document.querySelectorAll('.cur-btn').forEach(btn=>{btn.addEventListener('click',()=>{document.querySelectorAll('.cur-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');currentCur=btn.dataset.cur;buildCharts(currentDur);});});
document.getElementById('netToggle').addEventListener('change',function(){showNet=this.checked;buildCharts(currentDur);});
(function(){function fmtAmt(id){var el=document.getElementById(id);var n=parseFloat(el.value.replace(/,/g,''));if(!isNaN(n))el.value=n.toLocaleString('en-US');}function clearAmt(id){var el=document.getElementById(id);el.value=el.value.replace(/,/g,'');}['estAmt','hisAmt'].forEach(function(id){document.getElementById(id).addEventListener('blur',function(){fmtAmt(id);});document.getElementById(id).addEventListener('focus',function(){clearAmt(id);});});})();
document.getElementById('spreadToggle').addEventListener('change',function(){showSpread=this.checked;buildCharts(currentDur);});
document.getElementById('volMedianToggle').addEventListener('change',function(){showVolMedian=this.checked;buildCharts(currentDur);});
buildCharts('all');

// ── 利率估算 ──────────────────────────────────────────────
function calcEstimate(){
  const cur=document.getElementById('estCur').value, dur=document.getElementById('estDur').value;
  const amt=parseFloat(document.getElementById('estAmt').value.replace(/,/g,''))||0;
  const box=document.getElementById('estResult'), nd=document.getElementById('estNodata');
  const cutoff=new Date(); cutoff.setDate(cutoff.getDate()-30);
  const sub=RAW.transactions.filter(t=>t.currency===cur&&t.duration===dur&&t.date>=cutoff.toISOString().split('T')[0]);
  if(!sub.length){box.classList.remove('show');nd.style.display='block';return;} nd.style.display='none';
  const rates=sub.map(t=>t.rate).sort((a,b)=>a-b), vols=sub.map(t=>t.volume).sort((a,b)=>a-b), n=rates.length;
  const avgRate=rates.reduce((s,r)=>s+r,0)/n;
  const w7=new Date(); w7.setDate(w7.getDate()-7);
  const rr=sub.filter(t=>t.date>=w7.toISOString().split('T')[0]).map(t=>t.rate);
  const ra=rr.length?rr.reduce((s,r)=>s+r,0)/rr.length:null;
  let pct,sl,sn;
  if(amt>0){const v33=vols[Math.floor(n*0.33)],v67=vols[Math.floor(n*0.67)];if(amt>=v67){pct=0.35;sl='大额';sn=\`≥近30天67%分位（\${v67.toLocaleString()}），大单优先\`;}else if(amt>=v33){pct=0.25;sl='中额';sn=\`近30天中段（\${v33.toLocaleString()}–\${v67.toLocaleString()}）\`;}else{pct=0.15;sl='小额';sn=\`<近30天33%分位（\${v33.toLocaleString()}），需更低利率\`;}}else{pct=0.25;sl='';sn='未填金额，按中等竞争力';}
  const sr=rates[Math.floor(n*pct)], fr=adminFee(dur), nr=sr-fr, mo=parseInt(dur);
  const gr=amt>0?amt*sr/100*mo/12:null, fe=amt>0?amt*fr/100*mo/12:null, ne=gr!==null?gr-fe:null;
  box.innerHTML=\`<div class="result-grid"><div class="r-item hi" style="grid-column:1/-1"><div class="rl">建议利率\${sl?'（'+sl+'）':''}</div><div class="rv">\${sr.toFixed(2)}%</div><div style="font-size:10px;color:#aaa;margin-top:2px">\${sn}</div></div><div class="r-item"><div class="rl">近30天均值</div><div class="rv">\${avgRate.toFixed(2)}%</div><div style="font-size:10px;color:#aaa">\${n} 笔</div></div><div class="r-item"><div class="rl">近7天均值</div><div class="rv">\${ra!==null?ra.toFixed(2)+'%':'—'}</div><div style="font-size:10px;color:#aaa">\${rr.length} 笔</div></div><div class="r-item"><div class="rl">近30天区间</div><div class="rv" style="font-size:13px">\${rates[0].toFixed(2)}%–\${rates[n-1].toFixed(2)}%</div></div><div class="r-item green"><div class="rl">净年化收益率</div><div class="rv">\${nr.toFixed(2)}%</div><div style="font-size:10px;color:#aaa">\${sr.toFixed(2)}%−\${fr}%</div></div></div>\${ne!==null?\`<div class="result-summary" style="margin-top:10px"><div class="rs-label">按建议利率 \${sr.toFixed(2)}% 出借 \${amt.toLocaleString()} \${cur}（\${dur.replace('Month','个月').trim()}）</div><div class="rs-grid"><div class="rs-col"><div class="rsl">毛利息</div><div class="rsv" style="color:#333">\${fmtM(gr)} \${cur}</div></div><div class="rs-col"><div class="rsl">管理费（\${fr}% p.a.）</div><div class="rsv" style="color:#c0392b">−\${fmtM(fe)} \${cur}</div></div><div class="rs-col"><div class="rsl">净利息</div><div class="rsv" style="color:#27ae60">\${fmtM(ne)} \${cur}</div></div></div></div>\`:''}  \`;
  box.classList.add('show');
}

// ── 订单回顾 ──────────────────────────────────────────────
function calcHistory(){
  const cur=document.getElementById('hisCur').value, dur=document.getElementById('hisDur').value;
  const amt=parseFloat(document.getElementById('hisAmt').value.replace(/,/g,''))||0;
  const ds=document.getElementById('hisDate').value, rate=parseFloat(document.getElementById('hisRate').value);
  const box=document.getElementById('hisResult');
  if(!ds||!rate||!amt){box.innerHTML='<div style="font-size:12px;color:#aaa;margin-top:10px">请填写完整信息</div>';box.classList.add('show');return;}
  const mo=parseInt(dur), startD=new Date(ds), endD=new Date(ds); endD.setMonth(endD.getMonth()+mo);
  const today=new Date(), isActive=endD>today, ref=isActive?today:endD;
  const held=Math.round((ref-startD)/86400000), total=Math.round((endD-startD)/86400000), fr=adminFee(dur);
  const gr=amt*rate/100*total/365, fa=amt*fr/100*total/365, ne=gr-fa;
  const gsf=amt*rate/100*held/365, fsf=amt*fr/100*held/365, nsf=gsf-fsf;
  const dl=Math.max(0,Math.round((endD-today)/86400000));
  const fmt=d=>d.toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'});
  box.innerHTML=\`<div class="result-grid" style="margin-bottom:10px"><div class="r-item" style="grid-column:1/-1;display:flex;justify-content:space-between;align-items:center"><div><div class="rl">订单周期</div><div class="rv" style="font-size:13px">\${fmt(startD)} → \${fmt(endD)}</div></div><span class="badge \${isActive?'active':'done'}">\${isActive?'进行中 · 剩'+dl+'天':'已到期'}</span></div><div class="r-item green"><div class="rl">净年化收益率</div><div class="rv">\${(rate-fr).toFixed(2)}%</div><div style="font-size:10px;color:#aaa">\${rate.toFixed(2)}%−\${fr}%</div></div><div class="r-item hi"><div class="rl">年利率（毛）</div><div class="rv">\${rate.toFixed(2)}%</div></div></div><div class="result-summary"><div class="rs-label">\${isActive?'持有至今（'+held+'天）':'全期收益（'+total+'天）'}</div><div class="rs-grid"><div class="rs-col"><div class="rsl">毛利息</div><div class="rsv" style="color:#333">\${fmtM(isActive?gsf:gr)} \${cur}</div></div><div class="rs-col"><div class="rsl">管理费</div><div class="rsv" style="color:#c0392b">−\${fmtM(isActive?fsf:fa)} \${cur}</div></div><div class="rs-col"><div class="rsl">净利息</div><div class="rsv" style="color:#27ae60">\${fmtM(isActive?nsf:ne)} \${cur}</div></div></div>\${isActive?\`<div style="margin-top:10px;padding-top:10px;border-top:1px solid #d0e8d0"><div class="rs-label">到期预期（全期 \${total} 天）</div><div class="rs-grid"><div class="rs-col"><div class="rsl">毛利息</div><div class="rsv" style="color:#333">\${fmtM(gr)} \${cur}</div></div><div class="rs-col"><div class="rsl">管理费</div><div class="rsv" style="color:#c0392b">−\${fmtM(fa)} \${cur}</div></div><div class="rs-col"><div class="rsl">净利息</div><div class="rsv" style="color:#27ae60">\${fmtM(ne)} \${cur}</div></div></div></div>\`:''}</div>\`;
  box.classList.add('show');
}

// ── 基准对比 ──────────────────────────────────────────────
function calcBenchmark(){
  const cutoff=new Date(); cutoff.setDate(cutoff.getDate()-30);
  const cs=cutoff.toISOString().split('T')[0];
  const p2p={};
  CURRENCIES.forEach(cur=>DURATIONS.forEach(dur=>{
    const sub=RAW.transactions.filter(t=>t.currency===cur&&t.duration===dur&&t.date>=cs);
    if(sub.length) p2p[\`\${cur}|\${dur}\`]=+(sub.reduce((s,t)=>s+t.rate,0)/sub.length-adminFee(dur)).toFixed(2);
  }));
  const bank={};
  document.querySelectorAll('.bank-rate').forEach(el=>{if(el.value)bank[\`\${el.dataset.cur}|\${el.dataset.dur}\`]=parseFloat(el.value);});
  const dl={'1 Month':'1M','6 Month':'6M','12 Month':'12M','24 Month':'24M'};
  let rows='';
  CURRENCIES.forEach(cur=>DURATIONS.forEach(dur=>{
    const key=\`\${cur}|\${dur}\`, p=p2p[key], b=bank[key];
    if(p===undefined&&b===undefined)return;
    let sc='<td class="spread-zero">—</td>';
    if(p!==undefined&&b!==undefined){const sp=+(p-b).toFixed(2);const cls=sp>0?'spread-pos':sp<0?'spread-neg':'spread-zero';sc=\`<td class="\${cls}">\${sp>0?'+':''}\${sp.toFixed(2)}%</td>\`;}
    rows+=\`<tr><td>\${cur} \${dl[dur]}</td><td>\${p!==undefined?p.toFixed(2)+'%':'—'}</td><td>\${b!==undefined?b.toFixed(2)+'%':'—'}</td>\${sc}</tr>\`;
  }));
  if(!rows){document.getElementById('benchResult').innerHTML='<p style="font-size:12px;color:#aaa;margin-top:12px">请先填写至少一项利率</p>';return;}
  document.getElementById('benchResult').innerHTML=\`<table class="bench-table"><thead><tr><th>币种/期限</th><th>P2P净年化</th><th>基准利率</th><th>利差</th></tr></thead><tbody>\${rows}</tbody></table><p style="font-size:10px;color:#bbb;margin-top:8px">利差 = P2P净年化 − 基准利率，正值绿色表示P2P更优</p>\`;
}
</script>
</body>
</html>`;
  fs.writeFileSync(path.join(__dirname, 'index.html'), html);
}

main().catch(err => { console.error('错误:', err.message); process.exit(1); });
