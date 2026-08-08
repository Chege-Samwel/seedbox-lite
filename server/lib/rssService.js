/**
 * The home catalog is fed by the four RSS views supplied in the product
 * brief.  RSS is intentionally fetched on the server so the browser never
 * has to deal with CORS, malformed CDATA, or an unavailable upstream feed.
 *
 * The small fixed catalog below is a deterministic fallback for first boot,
 * offline development, and an upstream outage.  Live results replace it per
 * feed whenever they are available.
 */
const crypto = require('crypto');
const db = require('./jsondb');
const metadata = require('./metadataService');

const RSS_CACHE_KEY = 'tpb_rss_cache_v1';
const RSS_TTL_MS = 15 * 60 * 1000;
const HOME_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;

const FEEDS = [
  { key: 'movies-new', category: 'movies', kind: 'new', label: 'Movies · Latest', url: 'https://tpb.party/rss/new/201' },
  { key: 'movies-top', category: 'movies', kind: 'top', label: 'Movies · Top 100', url: 'https://tpb.party/rss/top100/201' },
  { key: 'tv-new', category: 'tv', kind: 'new', label: 'TV Shows · Latest', url: 'https://tpb.party/rss/new/205' },
  { key: 'tv-top', category: 'tv', kind: 'top', label: 'TV Shows · Top 100', url: 'https://tpb.party/rss/top100/205' },
];

// These are deliberately ordinary catalog records rather than a second XML
// document. That keeps the fallback useful even when the RSS endpoint is
// unavailable and makes it easy to add/remove a pinned item without escaping
// a large XML blob in source code.
const FIXED = {
  'movies-top': [
    ['Avatar: Fire and Ash (2025) 1080p TS EN-RGB', '927BEC221ECE5E95E55FA6BE735230324110832F', 7907661668],
    ['S4: The Bob Lazar Story (2026) [1080, x265]', '5A0E02479B580A67F7F519FC297DD0523CBB7EF4', 3683481097],
    ['The Odyssey (1997) DVDRip XviD-ETRG', 'B98AAA86B2241F3F60F93B5CD9C1C67F4B807783', 1491053208],
    ['The Age of Disclosure (2025) [720]', 'EEFBD77E4D3346AEE3FE0EBFC2E39381DB369FBE', 2479666189],
    ["Andrei Tarkovsky's Stalker (1979) 1080p x265 HEVC", 'A08ADAB0CA7A4B40391109E781BB5ED2DF2E350E', 1155841159],
    ['American Psycho (2000) Remastered 1080p BluRay', 'D1AD4F4CCCC44E6227283BD334487E777EB88EDC', 2147349674],
    ['Shaun of the Dead (2004) 1080p x265 HEVC', '554CC47F9DA3A45CF6A4D94802BC154358C27EE9', 1352941528],
    ['Amelie (2001) BRRip x264 AAC', 'D1C5BD9A2EEC5FE6EBA19E7F663AF3E8D932AB8E', 1461383631],
    ['Ghost in the Machine (2026)', '57C65E9E10A48380EC6D803A5401ABCAB75BEF6B', 3206767685],
    ['Jackass: Number Two (2006) PROPER 1080p WEBRip', '6B725BDB64D34131C707BA8A4081B98F9DDEE0A5', 1880921863],
    ['Blade Runner 2049 HDRip XviD AC3', '4C9D18E1CDE6DACD39F6443D76DDBA8E7E82A06B', 1890144693],
    ['Complete Looney Tunes Golden Collection [DVDrip]', '2606A5830780074B089FAB96904009DA412C1C3D', 31292762297],
    ['The Worst Person in the World (2021)', 'F821424E33A49ABD8816823ADBC03B340331C0AF', 3213802238],
    ['The Incredibles 2 (2018) HDRip XviD AC3', 'C1CE06B0AEE58B9AE5FCE1DFC4A9D0EC8E015A12', 1297417701],
    ['La Haine (1995) REMASTERED BDRip', 'B4CADA42F869B6B142B55FD72CD490E29AEE8615', 1142665040],
    ['Before Sunrise (1995) DVDRip x264', '427893B6C4ED7F9BE45D09E0F92E236278770822', 1185942081],
    ['Sicario (2015) 720p BRRip', '39F301178307B2E015F27E208A7AEB985DC13040', 1302298317],
    ['Rango (2011) EXTENDED 1080p BluRay', '41C4194C6BA338BDDBA91B66F6E3F71EF183BFD2', 2290087507],
  ],
  'movies-new': [
    ['OFF THE GRID (2025) AMZN WEB-DL [Ukr Dub]', 'E6D44057231544A260A035A8F9C948E69D719F36', 2652592154],
    ['OFF THE GRID (2025) 1080p AMZN WEB-DL [Ukr Dub]', '0A0EF8B301D464B0E35CEF45D04084B5B02F0776', 6620624040],
    ['LITTLE BROTHER (2026) AMZN WEB-DL [Ukr Dub]', 'D4483DBAA8737FF15E7E3512B0B09F0D6F65E534', 2477524730],
    ['Masters of the Universe (2026) Hybrid WEBRip', 'F9359251FCBE36C6229EE10A299D14254E7BE7C5', 8255458740],
    ['Prophecy (1979) environmental disaster sci-fi', 'C4862B6B4E09CFDDFB7F797EB2068C312C042C1A', 4285573320],
    ['Bellman and True (1987) bank heist thriller', '946384A11279D9A20BF3B78990164E3F0D955B38', 6435500889],
    ['The Stars Fell on Henrietta (1995)', 'C7DF61E47E41A715927B0C03AF4B1C7AF8EF0F13', 1601941206],
    ['All Things Pass (1981) DVD AV1 10Bit', '2523E73ED171FFB2C1B5CA14A66D7CF2BCA26EB0', 263907158],
    ['The Candy Snatchers (1973)', '16E480482CA5EC64CA37D6A3682071B8E64DB0EE', 743769819],
    ['The School Duel (2024) sci-fi', 'A19D27CDA0130FF29C0459D992EFB42A8D064935', 3427759380],
    ['Cinderella (1977) SD h264', '480E85F1A9CB2C79C2968BEC7047D84AA65B6846', 1146716199],
    ['Prophet of Ecstasy (2026) 1080p WEB-RIP', '84BC5A431CED851BB6B737441C9BE159F12D412F', 4094260271],
    ['The Intruders (2015) 1080p WEBRip x265', '2AD346B9BE30C68EF35E162027B62DB5F0F1A4DE', 1540099527],
    ['Enola Holmes 3 (2026) 576p WEBRip', 'E2EAB2828DF010EB70F8BCF1A8B9D1A7A3A4CF78', 1358770051],
    ['The Tech Billionaire Takeover (2026)', 'B823A1B96703B2112A59C47D3E8C2CC88CCDD08A', 3986159640],
    ['Mortal Kombat II (2026) WEBDL', '242B9FC64B3F6791A41A5E584CC8BB8AD2A8CA6D', 2661638938],
    ['The Hadron Collider: In Search of the Peace Particle (2026)', '66622763784BCF9DE69F015F050DF8FB91415C6D', 2249554917],
    ['Sunspiracy (2026) 720p WEB-DL', '0092E712BEDB1B699757F05A51334D45C2AC14E4', 333490179],
  ],
  'tv-top': [
    ['Breaking Bad Season 1 Complete 1080p 10bit BluRay', '6BBAD06245A0D631B0A5E47C8CD6E5ABC9A70211', 4521579480],
    ['Modern Family Season 2 1080p BluRay x265', '9E6B6959535F018D4E995F88962FA49EB0F89BCB', 5411205810],
    ['Modern Family Season 4 1080p BluRay x265', '2B3A76C56DAAE7293EA918671F3395E97E05BB56', 5407116837],
    ['The Sopranos Complete Series + Extras', 'E2234E0317A4F6748B6CE90DB924CA4A82751CFC', 34756300515],
    ['Twin Peaks Season 1 Complete DVDRip', 'BA1E0E886988D653186477DDB8E4A7CD190F42A7', 1517357434],
    ['House, M.D. Season 7 1080p Bluray', 'A02461997F0111D1BE355488245560296D91B301', 8497726835],
    ['Adventure Time Seasons 1-10 Complete', 'DCCE80AA10325EDE128EF115A5B616DC77AF8FF9', 6253620803],
    ['The IT Crowd Complete Season 1-5', '9E6FB4038530A10A88294A0CFEF5900D13378A92', 5238510792],
    ['House MD Seasons 1-8 + Extras', 'C16FBC6D6B0F1F4E68E51BCF3CDC21A7D91A644B', 68463422596],
    ['The Black Adder Complete DVDRip', '7519E0CADD903CCF72DF27B99B888C11DC7BF608', 13561871745],
    ['The Simpsons Seasons 1-9 + Shorts', '145AF2CA5EB7D508A2A3801A0A822ACEFCEE1897', 8190438531],
    ['Star Trek The Next Generation Seasons 1-7', '30764610642571B3C01AF11D6CE60CFA164D7EE3', 69767661095],
    ['The Bear Season 3 Complete 2160p', 'F823DE36719A88DB64C9AE0FD8713E198D11425A', 40406053233],
    ['Star Trek Voyager Complete Seasons 1-7', '872DD4946CC6C4E8C1380D7C4E93C56694138093', 35892468021],
    ['Futurama Seasons 1-7 + 4 Movies', 'B73C766A0205FB23D8FC1E23E9DB30E588A7F004', 6284222366],
    ['Trailer Park Boys Seasons 1-12 + Movies', '09B62AF7E65CCC5CBD0444710209B3E0A222EC6E', 21839951544],
  ],
  'tv-new': [
    ['Lioness 2023 S03E01 480p', 'DBBBA5227D5CCFDD21CAD6115B6B93AE8FD05B1B', 406708578],
    ['House of the Dragon S03E07 480p', '6B79664B1D9C899D242DAA8A5296C8425B28DAA0', 436206933],
    ['Ted Lasso S04E01 480p', '523F96CC02B16D7A4A42F1A8130C779E8A4910D9', 364634362],
    ['Star Trek Strange New Worlds S04E01 480p', 'BCE0AD8D281B3A3638DF9525B4093FE1559A13FC', 444983961],
    ['Star Trek Strange New Worlds S04E02 480p', '85B3ADCC1DAF154D4A2CF49F3ACAAFD9F4B3469C', 399664881],
    ['Lucky 2026 S01E05 480p', 'DF0A92C70125FB3955DFB6BC4C0F87B5CC423240', 370579077],
    ['House of the Dragon S03E07 XviD', '0717BC5EE0090317881ABE01B38AAA5BB2DFFA14', 545633600],
    ['Silo S03E05 480p', 'BF1893DC32B1272373EF814A1F56A3AB6BCDBEA0', 375488292],
    ['Kitchen Nightmares US S10E04 480p', 'F7277159D0CCAFA3CD090694F3E209BB90777621', 266403793],
    ['X-Men 97 S02E08 480p', 'DBD75FCE1B43E9AD289B9CF1E47BF6808D4BEF04', 316305392],
    ['The Librarians: The Next Chapter S02E01', '6A13FABE5F4B8E9E196AAEA38B1C8BE7A1CF0620', 361274807],
    ['The Secret of Skinwalker Ranch S07E12', 'B9FB9E2A44BD280D7DAFBD7007174245C8271EED', 168914154],
    ['The Walking Dead: Dead City S03E02', 'E838A6855F6FDBD18234AED77EA7554BB31C58B8', 359289034],
    ['The Ark S03E01 HDTV', 'AC43489732A9A87DD95860173A3C5B0B7EEDF0CE', 475288044],
    ['Sterling Point S01E01 480p', '7C0005BEF6379D6B7C62910AF7BCD346EDB2FEF8', 432389797],
    ['WWE SummerSlam 2026 Night One', '46081E8843978A2E24D367B2CA33E266A084239A', 3328568794],
    ['One Hundred Years of Solitude S02E07', '919BEDC6141065D779BFC8E0712DBB415608AFB1', 444562784],
    ['The Challenge S42E02', 'D1069D8695C08AE19F25621ED3B9AED4422B0B4C', 622212720],
    ['Wizards Beyond Waverly Place S03E04', 'DE10433DA21E1E1B28AE355B71DC5D7AF7114A37', 302831534],
    ['Olivia Attwood: The Price of Perfection S03E04', '5B1C0029B92587D266CE264B779D688ED10C1483', 532020042],
    ['The Love Lab S01E10', 'F13A28BE1BE255B928C97637FFFC338DBEDA334D', 382523683],
  ],
};

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function xmlDecode(input) {
  let value = String(input || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // Some mirrors double-escape ampersands. Decode a few rounds, but never
  // URI-decode magnet values because %2F/%26 are meaningful there.
  for (let i = 0; i < 3; i++) {
    const before = value;
    value = value
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    if (value === before) break;
  }
  return value.trim();
}

function stripDecoratedText(value) {
  let text = xmlDecode(value);
  // The supplied example was copied through a wiki/Markdown renderer. Live
  // RSS does not normally contain this, but accepting it makes the fallback
  // and pasted feeds render cleanly too.
  text = text.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\](?:\([^)]*\))?/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  return text.replace(/\s+/g, ' ').trim();
}

function tag(xml, names) {
  for (const name of names) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i');
    const hit = xml.match(re);
    if (hit) return xmlDecode(hit[1]);
  }
  return '';
}

function number(value) {
  const n = parseInt(String(value || '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function dateValue(value, fallback = 0) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : fallback;
}

function hashFrom(magnet, infoHash) {
  const direct = String(infoHash || '').match(/[a-f\d]{32,40}/i);
  const fromMagnet = String(magnet || '').match(/xt=urn:btih:([a-z\d]{32,40})/i);
  return (direct?.[0] || fromMagnet?.[1] || '').toLowerCase();
}

function magnetName(magnet) {
  const match = String(magnet || '').match(/[?&]dn=([^&]+)/i);
  if (!match) return '';
  try { return decodeURIComponent(match[1].replace(/\+/g, ' ')); } catch { return match[1]; }
}

function episodeInfo(title, magnet) {
  // A normal RSS item repeats the name in its magnet dn. Prefer the title
  // when it already contains an episode token so S01E01 is not counted twice.
  const magnetTitle = magnetName(magnet);
  const text = /\bS\d{1,2}E\d{1,3}\b/i.test(title) ? title : `${title} ${magnetTitle}`;
  const matches = [...text.matchAll(/\bS(\d{1,2})E(\d{1,3})\b/gi)]
    .map((m) => ({ season: Number(m[1]), episode: Number(m[2]) }));
  const first = matches[0] || null;
  const pack = /\b(complete|season\s*\d+(?:\s*[-&,]\s*\d+)*|s\d{1,2}\s*[-–]\s*s\d{1,2})\b/i.test(text);
  const cleaned = metadata.cleanTitle(title).title || title;
  const showTitle = first || pack
    ? cleaned.replace(/\s+(?:complete|season\s*\d+|s\d{1,2}e\d{1,3}).*$/i, '').trim()
    : null;
  return {
    showTitle: showTitle || null,
    season: first?.season ?? null,
    episode: first?.episode ?? null,
    isEpisode: !!first,
    isPack: pack || matches.length > 1,
    episodeCount: matches.length || (pack ? null : 0),
    tokens: matches,
  };
}

function artworkFallback(item) {
  const label = encodeURIComponent(item.episodeInfo.showTitle || item.title).slice(0, 120);
  const text = item.category === 'tv' ? 'TV%20SHOW%20%7C%20' : 'MOVIE%20%7C%20';
  return {
    poster: `https://placehold.co/600x900/171c27/d9ffe9?text=${text}${label}`,
    backdrop: `https://placehold.co/1600x900/10141d/a9f5ca?text=${text}${label}`,
  };
}

function normalize(raw, feed, index, fixed = false) {
  const title = stripDecoratedText(raw.title || raw.name || 'Untitled');
  const magnet = xmlDecode(raw.magnet || raw.link || '');
  const hash = hashFrom(magnet, raw.infoHash) || crypto.createHash('sha1').update(magnet || `${feed.key}:${index}:${title}`).digest('hex').slice(0, 40).toLowerCase();
  const publishedAt = raw.publishedAt || raw.pubDate || '';
  const item = {
    id: hash,
    kind: 'rss',
    category: feed.category,
    feedKey: feed.key,
    feedKind: feed.kind,
    feedLabel: feed.label,
    title,
    rawTitle: raw.rawTitle || title,
    magnet,
    infoHash: hash,
    torrentId: raw.torrentId || null,
    comments: raw.comments || null,
    creator: raw.creator || '',
    size: number(raw.size || raw.contentLength),
    publishedAt: new Date(dateValue(publishedAt, fixed ? Date.now() - index * 3600000 : 0) || Date.now()).toISOString(),
    publishedMs: dateValue(publishedAt, fixed ? Date.now() - index * 3600000 : 0),
    poster: null,
    backdrop: null,
    overview: '',
    metadata: null,
    fixed,
  };
  item.episodeInfo = episodeInfo(title, magnet);
  Object.assign(item, artworkFallback(item));
  return item;
}

function fixedItems(feed) {
  return (FIXED[feed.key] || []).map(([title, infoHash, size], index) => normalize({ title, infoHash, size, magnet: `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}` }, feed, index, true));
}

function parseRss(xml, feed) {
  const items = [];
  const matches = String(xml || '').match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];
  for (let index = 0; index < matches.length; index++) {
    const itemXml = matches[index];
    const link = tag(itemXml, ['link']);
    const magnet = tag(itemXml, ['magnetURI']) || (link.startsWith('magnet:') ? link : '');
    const title = tag(itemXml, ['title']) || magnetName(magnet) || 'Untitled';
    const parsed = normalize({
      title,
      rawTitle: xmlDecode(title),
      magnet: magnet || link,
      comments: tag(itemXml, ['comments']),
      pubDate: tag(itemXml, ['pubDate']),
      creator: tag(itemXml, ['dc:creator', 'creator']),
      infoHash: tag(itemXml, ['infoHash']),
      contentLength: tag(itemXml, ['contentLength']),
      torrentId: (tag(itemXml, ['guid', 'comments']).match(/torrent\/(\d+)/i) || [])[1] || null,
    }, feed, index, false);
    if (parsed.magnet && parsed.infoHash) items.push(parsed);
  }
  return items;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8', 'User-Agent': 'Heiken/2.0 catalog reader' },
    });
    if (!response.ok) throw new Error(`RSS HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function readCache() { return db.read(RSS_CACHE_KEY, { feeds: {} }); }
function writeCache(data) { db.write(RSS_CACHE_KEY, data); }

async function getFeed(feed, force = false) {
  const cache = readCache();
  const cached = cache.feeds[feed.key];
  if (!force && cached?.at && Date.now() - cached.at < RSS_TTL_MS && cached.items?.length) return cached.items;
  try {
    const xml = await fetchText(feed.url);
    const items = parseRss(xml, feed);
    if (!items.length) throw new Error('RSS contained no magnet items');
    cache.feeds[feed.key] = { at: Date.now(), items };
    writeCache(cache);
    return items;
  } catch (error) {
    // Keep a stale live copy if we have one, otherwise use the fixed brief.
    console.warn(`⚠️ ${feed.label} unavailable: ${error.message}`);
    if (cached?.items?.length) return cached.items;
    const items = fixedItems(feed);
    cache.feeds[feed.key] = { at: Date.now(), items, fixed: true };
    writeCache(cache);
    return items;
  }
}

async function enrich(item) {
  try {
    const query = item.episodeInfo.showTitle || metadata.cleanTitle(item.title).title || item.title;
    const type = item.category === 'tv' ? 'show' : 'movie';
    const result = await Promise.race([
      metadata.lookup(query, { type }),
      sleep(1800).then(() => null),
    ]);
    if (result?.found && result.best) {
      item.poster = result.best.poster || item.poster;
      item.backdrop = result.best.backdrop || item.backdrop;
      item.overview = result.best.overview || '';
      item.metadata = result.best;
    }
  } catch (_) { /* placeholder artwork is intentional fallback */ }
  return item;
}

async function enrichHome(rows) {
  // Artwork providers are remote and can be slow. Enrich the most visible
  // cards only; every other card already has a deterministic image URL.
  const targets = rows.flatMap((row) => row.items.slice(0, 4));
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const item = targets[cursor++];
      await enrich(item);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return rows;
}

let homeMemo = { at: 0, data: null, items: new Map() };

async function home({ force = false } = {}) {
  if (!force && homeMemo.data && Date.now() - homeMemo.at < HOME_TTL_MS) return homeMemo.data;
  const feedItems = await Promise.all(FEEDS.map((feed) => getFeed(feed, force)));
  const byFeed = new Map(FEEDS.map((feed, i) => [feed.key, feedItems[i]]));
  const rows = FEEDS.map((feed) => {
    let items = [...(byFeed.get(feed.key) || [])];
    if (feed.kind === 'new') items.sort((a, b) => b.publishedMs - a.publishedMs);
    // A feed can repeat a magnet. Keep the first occurrence in that row.
    // Case-insensitive dedup: hashes are normalized lowercase but guard anyway.
    const seen = new Set();
    items = items.filter((item) => {
      const key = String(item.infoHash || '').toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { key: feed.key, title: feed.label, hint: feed.kind === 'new' ? 'Newest RSS entries' : 'RSS top 100', category: feed.category, kind: feed.kind, items };
  });
  await enrichHome(rows);
  const data = {
    catalog: 'rss',
    source: 'tpb.party',
    updatedAt: new Date().toISOString(),
    feeds: FEEDS.map(({ key, category, kind, label, url }) => ({ key, category, kind, label, url })),
    rows,
    offline: rows.every((row) => row.items.every((item) => item.fixed)),
  };
  homeMemo = { at: Date.now(), data, items: new Map(rows.flatMap((r) => r.items.map((item) => [String(item.infoHash || '').toLowerCase(), item]))) };
  return data;
}

async function getItem(infoHash) {
  await home();
  const found = homeMemo.items.get(String(infoHash || '').toLowerCase());
  if (!found) return null;
  // Return a fresh object so route consumers cannot mutate the memoized home.
  return { ...found, episodeInfo: { ...found.episodeInfo, tokens: [...(found.episodeInfo.tokens || [])] } };
}

module.exports = { FEEDS, home, getItem, parseRss, normalize, fixedItems };
