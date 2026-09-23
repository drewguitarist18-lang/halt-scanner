/**
 * Cloud halt scanner. Runs on Cloudflare every minute, even if the PC is off.
 * Posts only halts/unhalts from the last few minutes. Never replays the day.
 */

const RSS_URL = 'https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts';
const RPC_URL = 'https://www.nasdaqtrader.com/RPCHandler.axd';
const NYSE_URL = 'https://www.nyse.com/api/trade-halts/current?max=500';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_AGE_MIN = 8;
const MIN_CAP = 2_000_000;
const MAX_CAP = 2_000_000_000;

function stripXml(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const i = text.indexOf('<?xml');
  return i > 0 ? text.slice(i) : text;
}

function tag(xml, name) {
  const re = new RegExp(`<(?:ndaq:)?${name}[^>]*>([^<]*)</(?:ndaq:)?${name}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function usDate(value) {
  const raw = String(value || '').trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  return raw;
}

function parseHalts(xml) {
  const items = [];
  for (const part of xml.split(/<item>/i).slice(1)) {
    const chunk = part.split(/<\/item>/i)[0];
    const symbol = tag(chunk, 'IssueSymbol') || tag(chunk, 'title');
    if (!symbol) continue;
    const haltDate = tag(chunk, 'HaltDate');
    const haltTime = tag(chunk, 'HaltTime');
    const resumeDate = tag(chunk, 'ResumptionDate');
    const resumeTrade = tag(chunk, 'ResumptionTradeTime');
    items.push({
      symbol,
      name: tag(chunk, 'IssueName'),
      market: tag(chunk, 'Market'),
      reason: tag(chunk, 'ReasonCode'),
      haltDate,
      haltTime,
      resumeDate,
      resumeTrade,
      idHalt: `${symbol}|HALT|${haltDate}|${haltTime}`,
      idResume: `${symbol}|RESUME|${resumeDate}|${resumeTrade}`,
    });
  }
  return items;
}

function parseRpcHtml(html) {
  const items = [];
  for (const row of String(html).split(/<tr>/i).slice(1)) {
    const cells = [...row.matchAll(/<td>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]));
    if (cells.length < 10) continue;
    const haltDate = cells[0];
    const haltTime = cells[1];
    const symbol = cells[2];
    const resumeDate = cells[7];
    const resumeTrade = cells[9];
    if (!symbol || !haltDate || haltDate === 'Halt Date') continue;
    items.push({
      symbol,
      name: cells[3],
      market: cells[4],
      reason: cells[5],
      haltDate,
      haltTime,
      resumeDate,
      resumeTrade,
      idHalt: `${symbol}|HALT|${haltDate}|${haltTime}`,
      idResume: `${symbol}|RESUME|${resumeDate}|${resumeTrade}`,
    });
  }
  return items;
}

function nyOffsetMinutes(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'longOffset',
  }).formatToParts(date);
  const off = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT-4';
  const m = off.match(/GMT([+-])(\d+)(?::(\d+))?/);
  if (!m) return -240;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

function parseEt(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const clean = String(timeStr).split('.')[0].trim();
  const us = usDate(dateStr);
  const [mm, dd, yyyy] = us.split('/');
  if (!mm || !dd || !yyyy) return null;
  const iso = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T${clean}`;
  const fakeUtc = Date.parse(`${iso}Z`);
  if (Number.isNaN(fakeUtc)) return null;
  return new Date(fakeUtc - nyOffsetMinutes(new Date(fakeUtc)) * 60 * 1000);
}

function isLive(dt) {
  if (!dt || Number.isNaN(dt.getTime())) return false;
  const age = (Date.now() - dt.getTime()) / 60000;
  return age >= -2 && age <= MAX_AGE_MIN;
}

function isJunk(name, symbol) {
  if (/(units?|warrants?|rights?|acquisition corp|spac|\betf\b|preferred|\bnotes?\b|\btrust\b)/i.test(name || '')) return true;
  if (/(U|W|WS|WT|RW|R)$/i.test(symbol) && symbol.length >= 5 && /(unit|warrant|right|acquisition)/i.test(name || '')) return true;
  return false;
}

function parseCap(raw) {
  if (!raw || raw === 'N/A' || raw === '--') return null;
  const n = Number(String(raw).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function quoteSymbol(symbol) {
  return String(symbol || '').trim().split(/\s+/)[0];
}

function eventKey(symbol, dateStr, timeStr) {
  const sym = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const t = String(timeStr || '').split('.')[0].trim();
  return `${sym}|${usDate(dateStr)}|${t}`;
}

function mergeFeeds(nasdaqItems, nyseItems) {
  const haltKeys = new Set(nasdaqItems.map((it) => eventKey(it.symbol, it.haltDate, it.haltTime)));
  const resumeKeys = new Set(
    nasdaqItems.filter((it) => it.resumeTrade).map((it) => eventKey(it.symbol, it.resumeDate, it.resumeTrade))
  );
  const extra = [];
  for (const it of nyseItems) {
    const haltNew = !haltKeys.has(eventKey(it.symbol, it.haltDate, it.haltTime));
    const resumeNew = Boolean(it.resumeTrade) && !resumeKeys.has(eventKey(it.symbol, it.resumeDate, it.resumeTrade));
    if (!haltNew && !resumeNew) continue;
    if (haltNew) haltKeys.add(eventKey(it.symbol, it.haltDate, it.haltTime));
    if (resumeNew) resumeKeys.add(eventKey(it.symbol, it.resumeDate, it.resumeTrade));
    extra.push({
      ...it,
      idHalt: haltNew ? it.idHalt : '',
      resumeTrade: resumeNew ? it.resumeTrade : '',
      idResume: resumeNew ? it.idResume : '',
    });
  }
  return [...nasdaqItems, ...extra];
}

async function fetchRss() {
  const res = await fetch(RSS_URL, {
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
  });
  if (!res.ok) throw new Error(`RSS ${res.status}`);
  const text = await res.text();
  if (!text.includes('<rss')) throw new Error('RSS non-xml');
  return parseHalts(stripXml(text));
}

async function fetchRpc() {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Referer: 'https://www.nasdaqtrader.com/trader.aspx?id=TradeHalts',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify({ id: 2, method: 'BL_TradeHalt.GetTradeHalts', params: '[]', version: '1.1' }),
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const data = await res.json();
  const items = parseRpcHtml(data?.result || '');
  if (!items.length) throw new Error('RPC empty');
  return items;
}

async function fetchNyse() {
  const res = await fetch(NYSE_URL, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`NYSE ${res.status}`);
  const data = await res.json();
  return (data?.results?.tradeHalts || [])
    .map((row) => {
      const symbol = String(row.symbol || '').trim();
      const haltDate = usDate(row.formatedHaltDate);
      const haltTime = String(row.formatedHaltTime || '').trim();
      const resumeDate = usDate(row.formatedResumptionDate);
      const resumeTrade = String(row.formatedResumptionTime || '').trim();
      if (!symbol || !haltDate || !haltTime) return null;
      return {
        symbol,
        name: String(row.issuerName || '').trim(),
        market: String(row.sourceExchange || '').trim() || 'NYSE',
        reason: String(row.reason || '').trim(),
        haltDate,
        haltTime,
        resumeDate,
        resumeTrade,
        idHalt: `${symbol}|HALT|${haltDate}|${haltTime}`,
        idResume: `${symbol}|RESUME|${resumeDate}|${resumeTrade}`,
      };
    })
    .filter(Boolean);
}

async function fetchHalts() {
  let nasdaq = [];
  try {
    nasdaq = await fetchRss();
  } catch (e) {
    console.warn('rss', e.message);
  }
  if (!nasdaq.length) {
    try {
      nasdaq = await fetchRpc();
    } catch (e) {
      console.warn('rpc', e.message);
    }
  }
  let nyse = [];
  try {
    nyse = await fetchNyse();
  } catch (e) {
    console.warn('nyse', e.message);
  }
  if (!nasdaq.length && !nyse.length) throw new Error('no halt feeds');
  return mergeFeeds(nasdaq, nyse);
}

const capCache = new Map();
async function marketCap(symbol) {
  const sym = quoteSymbol(symbol);
  if (capCache.has(sym)) return capCache.get(sym);
  try {
    const res = await fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/summary?assetclass=stocks`, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        Origin: 'https://www.nasdaq.com',
        Referer: 'https://www.nasdaq.com/',
      },
    });
    if (!res.ok) {
      capCache.set(sym, null);
      return null;
    }
    const data = await res.json();
    const cap = parseCap(data?.data?.summaryData?.MarketCap?.value);
    capCache.set(sym, cap);
    return cap;
  } catch {
    capCache.set(sym, null);
    return null;
  }
}

async function isSmallCap(symbol, name) {
  if (isJunk(name, symbol)) return false;
  const cap = await marketCap(symbol);
  if (cap == null) return false;
  return cap >= MIN_CAP && cap <= MAX_CAP;
}

function formatCap(cap) {
  if (cap >= 1e9) return `$${(cap / 1e9).toFixed(2)}B`;
  if (cap >= 1e6) return `$${(cap / 1e6).toFixed(1)}M`;
  return `$${Math.round(cap)}`;
}

async function fetchPrice(symbol) {
  try {
    const sym = quoteSymbol(symbol);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return 'n/a';
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || meta.regularMarketPrice == null) return 'n/a';
    const price = Number(meta.regularMarketPrice);
    const prev = meta.chartPreviousClose ?? meta.previousClose;
    const ps = price >= 1 ? price.toFixed(2) : price.toPrecision(4);
    if (prev != null && prev !== 0) {
      const chg = ((price - prev) / prev) * 100;
      const sign = chg >= 0 ? '+' : '';
      return `$${ps} (${sign}${chg.toFixed(1)}%)`;
    }
    return `$${ps}`;
  } catch {
    return 'n/a';
  }
}

function embed(it, priceStr, cap, kind) {
  const isHalt = kind === 'HALT';
  const when = isHalt
    ? `${String(it.haltTime || '').split('.')[0]} ET`
    : `${String(it.resumeTrade || '').split('.')[0]} ET`;
  const label = isHalt ? 'Halt' : 'Unhalt';
  return {
    title: `${kind}: ${it.symbol}`,
    description: `**${it.symbol}** - ${it.name}\nMarket: ${it.market}\nReason: ${it.reason}\n**${label}:** ${when}\nMkt cap: **${formatCap(cap)}**\nPrice now: **${priceStr}**`,
    color: isHalt ? 0xed4245 : 0x57f287,
    footer: { text: 'LIVE small-cap US halts' },
    timestamp: new Date().toISOString(),
  };
}

async function postDiscord(env, embedBody) {
  const token = env.DISCORD_TOKEN;
  const channels = String(env.CHANNEL_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const errors = [];
  for (const channelId of channels) {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ embeds: [embedBody] }),
    });
    if (!res.ok) errors.push(`${channelId} ${res.status}`);
  }
  return errors;
}

export async function tick(env) {
  if (!env.DISCORD_TOKEN) throw new Error('missing DISCORD_TOKEN');
  if (!env.SEEN) throw new Error('missing SEEN kv');
  const items = await fetchHalts();
  const state = (await env.SEEN.get('state', 'json')) || null;

  if (!state?.boot) {
    const ids = {};
    for (const it of items) {
      if (it.idHalt) ids[it.idHalt] = 1;
      if (it.resumeTrade && it.idResume) ids[it.idResume] = 1;
    }
    await env.SEEN.put('state', JSON.stringify({ boot: true, ids }));
    return { seeded: Object.keys(ids).length, posted: [] };
  }

  const ids = state.ids || {};
  const posted = [];
  let changed = false;
  for (const it of items) {
    if (it.idHalt && !ids[it.idHalt]) {
      ids[it.idHalt] = 1;
      changed = true;
      const haltDt = parseEt(it.haltDate, it.haltTime);
      if (isLive(haltDt) && (await isSmallCap(it.symbol, it.name))) {
        const cap = await marketCap(it.symbol);
        const px = await fetchPrice(it.symbol);
        const errors = await postDiscord(env, embed(it, px, cap, 'HALT'));
        posted.push(`HALT ${it.symbol}${errors.length ? ` (${errors.join(';')})` : ''}`);
      }
    }
    if (it.resumeTrade && it.idResume && !ids[it.idResume]) {
      ids[it.idResume] = 1;
      changed = true;
      const resumeDt = parseEt(it.resumeDate, it.resumeTrade);
      if (isLive(resumeDt) && (await isSmallCap(it.symbol, it.name))) {
        const cap = await marketCap(it.symbol);
        const px = await fetchPrice(it.symbol);
        const errors = await postDiscord(env, embed(it, px, cap, 'UNHALT'));
        posted.push(`UNHALT ${it.symbol}${errors.length ? ` (${errors.join(';')})` : ''}`);
      }
    }
  }

  if (changed) {
    const keys = Object.keys(ids);
    const trimmed = keys.length > 4000 ? Object.fromEntries(keys.slice(-3000).map((k) => [k, 1])) : ids;
    await env.SEEN.put('state', JSON.stringify({ boot: true, ids: trimmed }));
  }
  return { rows: items.length, posted };
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(tick(env).catch((e) => console.warn('tick', e.message || e)));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');
    if (url.pathname !== '/tick') return new Response('halt scanner');
    const auth = request.headers.get('authorization') || '';
    if (!env.CRON_SECRET || auth !== `Bearer ${env.CRON_SECRET}`) {
      return new Response('unauthorized', { status: 401 });
    }
    try {
      const result = await tick(env);
      return Response.json(result);
    } catch (e) {
      return Response.json({ error: e.message || String(e) }, { status: 500 });
    }
  },
};
