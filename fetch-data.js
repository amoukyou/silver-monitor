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

  console.log('数据已就绪，index.html 会通过 fetch 加载 data.json 和 benchmark.json');
}

main().catch(err => { console.error('错误:', err.message); process.exit(1); });
