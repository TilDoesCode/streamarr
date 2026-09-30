// Generates ../directions.html from the embedded Dev World artwork. Run: node build.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const imgDir = join(here, 's');
const vars = readdirSync(imgDir).map(f => {
  const mime = f.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const b64 = readFileSync(join(imgDir, f)).toString('base64');
  return `--${f.replace(/\.(jpg|png)$/, '')}:url(data:${mime};base64,${b64});`;
}).join('\n');

const T = {
  cosmos: { t: 'Cosmos Laundromat', y: 2015, len: '12 min', g: 'Animation, Fantasy', r: 'G', tint: '#d99a3e', tint2: '#5a3a1c', ov: 'On a desolate island, a suicidal sheep named Franck meets his fate in the form of a quirky salesman named Victor, who offers him the gift of a lifetime.' },
  tears: { t: 'Tears of Steel', y: 2012, len: '12 min', g: 'Science Fiction', r: 'NR', tint: '#4f86b0', tint2: '#1b2c3d', ov: 'Warriors and scientists gather at the Oude Kerk in Amsterdam to stage a crucial event from the past, in a desperate attempt to rescue the world from destructive robots.', logo: 1 },
  sprite: { t: 'Sprite Fright', y: 2024, len: '11 min', g: 'Animation, Horror, Comedy', r: 'PG-13', tint: '#3fcf7a', tint2: '#0f3a26', ov: 'Set in 80’s Britain: a group of rowdy teenagers trek into an isolated forest and discover peaceful mushroom creatures that turn out to be an unexpected force of nature.', logo: 1 },
  sintel: { t: 'Sintel', y: 2010, len: '15 min', g: 'Animation, Fantasy', r: 'PG', tint: '#8fb3d6', tint2: '#22303f', ov: 'A wandering warrior finds an unlikely friend in a young dragon.', logo: 1 },
  sherlock: { t: 'Sherlock', y: 2010, len: 'S1 · E2', g: 'Crime, Drama', r: '12', tint: '#5d8aa8', tint2: '#1a2a36', ov: 'A modern update finds the famous sleuth and his doctor partner solving crime in 21st century London.', logo: 1 },
  agent: { t: 'Agent 327', y: 2017, len: '4 min', g: 'Action, Comedy', r: 'NR', tint: '#d0623e', tint2: '#3b1a10', ov: '' },
  bunny: { t: 'Big Buck Bunny', y: 2008, len: '10 min', g: 'Animation, Comedy, Family', r: '6', tint: '#9ccc52', tint2: '#26361a', ov: 'A day in the life of Big Buck Bunny, who meets three bullying rodents: Frank, Rinky and Gamera. After they go too far, Bunny sets aside his gentle nature and orchestrates a complex plan for revenge.' },
};

const I = {
  home: '<path d="M4 11 12 4l8 7v9h-5v-6H9v6H4z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  film: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M7.5 4.5v15M16.5 4.5v15M3.5 9.5h4M3.5 14.5h4M16.5 9.5h4M16.5 14.5h4"/>',
  tv: '<rect x="3" y="5" width="18" height="12" rx="1.5"/><path d="M8 20h8"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/>',
  pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.4"/>',
  back10: '<path d="M5 12a7 7 0 1 0 2.1-5"/><path d="M5 4v4h4"/>',
  fwd10: '<path d="M19 12a7 7 0 1 1-2.1-5"/><path d="M19 4v4h-4"/>',
  audio: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  subs: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M7 13.5h4M13 13.5h4M7 10h10"/>',
  layers: '<path d="m12 4 8.5 4.5L12 13 3.5 8.5z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16l8.5 4.5 8.5-4.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  left: '<path d="m14.5 6-6 6 6 6"/>', right: '<path d="m9.5 6 6 6-6 6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  back: '<path d="M10 6 4 12l6 6M4 12h16"/>',
};
const ic = (n, s = 28, cls = '') => `<svg class="ic ${cls}" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${I[n]}</svg>`;
const cursor = `<svg class="cursor" width="34" height="34" viewBox="0 0 24 24"><path d="M4 2.5v17l4.6-4.3 3 6.6 3-1.3-3-6.5H18z" fill="#fff" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/></svg>`;

const bars = (n, cls = '') => `<span class="bars ${cls}">${[1, 2, 3, 4].map(i => `<i class="${i <= n ? 'on' : ''}" style="height:${4 + i * 4}px"></i>`).join('')}</span>`;

const MARK = {
  A: `<svg viewBox="0 0 64 64" class="markSvg"><circle cx="20" cy="32" r="13" fill="none" stroke="currentColor" stroke-width="4"/><circle cx="20" cy="32" r="3.5" fill="currentColor"/><path d="M33 32 60 16v32z" fill="currentColor" opacity=".9"/></svg>`,
  B: `<svg viewBox="0 0 64 64" class="markSvg"><rect x="6" y="40" width="9" height="16" fill="currentColor"/><rect x="21" y="30" width="9" height="26" fill="currentColor"/><rect x="36" y="18" width="9" height="38" fill="currentColor"/><rect x="51" y="6" width="9" height="50" fill="currentColor"/></svg>`,
  C: `<svg viewBox="0 0 64 64" class="markSvg"><defs><linearGradient id="cg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b8f5d0"/><stop offset=".5" stop-color="#7cc4ff"/><stop offset="1" stop-color="#c7a2ff"/></linearGradient></defs><path d="M22 14c0-4 4-6 7.5-4l22 13c3.5 2 3.5 7 0 9l-22 13c-3.5 2-7.5 0-7.5-4z" fill="url(#cg)" transform="translate(-3 4)"/></svg>`,
};

const D = {
  A: {
    name: 'Projector', tag: 'Cinematic and warm. The living room becomes a screening room.',
    hero: 'cosmos', player: 'cosmos', row: ['cosmos', 'sintel', 'tears', 'sherlock', 'agent'],
    fonts: 'Fraunces (display serif, optical size + soft axis) · Instrument Sans (UI)',
    eyebrow: 'Now showing · Reel 01',
  },
  B: {
    name: 'Signal', tag: 'Broadcast control room. Streamarr shows the stream internals, so it wears them.',
    hero: 'tears', player: 'tears', row: ['tears', 'sprite', 'cosmos', 'sherlock', 'agent'],
    fonts: 'Archivo Expanded (display grotesk, width axis) · Archivo (UI) · JetBrains Mono (spec labels)',
    eyebrow: 'CH 01 — Continue',
  },
  C: {
    name: 'Aurora', tag: 'Ambient and artwork-driven. Every title paints the room.',
    hero: 'sprite', player: 'sprite', row: ['sprite', 'sintel', 'cosmos', 'sherlock', 'agent'],
    fonts: 'Outfit (display, geometric) · Figtree (UI, soft geometric)',
    eyebrow: 'Continue watching',
  },
};

const progress = { cosmos: 42, tears: 68, sprite: 42, sintel: 20, sherlock: 55, agent: 80 };
const cwSub = k => k === 'sherlock' ? 'S1 · E2 · 38 min left' : `${Math.round((100 - progress[k]) / 100 * parseInt(T[k].len))} min left`;
const specOf = { cosmos: '1080P · H264 · EAC3 5.1', tears: '2160P · HEVC · HDR10', sprite: '1080P · AV1 · OPUS 5.1', sintel: '1080P · H264 · AAC', sherlock: '1080P · H264 · DD 5.1', agent: '720P · H264 · AAC', bunny: '2160P · HEVC · HDR10' };

function rail(id, mode) {
  const items = [['home', 'Home', 1], ['search', 'Search'], ['film', 'Movies'], ['tv', 'Series']];
  return `<nav class="rail"><div class="mark">${MARK[id]}</div>
  ${items.map(([i, l, on]) => `<div class="navi ${on ? 'on' : ''}">${ic(i)}<span>${l}</span></div>`).join('')}
  <div class="grow"></div><div class="navi">${ic('gear')}<span>Settings</span></div><div class="avatar">AN</div>
  ${mode === 'web' ? '<div class="kbd">/ search</div>' : ''}</nav>`;
}

function titleBlock(id, k, big = true) {
  const t = T[k];
  if (id === 'A' || !t.logo) return `<h1 class="title ${big ? '' : 'sm'}">${t.t}</h1>`;
  return `<div class="logo" style="background-image:var(--${k}-logo)" aria-label="${t.t}"></div>`;
}

function card(id, k, i, mode, focusIdx, hoverIdx) {
  const f = mode === 'tv' && i === focusIdx, h = mode === 'web' && i === hoverIdx;
  const extra = id === 'B' ? `<div class="spec"><span>${specOf[k]}</span>${bars(k === 'agent' ? 2 : 4)}</div>` : '';
  const num = id === 'A' ? `<span class="no">${String(i + 1).padStart(2, '0')}</span>` : '';
  return `<div class="card ${f ? 'focus' : ''} ${h ? 'hover' : ''}" style="--tint:${T[k].tint}">
  <div class="art" style="background-image:var(--${k}-bd)"><div class="prog"><i style="width:${progress[k]}%"></i></div></div>
  ${extra}<div class="cap">${num}<b>${T[k].t}</b><span class="sub">${cwSub(k)}</span></div>${h ? cursor : ''}</div>`;
}

function home(id, mode) {
  const d = D[id], k = d.hero, t = T[k];
  const posters = ['sprite', 'sintel', 'tears', 'bunny', 'agent', 'cosmos', 'sherlock', 'sintel'];
  const hoverIdx = 1;
  const heroFocus = mode === 'web' ? d.row[hoverIdx] : k;
  const hk = mode === 'web' && id === 'C' ? heroFocus : k;
  const ht = T[hk];
  return `<div class="scr home ${mode}" style="--tint:${ht.tint};--tint2:${ht.tint2}">
  <div class="amb" style="background-image:var(--${hk}-bd)"></div>
  <section class="hero"><div class="hero-img" style="background-image:var(--${hk}-bd)"></div><div class="hero-scrim"></div>
    ${id === 'A' ? '<div class="lb-cap"><span>● REEL 01</span><span>1.85 : 1 · 24 fps</span></div>' : ''}
    ${id === 'B' ? `<div class="hud"><span>TC 00:05:02:14</span><span>SRC 2160P HEVC HDR10</span><span class="live">${bars(4)} VERIFIED</span></div>` : ''}
    <div class="hero-copy">
      <div class="eyebrow">${d.eyebrow}</div>
      ${titleBlock(id, hk)}
      <div class="meta"><span>${ht.y}</span><span>${ht.len}</span><span>${ht.g}</span><span class="rating">${ht.r}</span></div>
      ${id === 'B' ? `<div class="chips"><span>${specOf[hk]}</span><span>DIRECT PLAY</span></div>` : ''}
      <div class="hprog"><i><u style="width:${progress[hk]}%"></u></i><span>${cwSub(hk)}</span></div>
      <p class="ov">${ht.ov}</p>
      <div class="actions"><div class="btn pri">${ic('play', 26)}<span>Resume</span></div><div class="btn sec">${ic('info', 26)}<span>More info</span></div></div>
    </div></section>
  ${rail(id, mode)}
  <section class="row r1"><header class="rh"><h2>${id === 'B' ? '<em>01</em>' : ''}Continue watching</h2><span class="count">${id === 'B' ? '05 ITEMS' : '5'}</span>${mode === 'web' ? `<div class="arrows"><span>${ic('left', 24)}</span><span class="on">${ic('right', 24)}</span></div>` : ''}</header>
    <div class="cards land">${d.row.map((kk, i) => card(id, kk, i, mode, 0, hoverIdx)).join('')}</div></section>
  <section class="row r2"><header class="rh"><h2>${id === 'B' ? '<em>02</em>' : ''}Trending movies</h2></header>
    <div class="cards post">${posters.map(p => `<div class="card"><div class="art" style="background-image:var(--${p}-po)"></div></div>`).join('')}</div></section>
  ${id === 'A' ? '<div class="grain"></div>' : ''}
  </div>`;
}

const versions = [
  { t: '1080p · WEB-DL', a: 'H.264 · Dolby Digital+ 5.1 · SRT EN, DE', size: '1.1 GB', mbps: '10', age: '42 days old', health: 'ready', local: 'Instant', method: 'direct', why: 'Plays as is on this device', rel: 'Big.Buck.Bunny.2008.1080p.WEB-DL.DDP5.1.H.264-DEVWORLD', badges: ['Recommended'] },
  { t: '4K · HDR10 · BluRay', a: 'HEVC 10-bit · TrueHD 5.1', size: '2.4 GB', mbps: '40', age: '300 days old', health: 'ready', local: 'Preparing', method: 'transcode', why: 'HDR10 isn’t supported by this screen · TrueHD converted to AAC', rel: 'Big.Buck.Bunny.2008.2160p.UHD.BluRay.TrueHD.5.1.HDR10.x265-DEVWORLD', badges: ['Last played'] },
  { t: '1080p · BluRay', a: 'H.264 · DTS 5.1', size: '600 MB', mbps: '8', age: '900 days old', health: 'degraded', local: '', method: 'remux', why: 'DTS audio isn’t supported · audio converted to AAC', rel: 'Big.Buck.Bunny.2008.1080p.BluRay.DTS.x264-DEVWORLD', badges: [] },
];
const methodLabel = { direct: 'Direct play', remux: 'Direct stream', transcode: 'Transcode' };
const specMethod = { direct: 'DIRECT PLAY', remux: 'DIRECT STREAM', transcode: 'TRANSCODE' };

function vcard(id, v, i) {
  const f = i === 0;
  if (id === 'B') {
    return `<div class="vcard ${f ? 'focus' : ''} m-${v.method}">
    <div class="vtop"><span class="vidx">V${i + 1}</span><b class="vt">${v.t.toUpperCase()}</b>${v.badges.map(b => `<span class="badge">${b.toUpperCase()}</span>`).join('')}</div>
    <div class="grid">
      <span>VIDEO</span><b>${v.a.split(' · ')[0].toUpperCase()}</b>
      <span>AUDIO</span><b>${v.a.split(' · ')[1].toUpperCase()}</b>
      <span>SIZE</span><b>${v.size} · ${v.mbps} MBIT/S</b>
      <span>AGE</span><b>${v.age.toUpperCase()}</b>
      <span>SIGNAL</span><b class="h-${v.health}">${bars(v.health === 'ready' ? 4 : 2)} ${v.health === 'ready' ? 'VERIFIED' : 'DEGRADED'}${v.local ? ' · ' + v.local.toUpperCase() : ''}</b>
      <span>METHOD</span><b class="mth">${specMethod[v.method]}</b>
    </div>
    <div class="why">&gt; ${v.why}</div><div class="rel">${v.rel}</div></div>`;
  }
  return `<div class="vcard ${f ? 'focus' : ''} m-${v.method}">
  <div class="badges">${v.badges.map(b => `<span class="badge ${b === 'Recommended' ? 'rec' : ''}">${b}</span>`).join('')}</div>
  <div class="vt">${v.t}</div><div class="va">${v.a}</div>
  <div class="vfacts"><span>${v.size}</span><span>≈ ${v.mbps} Mbit/s</span><span>${v.age}</span></div>
  <div class="vstate"><span class="health h-${v.health}"><i></i>${v.health === 'ready' ? 'Verified' : 'Degraded'}</span>${v.local ? `<span class="local">${v.local}</span>` : ''}</div>
  <div class="method"><span class="mpill">${methodLabel[v.method]}</span><span class="why">${v.why}</span></div>
  <div class="rel">${v.rel}</div></div>`;
}

function detail(id) {
  const k = 'bunny', t = T[k];
  return `<div class="scr detail" style="--tint:${t.tint};--tint2:${t.tint2}">
  <div class="amb" style="background-image:var(--${k}-bd)"></div>
  <div class="dbg" style="background-image:var(--${k}-bd)"></div><div class="dscrim"></div>
  ${rail(id, 'tv')}
  <div class="dcopy">
    <div class="eyebrow">${id === 'B' ? 'MOVIE · 2008 · ID 10378' : 'Movie'}</div>
    <h1 class="title">${t.t}</h1>
    <div class="meta"><span>${t.y}</span><span>${t.len}</span><span>${t.g}</span><span class="rating">${t.r}</span></div>
    <p class="ov">${t.ov}</p>
    <div class="actions"><div class="btn pri">${ic('play', 26)}<span>Play</span></div><div class="btn sec on">${ic('layers', 26)}<span>Versions · 3</span></div><div class="btn sec icon">${ic('check', 26)}</div></div>
    <div class="credits"><span>Director</span><b>Sacha Goedegebure</b><span>Studio</span><b>Blender Foundation</b></div>
  </div>
  <aside class="vpanel"><header><h2>${id === 'B' ? 'VERSIONS' : 'Versions'}</h2><span>${id === 'B' ? '03 SOURCES · METHOD PREDICTED FOR THIS DEVICE' : '3 versions · playback method expected on this device'}</span></header>
  ${versions.map((v, i) => vcard(id, v, i)).join('')}</aside>
  ${id === 'A' ? '<div class="grain"></div>' : ''}</div>`;
}

function player(id) {
  const k = D[id].player, t = T[k];
  const rows = [
    ['Method', 'Transcode', 'TRANSCODE'],
    ['Why', 'HDR10 isn’t supported by this screen', 'HDR10 NOT SUPPORTED BY DISPLAY'],
    ['Video', 'HEVC 10-bit HDR10 2160p → H.264 1080p SDR', 'HEVC 10B HDR10 2160P → H264 1080P SDR'],
    ['Audio', 'TrueHD 5.1 → AAC 2.0', 'TRUEHD 5.1 → AAC 2.0'],
    ['Container', 'MKV → HLS fMP4', 'MKV → HLS FMP4'],
    ['Bitrate', '40 → 8 Mbit/s', '40.0 → 8.0 MBIT/S'],
    ['Engine', 'ExoPlayer · hardware decode', 'EXOPLAYER · HW DECODE'],
    ['Buffer', '24 s ahead · 0 dropped frames', '24 S AHEAD · 0 DROPPED'],
  ];
  const spark = Array.from({ length: 40 }, (_, i) => 30 + Math.round(18 * Math.sin(i / 3) + (i * 7919 % 13))).map((h, i) => `<i style="height:${h}px"></i>`).join('');
  return `<div class="scr player" style="--tint:${t.tint};--tint2:${t.tint2}">
  <div class="pimg" style="background-image:var(--${k}-bd)"></div><div class="pscrim"></div>
  <div class="ptop"><div class="eyebrow">${id === 'B' ? 'NOW PLAYING · V2 / 03' : 'Now playing'}</div><div class="ptitle">${t.t}</div></div>
  <aside class="ipanel"><header><h2>${id === 'B' ? 'STREAM' : 'Playback info'}</h2>${id === 'B' ? `<span class="live">${bars(4)} VERIFIED</span>` : `<span class="mpill tr">Transcode</span>`}</header>
    <dl>${rows.map(r => `<dt>${id === 'B' ? r[0].toUpperCase() : r[0]}</dt><dd>${id === 'B' ? r[2] : r[1]}</dd>`).join('')}</dl>
    ${id === 'B' ? `<div class="spark"><span>THROUGHPUT 60 S · PEAK 11.2 MBIT/S</span><div>${spark}</div></div>` : `<div class="note">Server transcodes at 2.4× realtime. Pick the 1080p WEB-DL version to play without conversion.</div>`}
  </aside>
  <div class="pbottom">
    <div class="scrub"><div class="track"><i class="buf" style="width:58%"></i><i class="done" style="width:42%"></i><b style="left:42%"></b></div><div class="times"><span>05:02</span><span>−06:58</span></div></div>
    <div class="ctrls"><div class="cb main">${ic('pause', 34)}</div><div class="cb">${ic('back10', 30)}</div><div class="cb">${ic('fwd10', 30)}</div><div class="grow"></div>
      <div class="cb">${ic('audio', 30)}<span>English 5.1</span></div><div class="cb">${ic('subs', 30)}<span>Off</span></div><div class="cb">${ic('layers', 30)}<span>4K HDR</span></div><div class="cb focus">${ic('info', 30)}<span>Info</span></div></div>
  </div>
  ${id === 'A' ? '<div class="grain"></div>' : ''}</div>`;
}

function phone(id) {
  const k = 'bunny', t = T[k], v = versions[0];
  return `<div class="scr phone" style="--tint:${t.tint};--tint2:${t.tint2}">
  <div class="amb" style="background-image:var(--${k}-bd)"></div>
  <div class="ph-hero" style="background-image:var(--${k}-bd)"><div class="ph-scrim"></div></div>
  <div class="ph-status"><span>9:41</span><span>●●● ▮</span></div>
  <div class="ph-back">${ic('back', 22)}</div>
  <div class="ph-body">
    <div class="eyebrow">${id === 'B' ? 'MOVIE · 2008' : 'Movie'}</div>
    <h1 class="title">${t.t}</h1>
    <div class="meta"><span>${t.y}</span><span>${t.len}</span><span class="rating">${t.r}</span></div>
    <div class="btn pri wide">${ic('play', 22)}<span>Play</span></div>
    <div class="ph-ver"><div class="phv-l"><div class="phv-k">${id === 'B' ? 'V1 / 03' : 'Version'}</div><div class="phv-t">${id === 'B' ? v.t.toUpperCase() : v.t}</div>
      <div class="phv-a">${id === 'B' ? `${bars(4)} DIRECT PLAY · 10 MBIT/S` : `<span class="mpill">${methodLabel[v.method]}</span> H.264 · DD+ 5.1`}</div></div><div class="phv-r">${id === 'B' ? '03 ›' : '3 ›'}</div></div>
    <p class="ov">${t.ov}</p>
    <div class="ph-actions"><div>${ic('plus', 24)}<span>Watchlist</span></div><div>${ic('check', 24)}<span>Watched</span></div><div>${ic('info', 24)}<span>Details</span></div></div>
  </div>
  <div class="ph-tabs"><div class="on">${ic('home', 24)}<span>Home</span></div><div>${ic('search', 24)}<span>Search</span></div><div>${ic('film', 24)}<span>Library</span></div><div>${ic('gear', 24)}<span>Settings</span></div></div>
  ${id === 'A' ? '<div class="grain"></div>' : ''}</div>`;
}

const TOK = {
  A: { bg: '#0D0A07', surface: '#17120D', raised: '#221A12', line: '#3A2E22', fg: '#F4EADB', muted: '#A99A85', accent: '#F2A43A', accent2: '#E0662C', ok: '#9BC27A', warn: '#F2C14E', bad: '#E4573D' },
  B: { bg: '#07080A', surface: '#0E1013', raised: '#15181D', line: '#262A31', fg: '#F2F4F7', muted: '#8A919C', accent: '#D4FF3A', accent2: '#3AE0FF', ok: '#D4FF3A', warn: '#FFB224', bad: '#FF4D4D' },
  C: { bg: '#0A0C12', surface: 'rgba(255,255,255,.07)', raised: 'rgba(255,255,255,.12)', line: 'rgba(255,255,255,.14)', fg: '#FFFFFF', muted: 'rgba(255,255,255,.62)', accent: 'var(--tint) per title', accent2: '#FFFFFF', ok: '#6FE3A5', warn: '#FFD166', bad: '#FF7A8A' },
};
const RAMP = {
  A: [['Display', 'Fraunces 600 · 96/0.95 · opsz 144 · SOFT 50', 'Cosmos Laundromat'], ['Section', 'Fraunces 500 italic · 40/1.1', 'Continue watching'], ['Title', 'Instrument Sans 600 · 22/1.3', 'Sintel'], ['Body', 'Instrument Sans 400 · 24/1.5 (TV) · 17 (web/phone)', 'A wandering warrior finds a friend.'], ['Label', 'Instrument Sans 600 · 15 · +14% caps', 'NOW SHOWING · REEL 01']],
  B: [['Display', 'Archivo Expanded 800 · 104/0.9 · -2% ', 'TEARS OF STEEL'], ['Section', 'Archivo Expanded 700 · 30 caps', '01 CONTINUE WATCHING'], ['Title', 'Archivo 600 · 22/1.3', 'Sprite Fright'], ['Body', 'Archivo 400 · 24/1.5 (TV) · 16 (web/phone)', 'Warriors stage an event from the past.'], ['Spec', 'JetBrains Mono 500 · 15 · +4% caps', 'HEVC 10B · HDR10 · TRUEHD 5.1 · 40 MBIT/S']],
  C: [['Display', 'Outfit 700 · 92/1.0 · -2%', 'Sprite Fright'], ['Section', 'Outfit 600 · 34/1.2', 'Continue watching'], ['Title', 'Figtree 600 · 22/1.3', 'Cosmos Laundromat'], ['Body', 'Figtree 400 · 24/1.55 (TV) · 17 (web/phone)', 'Every title paints the room.'], ['Label', 'Figtree 600 · 16', 'Continue watching · 38 min left']],
};
const MOTION = {
  A: ['Focus: 220 ms ease-out-quint, scale 1.00 → 1.06, bloom fades in 320 ms (the "lamp warming up").', 'Hero: backdrop dissolves 600 ms with a 1.5% slow push-in (Ken Burns) while focused.', 'Letterbox bars slide in 400 ms when the player opens, the room "dims" to black.', 'Grain: static tiled texture, 6% opacity, no animation (battery, TV GPUs).'],
  B: ['Focus: 90 ms linear snap, no scale. Outline and corner ticks draw in, card lifts 6 px.', 'Hero: hard cut with a 120 ms horizontal wipe; spec chips type in left to right (40 ms stagger).', 'Signal bars fill bottom-up on load (60 ms each).', 'Numbers (bitrate, buffer) tick, never tween, like a broadcast readout.'],
  C: ['Focus: spring (damping 18, stiffness 180), scale 1.00 → 1.10, tinted glow follows.', 'Ambient: blurred backdrop and --tint crossfade 700 ms on every focus change (debounced 150 ms).', 'Glass panels rise 24 px + fade 280 ms; content never moves under them.', 'Reduced motion: crossfade only, no scale.'],
};
const STATES = {
  A: ['Focus (TV)', 'Hover (web)', 'Press'],
  B: ['Focus (TV)', 'Hover (web)', 'Press'],
  C: ['Focus (TV)', 'Hover (web)', 'Press'],
};

function brand(id) {
  const d = D[id], tk = TOK[id];
  const sw = Object.entries(tk).map(([n, v]) => `<div class="sw"><i style="background:${v.startsWith('var') ? 'linear-gradient(90deg,#3fcf7a,#d99a3e,#8fb3d6,#d0623e)' : v}"></i><b>${n}</b><span>${v}</span></div>`).join('');
  return `<div class="scr brand" style="--tint:${T[d.hero].tint};--tint2:${T[d.hero].tint2}">
  <div class="amb" style="background-image:var(--${d.hero}-bd)"></div>
  <div class="b-head"><div class="b-icon"><div class="mark">${MARK[id]}</div></div>
    <div><div class="wordmark">${id === 'B' ? 'STREAMARR' : id === 'A' ? 'Streamarr<em>.</em>' : 'streamarr'}</div><div class="b-tag">${d.tag}</div><div class="b-fonts">${d.fonts}</div></div></div>
  <div class="b-grid">
    <div class="b-col"><h3>Colour tokens</h3><div class="sws">${sw}</div></div>
    <div class="b-col"><h3>Type ramp</h3>${RAMP[id].map(r => `<div class="ramp r-${r[0].toLowerCase()}"><span class="rk">${r[0]} <small>${r[1]}</small></span><div class="rs">${r[2]}</div></div>`).join('')}</div>
    <div class="b-col"><h3>Focus · hover · press</h3><div class="states">
      ${STATES[id].map((s, i) => `<div class="st"><div class="card st${i} ${i === 0 ? 'focus' : i === 1 ? 'hover' : 'press'}" style="--tint:${T.sintel.tint}"><div class="art" style="background-image:var(--sintel-po)"></div>${i === 1 ? cursor : ''}</div><span>${s}</span></div>`).join('')}</div>
      <div class="btnrow"><div class="btn pri">${ic('play', 22)}<span>Play</span></div><div class="btn sec">${ic('info', 22)}<span>More info</span></div><span class="mpill">Direct play</span><span class="mpill st">Direct stream</span><span class="mpill tr">Transcode</span></div>
      <h3 style="margin-top:28px">Motion</h3><ul class="motion">${MOTION[id].map(m => `<li>${m}</li>`).join('')}</ul></div>
  </div>${id === 'A' ? '<div class="grain"></div>' : ''}</div>`;
}

const frame = (fid, w, h, inner, label) => `<figure class="frame" id="${fid}" data-w="${w}" data-h="${h}"><div class="fwrap"><div class="fscale">${inner}</div></div><figcaption>${label}<span>${fid}.png · ${w}×${h}</span></figcaption></figure>`;

const IMPL = {
  A: { effort: 'M', items: ['Bundle Fraunces (variable, roman + italic, subset Latin) and Instrument Sans with expo-font; web uses the same files via @font-face.', 'Film grain: one 256 px tiled PNG (≈18 KB) as an absolute overlay at 6% opacity; skipped on low-RAM Android TV.', 'Bloom: a pre-rendered radial PNG behind the focused card (no runtime blur, safe on TV GPUs).', 'Letterbox hero: fixed band + hard edges, pure layout, no new data.', 'No server change.'] },
  B: { effort: 'M', items: ['Bundle Archivo (variable with wdth axis; on native ship static Expanded 700/800 + Regular/SemiBold instances) and JetBrains Mono 500.', 'Spec labels need codec/HDR/audio of the default version on list items: small catalog DTO addition (videoCodec, hdr, audioLayout) or derive from the existing version summary.', 'Signal bars: map existing health (ready/degraded) + local (instant/preparing) to 4/2 bars; one component.', 'Throughput sparkline in the info panel: sample player bitrate each second on the client.', '0 radius everywhere: token change, fits TV focus rendering well.'] },
  C: { effort: 'L', items: ['Dominant colour per title. Recommended: server-side palette extraction when artwork is cached (e.g. SkiaSharp/ImageSharp k-means on the backdrop, 2 swatches) exposed as tint + tint2 on catalog DTOs. Client alternative: react-native-image-colors (native, adds per-image cost on TV).', 'Blurred ambient backdrop: expo-image blurRadius on native, CSS filter on web; pre-blurred small variant from the server is cheaper on TV.', 'Glass: expo-blur BlurView on native (iOS Liquid Glass later via expo-glass-effect), backdrop-filter on web, solid rgba fallback on Android TV.', 'Crossfade of backdrop + tint on focus (Reanimated shared value for the tint).', 'Bundle Outfit + Figtree.'] },
};

function direction(id) {
  const d = D[id], im = IMPL[id];
  return `<section class="dir" id="dir-${id}"><div class="dir-head"><span class="dl">Direction ${id}</span><h2>${d.name}</h2><p>${d.tag}</p><p class="fonts">${d.fonts}</p></div>
  <div class="d${id}">
  ${frame(`${id}-brand`, 1920, 1080, brand(id), 'Brand block: wordmark, app icon, tokens, type ramp, states, motion')}
  <figure class="frame" id="${id}-home" data-w="1920" data-h="1080"><div class="fwrap"><div class="fscale">${home(id, 'tv')}
    <div class="inset"><div class="inset-lbl">Web desktop · same layout · pointer hover + row arrows</div><div class="inset-in">${home(id, 'web')}</div></div></div></div>
    <figcaption>(1) One large-screen home, TV focus on the first card; inset: web desktop with hover and pointer<span>${id}-home.png · 1920×1080</span></figcaption></figure>
  ${frame(`${id}-home-web`, 1920, 1080, home(id, 'web'), '(1b) The same home on web desktop at full size (hover, pointer, row arrows, / to search)')}
  ${frame(`${id}-detail`, 1920, 1080, detail(id), '(2) Movie detail with the version panel open: attributes, health, predicted playback method')}
  ${frame(`${id}-player`, 1920, 1080, player(id), '(3) Player overlay with the info panel open')}
  <div class="phone-row">${frame(`${id}-phone`, 390, 844, phone(id), '(4) Phone detail, compact variant of the same components')}
  <div class="impl"><h3>What ${d.name} needs</h3><div class="effort">Effort <b>${im.effort}</b></div><ul>${im.items.map(x => `<li>${x}</li>`).join('')}</ul></div></div>
  </div></section>`;
}

const shellSvg = `<svg viewBox="0 0 960 540" class="shell-svg" font-family="ui-monospace,monospace" font-size="11">
<rect x="0" y="0" width="960" height="540" fill="#0c0d10" stroke="#333"/>
<rect x="0" y="0" width="52" height="540" fill="#16181d"/><text x="8" y="270" fill="#9aa" transform="rotate(-90 26 270)">rail 104 px</text>
<rect x="52" y="0" width="908" height="330" fill="#1b1e24"/><text x="96" y="40" fill="#cde">hero 660 px · follows focus · backdrop 1500 px right-aligned</text>
<rect x="84" y="90" width="380" height="180" fill="none" stroke="#6af" stroke-dasharray="4 3"/><text x="92" y="108" fill="#6af">copy column 760 px @ x=168</text>
<text x="92" y="128" fill="#9aa">eyebrow · logo/title · meta · progress · overview · actions</text>
<rect x="84" y="355" width="176" height="99" fill="#2a2f38"/><rect x="272" y="355" width="176" height="99" fill="#2a2f38"/><rect x="460" y="355" width="176" height="99" fill="#2a2f38"/><rect x="648" y="355" width="176" height="99" fill="#2a2f38"/><rect x="836" y="355" width="124" height="99" fill="#2a2f38"/>
<rect x="80" y="351" width="184" height="107" fill="none" stroke="#fc6" stroke-width="2"/><text x="84" y="344" fill="#cde">row header 44 px · landscape card 352×198 · gap 24</text>
<text x="84" y="476" fill="#9aa">title + subline under card</text>
<rect x="84" y="500" width="104" height="40" fill="#2a2f38"/><rect x="200" y="500" width="104" height="40" fill="#2a2f38"/><rect x="316" y="500" width="104" height="40" fill="#2a2f38"/><text x="440" y="522" fill="#9aa">poster 208×312 · next row peeks</text>
<text x="850" y="344" fill="#fc6">web: ‹ ›</text></svg>`;

const shell = `<section class="shell" id="shell"><h2>One large-screen shell</h2>
<p class="lead">Today TV and web are two apps that happen to share data: the TV home is a hero with focus rows and a bare icon rail, web desktop is a sidebar with a labelled menu, a separate greeting header and different card sizes, and the version picker and player overlay use different layouts on each. From here on TV, web desktop and tablet render <b>one</b> layout at 1920×1080 logical points (scaled to the viewport); only the input layer changes.</p>
<div class="shell-grid">${shellSvg}
<table class="stable"><thead><tr><th>Shared by TV, web desktop, tablet</th><th>Spec</th></tr></thead><tbody>
<tr><td>Navigation rail</td><td>104 px, brand mark on top, Home · Search · Movies · Series, Settings + profile avatar at the bottom. Icons only; labels expand on focus (TV) or hover (web) as an overlay, the content never shifts.</td></tr>
<tr><td>Hero</td><td>660 px, follows the focused/hovered item after 150 ms, backdrop right-aligned, copy column 760 px at x = 168: eyebrow, logo (fallback: display title), meta, resume progress, 2-line overview, Play/Resume + More info.</td></tr>
<tr><td>Rows and cards</td><td>Section header 44 px (display face), landscape card 352×198 for Continue watching/episodes, poster 208×312 for catalogue rows, gap 24, left edge x = 168, the next row peeks from the bottom edge.</td></tr>
<tr><td>Detail</td><td>Full-bleed backdrop, copy column left, actions Play · Versions · Watched. Seasons/episodes below as landscape cards.</td></tr>
<tr><td>Version panel</td><td>Right side panel 780 px over a dimmed detail, one card per version: title, codecs, size/bitrate/age, health + local state, predicted method with reason, release name. Recommended first.</td></tr>
<tr><td>Player overlay</td><td>Title top left, scrub bar + control row at the bottom, side panels (audio, subtitles, versions, info) slide in from the right at 620 px.</td></tr>
<tr><td>Motion</td><td>One token set: focus/hover, hero crossfade, panel in/out, identical on every large screen.</td></tr>
<tr><td>Phone</td><td>Compact variant of the same components: stacked hero, bottom tabs, version panel becomes a sheet.</td></tr>
</tbody></table>
<table class="stable diff"><thead><tr><th>Differs only by input</th><th>TV (D-pad)</th><th>Web desktop (pointer + keyboard)</th></tr></thead><tbody>
<tr><td>Selection</td><td>Focus state: full direction-specific focus treatment, always exactly one focused element</td><td>Hover state (lighter), plus the same focus ring for keyboard focus (:focus-visible)</td></tr>
<tr><td>Row scrolling</td><td>Focus scrolls the row, focused card stays at x = 168</td><td>‹ › arrows in the row header on hover, wheel/trackpad scroll</td></tr>
<tr><td>Shortcuts</td><td>Back closes panels, Play/Pause key, long-press = context</td><td>/ search, Space play/pause, ←/→ seek 10 s, I info, V versions, Esc closes</td></tr>
<tr><td>Hero</td><td>Follows focus</td><td>Follows hover with the same 150 ms delay; click opens detail</td></tr>
</tbody></table></div></section>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Streamarr · three visual directions</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,300..900&family=Figtree:wght@400;500;600;700&family=Fraunces:ital,opsz,wght,SOFT@0,9..144,300..900,0..100;1,9..144,300..900,0..100&family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&family=Outfit:wght@400;500;600;700;800&display=block" rel="stylesheet">
<style>:root{${vars}}</style>
<style>${readFileSync(join(here, 'styles.css'), 'utf8')}</style></head><body>
<header class="doc-head"><div class="doc-kicker">Streamarr · D1 · visual identity</div><h1>Three directions. Pick one.</h1>
<p>The current app is a neutral dark UI with a default violet accent and system fonts; nothing in it could only be Streamarr. Each direction below is a complete identity with its own typography, colour, surfaces, focus language and motion, mocked on real Dev World artwork across the four key screens. All three share <a href="#shell">one large-screen shell</a>, so whichever you pick, TV, web and tablet stop diverging.</p>
<nav class="toc"><a href="#dir-A"><b>A</b> Projector<span>cinematic · warm · serif</span></a><a href="#dir-B"><b>B</b> Signal<span>broadcast · technical · mono</span></a><a href="#dir-C"><b>C</b> Aurora<span>ambient · artwork-tinted · glass</span></a><a href="#shell"><b>+</b> Shell<span>one layout for TV, web, tablet</span></a></nav></header>
${shell}
${['A', 'B', 'C'].map(direction).join('')}
<footer class="doc-foot">Artwork: Blender Foundation open movies and Sherlock (BBC) via TMDB, as used by Dev World. Fonts: Google Fonts, SIL Open Font License.</footer>
<script>
const shot=new URLSearchParams(location.search).get('shot');
if(shot){document.body.classList.add('shot');const f=document.getElementById(shot);f.classList.add('only');}
function fit(){document.querySelectorAll('.frame').forEach(f=>{const w=+f.dataset.w,h=+f.dataset.h,wr=f.querySelector('.fwrap'),s=f.classList.contains('only')?1:Math.min(1,wr.parentElement.clientWidth/w);wr.style.width=w*s+'px';wr.style.height=h*s+'px';f.querySelector('.fscale').style.transform='scale('+s+')';});}
addEventListener('resize',fit);fit();
</script></body></html>`;

writeFileSync(join(here, '..', 'directions.html'), html);
console.log('bytes', Buffer.byteLength(html));
