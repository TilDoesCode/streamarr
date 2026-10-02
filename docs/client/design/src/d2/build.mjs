// Generates ../../detail-concept.html (D2). Run: node docs/client/design/src/d2/build.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SH, MOVIES, V_BUNNY, V_SINTEL, V_SHER, METHOD, METHOD_SHORT, CH, deDate, ep } from './data.mjs';
import { DOC } from './doc.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const USE = ['sherlock-bd.jpg', 'sherlock-logo.png', 'bunny-bd.jpg', 'sintel-bd.jpg', 'sintel-logo.png', 'cosmos-bd.jpg', 'sprite-bd.jpg', 'sprite-logo.png', 'tears-bd.jpg', 'tears-logo.png', 'bunny-po.jpg', 'sintel-po.jpg'];
const b64 = (dir, f) => `--${f.replace(/\.(jpg|png)$/, '')}:url(data:${f.endsWith('.png') ? 'image/png' : 'image/jpeg'};base64,${readFileSync(join(dir, f)).toString('base64')});`;
const vars = [...USE.map(f => b64(join(here, '..', 's'), f)), ...readdirSync(join(here, 's')).filter(f => !f.startsWith('cur-')).map(f => b64(join(here, 's'), f))].join('\n');

const I = {
  home: '<path d="M4 11 12 4l8 7v9h-5v-6H9v6H4z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  film: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M7.5 4.5v15M16.5 4.5v15M3.5 9.5h4M3.5 14.5h4M16.5 9.5h4M16.5 14.5h4"/>',
  tv: '<rect x="3" y="5" width="18" height="12" rx="1.5"/><path d="M8 20h8"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.4"/>',
  layers: '<path d="m12 4 8.5 4.5L12 13 3.5 8.5z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16l8.5 4.5 8.5-4.5"/>',
  restart: '<path d="M5 12a7 7 0 1 0 2.1-5"/><path d="M5 4v4h4"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  back: '<path d="M10 6 4 12l6 6M4 12h16"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  right: '<path d="m9.5 6 6 6-6 6"/>', left: '<path d="m14.5 6-6 6 6 6"/>',
  chev: '<path d="m6 9.5 6 6 6-6"/>',
  star: '<path d="m12 3.8 2.5 5.3 5.7.7-4.2 3.9 1.1 5.7L12 16.6l-5.1 2.8 1.1-5.7-4.2-3.9 5.7-.7z" fill="currentColor" stroke="none"/>',
  alert: '<path d="M12 4 21 19.5H3z"/><path d="M12 10v4.5M12 17v.3"/>',
  direct: '<circle cx="12" cy="12" r="8.5"/><path d="m8 12.3 2.8 2.8L16.2 9.6"/>',
  remux: '<path d="M4 8h12.5M13 4.5 16.5 8 13 11.5M20 16H7.5M11 12.5 7.5 16l3.5 3.5"/>',
  transcode: '<path d="M19.5 12a7.5 7.5 0 0 1-13.1 5M4.5 12a7.5 7.5 0 0 1 13.1-5"/><path d="M17.8 3.5v3.7h-3.7M6.2 20.5v-3.7h3.7"/>',
  vlc: '<path d="M9.6 4h4.8l4.6 15.5H5z"/><path d="M7.4 11.5h9.2M3.5 19.5h17"/>',
  unknown: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.6M12 16.8v.3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  wifi: '<path d="M4 9.5a12 12 0 0 1 16 0M7 13a7.5 7.5 0 0 1 10 0M10 16.5a3 3 0 0 1 4 0"/><path d="M4 4l16 16"/>',
};
const ic = (n, s = 28) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${I[n]}</svg>`;
const cursor = (x, y) => `<svg class="cursor" style="left:${x}px;top:${y}px" width="40" height="40" viewBox="0 0 24 24"><path d="M4 2.5v17l4.6-4.3 3 6.6 3-1.3-3-6.5H18z" fill="#fff" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
const finger = (x, y) => `<div class="touch" style="left:${x}px;top:${y}px"></div>`;
const bars = n => `<span class="bars">${[1, 2, 3, 4].map(i => `<i class="${i <= n ? 'on' : ''}" style="height:${5 + i * 4}px"></i>`).join('')}</span>`;
const chips = a => `<span class="chips">${a.map(x => `<span class="sl">${x}</span>`).join('')}</span>`;
const MARK = `<svg viewBox="0 0 64 64" width="46" height="46"><defs><linearGradient id="cg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b8f5d0"/><stop offset=".5" stop-color="#7cc4ff"/><stop offset="1" stop-color="#c7a2ff"/></linearGradient></defs><path d="M22 14c0-4 4-6 7.5-4l22 13c3.5 2 3.5 7 0 9l-22 13c-3.5 2-7.5 0-7.5-4z" fill="url(#cg)" transform="translate(-3 4)"/></svg>`;

// ---------- shell chrome ----------
function rail(active = 'tv') {
  const items = [['home'], ['search'], ['film'], ['tv']];
  return `<nav class="rail"><div class="mk">${MARK}</div>${items.map(([i]) => `<div class="navi ${i === active ? 'on' : ''}">${ic(i)}</div>`).join('')}<div class="grow"></div><div class="navi">${ic('gear')}</div><div class="avatar">AN</div></nav>`;
}
const tabbar = (active = 'Serien') => `<nav class="tabbar">${[['home', 'Start'], ['film', 'Filme'], ['tv', 'Serien'], ['gear', 'Einstellungen']].map(([i, l]) => `<span class="${l === active ? 'on' : ''}">${ic(i, 22)}${l}</span>`).join('')}<span>${ic('search', 22)}</span></nav>`;
const winctl = () => `<div class="winctl"><i></i><i></i><i></i></div>`;
const backBtn = (focus) => `<div class="backbtn ${focus ? 'f' : ''}">${ic('back', 26)}</div>`;
const status = () => `<div class="ipstatus"><span>12:04</span><span>Freitag 2. Okt.</span><span class="grow"></span><span>100 %</span></div>`;

// ---------- page parts ----------
function art(k, cls = '') {
  return `<div class="amb" style="background-image:var(--${k}-bd)"></div><div class="bd ${cls}" style="background-image:var(--${k}-bd)"></div><div class="scrim"></div>`;
}

const ACT = {
  play: ['play', 'Abspielen', 'pri'], resume: ['play', 'Fortsetzen', 'pri'], again: ['restart', 'Erneut ansehen', 'pri'],
  restart: ['restart', 'Von vorne', ''], versions: ['layers', 'Versionen', ''], details: ['layers', 'Details', ''],
  watched: ['check', '', 'icon'], info: ['info', 'Mehr zur Serie', ''], unwatched: ['check', '', 'icon on'], none: ['film', 'Noch keine Version', 'pri none'],
};
function actions(list, focus = -1, hover = -1) {
  return `<div class="actions">${list.map((a, i) => {
    const [key, extra = ''] = Array.isArray(a) ? a : [a, ''];
    const [icon, label, cls] = ACT[key];
    return `<div class="btn ${cls} ${i === focus ? 'f' : ''} ${i === hover ? 'h' : ''}" data-a="${key}">${ic(icon, 26)}${label ? `<span>${label}${extra}</span>` : ''}</div>`;
  }).join('')}</div>`;
}
// ---------- D2b version chip row ----------
const VB = 104; // fixed block height under the buttons: 22 gap + 44 row + 10 + 28 reason line
const W_SPEC = t => 24 + t.length * 11.3, W_METH = t => 32 + 24 + 10 + t.length * 10.8, W_LAST = 214;
// Drop order when space is short: size, source, audio codec (channels stay), video codec. Method, resolution, HDR never drop.
function fitChips(c, maxW, extra = 0) {
  const steps = [x => { x.size = null; }, x => { x.src = null; }, x => { x.au = [x.au[1]]; }, x => { x.vc = null; }];
  const x = { ...c, au: [...c.au] };
  const list = () => [x.res, x.hdr, x.vc, x.au.join(' '), x.src, x.size].filter(Boolean);
  const width = () => W_METH(METHOD_SHORT[x.m]) + extra + list().reduce((a, t) => a + W_SPEC(t) + 10, 0);
  let dropped = 0;
  while (width() > maxW && dropped < steps.length) steps[dropped++](x);
  return { chips: list(), dropped, sizeIdx: x.size ? list().length - 1 : -1 };
}
function vrow(c, o = {}) {
  if (!c) return '';
  const st = o.state;
  if (st === 'none') return `<div class="vblock"><div class="vrow"><span class="vnone">${o.none || 'Für diese Folge gibt es noch keine abspielbare Version.'}</span></div><div class="vwhy"></div></div>`;
  if (st === 'loading') {
    const w = [230, 80, 80, 104, 92];
    return `<div class="vblock"><div class="vrow">${w.map((x, i) => `<span class="vsk ${i ? '' : 'm'}" style="width:${x}px"></span>`).join('')}</div><div class="vwhy"><span class="vsk line" style="width:300px"></span></div></div>`;
  }
  if (st === 'error') return `<div class="vblock"><div class="vrow"><span class="mchip m-unknown">${ic('unknown', 24)}<span>Ungeprüft</span></span></div><div class="vwhy">Versionen nicht geladen · Abspielen startet die Empfehlung des Servers</div></div>`;
  const f = fitChips(c, o.maxW ?? 880, o.last ? W_LAST + 10 : 0);
  const why = (c.why || []).slice(0, 2).join(' · ');
  const line = [why ? `<span class="t">${why}</span>` : '', c.m === 'direct' && c.note && !o.hint ? `<span class="n">${c.note}</span>` : '', o.hint ? `<span class="h">${o.hint}</span>` : ''].filter(Boolean).join('<i>·</i>');
  return `<div class="vblock ${o.cls || ''}"><div class="vrow"><span class="mchip m-${c.m} ${o.hoverM ? 'hov' : ''}">${ic(c.m, 24)}<span>${METHOD_SHORT[c.m]}</span></span>${f.chips.map((t, i) => `<span class="vs ${i === f.sizeIdx ? 'sz' : ''}">${t}</span>`).join('')}${o.last ? `<span class="lastp">${ic('clock', 20)}Zuletzt gespielt</span>` : ''}</div><div class="vwhy m-${c.m}">${line}</div>${o.tip || ''}</div>`;
}
const progress = (pct, label) => `<div class="prog"><i><u style="width:${pct}%"></u></i><span>${label}</span></div>`;

function movieCopy(m, o) {
  const title = m.logo ? `<div class="logo mlogo" style="background-image:var(--${o.key}-logo)"></div>` : `<h1 class="mtitle">${m.t}</h1>`;
  return `<div class="copy movie" style="bottom:${o.bottom}px">
  <div class="eyebrow"><i></i>Film</div>${title}
  <div class="meta"><span>${m.y}</span><span>${m.min} Min.</span><span>${m.g.join(', ')}</span><span class="fsk">${m.fsk}</span>${o.prog ? inlineProg(...o.prog) : ''}</div>
  <p class="ov">${m.ov}</p>
  ${actions(o.actions, o.focus, o.hover)}
  ${vrow(o.vr, o.vro)}</div>`;
}
const inlineProg = (pct, label) => `<span class="iprog2"><i><u style="width:${pct}%"></u></i>${label}</span>`;

function seriesCopy(e, o) {
  const st = o.state || {};
  if (o.legacy) return `<div class="copy series" style="bottom:${o.bottom}px">
  ${o.noLogo ? '' : '<div class="logo slogo" style="background-image:var(--sherlock-logo)"></div>'}
  <div class="eyebrow"><i></i>Staffel ${e.s} · Folge ${e.e}${st.next ? ' · Als Nächstes' : ''}</div>
  <h1 class="etitle">${e.t}</h1>
  <div class="meta"><span>${e.min} Min.</span><span>${deDate(e.air)}</span>${e.spec ? chips([e.spec.resolution.toUpperCase(), e.spec.videoCodec, e.spec.audio]) : ''}</div>
  <p class="ov">${e.ov}</p>
  ${st.prog ? progress(...st.prog) : ''}
  ${actions(o.actions, o.focus, o.hover)}</div>`;
  return `<div class="copy series" style="bottom:${o.bottom}px">
  ${o.noLogo ? '' : '<div class="logo slogo" style="background-image:var(--sherlock-logo)"></div>'}
  <div class="eyebrow"><i></i>Staffel ${e.s} · Folge ${e.e}${st.next ? ' · Als Nächstes' : ''}</div>
  <h1 class="etitle">${e.t}</h1>
  <div class="meta"><span>${e.min} Min.</span><span>${deDate(e.air)}</span>${st.prog ? inlineProg(...st.prog) : ''}</div>
  <p class="ov ${o.ovLines ? 'l' + o.ovLines : ''}">${e.ov}</p>
  ${actions(o.actions, o.focus, o.hover)}
  ${vrow(st.noVersion ? {} : (o.vr ?? CH.sherE2), st.noVersion ? { state: 'none' } : o.vro)}</div>`;
}

function seriesInfo(o = {}) {
  return `<aside class="info ${o.focus ? 'f' : ''} ${o.cls || ''}" style="bottom:${o.bottom}px">
  <div class="ih">Über die Serie</div>
  <p>${SH.ov}</p>
  <div class="facts"><span>2010 – 2014</span><span>3 Staffeln</span><span>9 Folgen</span></div>
  <div class="facts"><span>${SH.genres.join(', ')}</span></div>
  <div class="facts"><span class="star">${ic('star', 18)} 8,5</span><span class="fsk">12</span><span>BBC One</span></div>
  <div class="iprog"><i><u style="width:${(o.played ?? 1) / 9 * 100}%"></u></i><span>${o.played ?? 1} von 9 gesehen</span></div>
  ${o.more === false ? '' : `<div class="more">Mehr zur Serie ${ic('right', 18)}</div>`}</aside>`;
}

function movieInfo(m, o = {}) {
  return `<aside class="info movie ${o.focus ? 'f' : ''}" style="bottom:${o.bottom}px">
  <div class="ih">Details</div>
  <dl>${m.orig !== m.t ? `<dt>Originaltitel</dt><dd>${m.orig}</dd>` : ''}${m.crew.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('')}<dt>Bewertung</dt><dd><span class="star">${ic('star', 18)} ${m.vote}</span> TMDB</dd></dl>
  ${o.more === false ? '' : `<div class="more">Mehr ${ic('right', 18)}</div>`}</aside>`;
}

function seasons(active, o = {}) {
  const list = o.list || [[1, '1/3'], [2, '0/3'], [3, '0/3']];
  return `<div class="seasons" style="bottom:${o.bottom}px">${list.map(([n, c]) => `<span class="sc ${n === active ? 'on' : ''} ${n === o.focus ? 'f' : ''}">${n === 0 ? 'Specials' : `Staffel ${n}`}<em>${c}</em></span>`).join('')}<span class="count">${o.count || ''}</span></div>`;
}

function ecard(e, st = {}) {
  const sub = st.sub ?? (st.watched ? `Gesehen` : st.prog ? `Noch ${st.left} Min.` : `${e.min} Min.`);
  return `<div class="ecard ${st.focus ? 'f' : ''} ${st.marked ? 'mk' : ''} ${st.hover ? 'h' : ''} ${st.dim ? 'dimc' : ''} ${st.noVersion ? 'nov' : ''}">
  <div class="still" style="background-image:var(--sh-${e.s}${e.e})">
    ${st.next ? '<span class="nextp">Als Nächstes</span>' : ''}${st.watched ? `<span class="seen">${ic('check', 20)}</span>` : ''}
    ${st.prog ? `<span class="sprog"><u style="width:${st.prog}%"></u></span>` : ''}
    ${st.playOverlay ? `<span class="pov">${ic('play', 30)}</span>` : ''}
    ${st.noVersion ? '<span class="novp">Keine Version</span>' : ''}
  </div>
  <div class="ecap"><b><em>${e.e}</em>${st.title || e.t}</b><span>${sub}</span></div><i class="mbar"></i></div>`;
}

function strip(cards, o = {}) {
  return `<div class="strip ${o.cls || ''}" style="bottom:${o.bottom ?? 60}px;${o.shift ? `transform:translateX(${-o.shift}px)` : ''}">${cards.join('')}</div>`;
}

function vcard(v, o = {}) {
  return `<div class="vcard ${o.focus ? 'f' : ''} ${o.hover ? 'h' : ''} m-${v.m}">
  <div class="vtop">${v.badges.map(b => `<span class="badge ${b === 'Empfohlen' ? 'rec' : ''}">${b}</span>`).join('')}${o.playing ? '<span class="badge cur">Wird gespielt</span>' : ''}</div>
  <div class="vt">${v.t}</div>
  <div class="vspec">${chips(v.spec)}<span class="vfacts">${v.facts}</span></div>
  <div class="vstate">${v.health ? `${bars(v.health)}<span>${v.health >= 4 ? 'Geprüft' : 'Eingeschränkt'}</span>` : '<span class="mutedt">Zustand unbekannt</span>'}${v.local ? `<span class="loc">${v.local}</span>` : ''}</div>
  <div class="method"><span class="mp">${METHOD[v.m]}</span><span class="why">${v.why.join('<br>')}</span></div>
  <div class="rel">${v.rel}</div></div>`;
}

function sheet(list, o = {}) {
  const kind = o.kind || 'tv';
  return `<div class="dim ${kind}"></div><aside class="sheet ${kind}" ${o.style ? `style="${o.style}"` : ''}>
  ${kind === 'ipad' ? '<div class="grab"></div>' : ''}
  <header><div><h2>Versionen</h2><p>${o.sub}</p></div>${kind !== 'tv' ? `<div class="xbtn ${o.xhover ? 'h' : ''}">${ic('close', 24)}</div>` : ''}</header>
  ${o.both ? `<div class="sboth"><span>Bestes Bild</span><b>${o.both[0]}</b><span>Auf diesem Gerät</span><b>${o.both[1]}</b></div>` : ''}
  <div class="vlist">${list.map((v, i) => vcard(v, { focus: i === o.focus, hover: i === o.hover, playing: i === o.playing })).join('')}</div>
  ${o.foot ? `<footer>${o.foot}</footer>` : ''}</aside>`;
}

// ---------- focus map overlay ----------
function fmap(W, H, items) {
  const defs = `<defs><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="#FFD166"/></marker><marker id="ahb" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="#FF9AA8"/></marker></defs>`;
  const body = items.map(it => {
    if (it.t === 'a') {
      const col = it.back ? '#FF9AA8' : '#FFD166';
      const d = it.d || `M${it.x1} ${it.y1} L${it.x2} ${it.y2}`;
      return `<path d="${d}" stroke="${col}" stroke-width="5" fill="none" stroke-dasharray="${it.back ? '12 9' : '0'}" marker-end="url(#${it.back ? 'ahb' : 'ah'})" ${it.both ? `marker-start="url(#ah)"` : ''}/>`;
    }
    if (it.t === 'l') {
      const w = it.w || (it.s.length * 11.5 + 30);
      return `<g transform="translate(${it.x} ${it.y})"><rect x="0" y="-24" width="${w}" height="36" rx="18" fill="${it.back ? '#3a1820' : '#2a2410'}" stroke="${it.back ? '#FF9AA8' : '#FFD166'}" stroke-width="2"/><text x="15" y="0" fill="${it.back ? '#FFD3DA' : '#FFE7A8'}" font-size="20" font-weight="700" font-family="Figtree">${it.s}</text></g>`;
    }
    if (it.t === 'n') return `<g transform="translate(${it.x} ${it.y})"><circle r="22" fill="#FFD166"/><text x="0" y="8" text-anchor="middle" font-size="24" font-weight="800" fill="#1a1405" font-family="Outfit">${it.s}</text></g>`;
    return '';
  }).join('');
  return `<svg class="fmap" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${defs}${body}</svg>`;
}

// ---------- screens ----------
const scr = (o, inner) => `<div class="scr m-${o.mode} ${o.cls || ''}" style="width:${o.W}px;height:${o.H}px;--tint:${o.tint};--tint2:${o.tint2}">${inner}</div>`;
const chrome = (o) => o.mode === 'atv' ? tabbar(o.rail === 'film' ? 'Filme' : 'Serien') : o.mode === 'phone' ? '' : rail(o.rail || 'tv') + (o.mode === 'ipadwin' ? winctl() : '') + (o.mode === 'ipad' ? status() : '') + (o.mode !== 'tv' ? backBtn(false) : '');

const SER = { tint: '#5d8aa8', tint2: '#1a2a36' };
const E = (s, e) => ep(s, e);
const s1Cards = (o = {}) => [
  ecard(E(1, 1), { watched: true, ...(o[1] || {}) }),
  ecard(E(1, 2), { prog: 62, left: 34, next: true, ...(o[2] || {}) }),
  ecard(E(1, 3), { ...(o[3] || {}) }),
  endCard(2),
];
function endCard(n) { return `<div class="endc"><div class="endin"><span>Weiter mit</span><b>Staffel ${n}</b>${ic('right', 30)}</div></div>`; }
const ser = (o) => ({ ...SER, ...o });

// series page geometry (logical px): strip bottom 60, card 198 + caption 72 -> strip top = H-330; seasons 44 high, 30 above strip; copy bottom 56 above seasons
const G = { strip: 72, seasonsB: 72 + 270 + 30, copyB: 72 + 270 + 30 + 44 + 30 };
const MV = { bunny: CH.bunnyWeb, sintel: CH.sintelBr, cosmos: CH.cosmos, sprite: CH.sprite, tears: CH.tears4k };

function seriesPage(o) {
  const e = o.ep || E(1, 2);
  const W = o.W || 1920, H = o.H || 1080;
  return scr(ser({ W, H, mode: o.mode || 'tv', cls: 'series ' + (o.cls || '') }), `${art('sherlock', 'ser')}${chrome({ mode: o.mode || 'tv' })}
  ${seriesCopy(e, { bottom: G.copyB, actions: o.actions || [['resume'], ['restart'], ['versions', ' · 3'], ['watched']], focus: o.focus ?? 0, hover: o.hover, state: o.state || { next: true, prog: [62, 'Noch 34 Min.'] }, ovLines: o.ovLines, vr: o.vr, vro: o.vro })}
  ${o.noInfo ? '' : seriesInfo({ bottom: G.copyB + VB, focus: o.infoFocus, played: o.played })}
  ${seasons(o.season || 1, { bottom: G.seasonsB, focus: o.seasonFocus, count: o.count ?? 'Folge 2 von 3', list: o.seasonList })}
  ${strip(o.cards || s1Cards(o.cardState || { 2: { marked: true } }), { bottom: G.strip, shift: o.shift })}
  ${o.extra || ''}`);
}

function moviePage(key, o) {
  const m = MOVIES[key];
  const W = o.W || 1920, H = o.H || 1080;
  return scr({ W, H, mode: o.mode || 'tv', tint: m.tint, tint2: m.tint2, cls: 'movie ' + (o.cls || '') }, `${art(key, 'mov')}${chrome({ mode: o.mode || 'tv', rail: 'film' })}
  ${movieCopy(m, { key, bottom: o.bottom ?? 72, actions: o.actions || [['play'], ['versions', ' · 3'], ['watched']], focus: o.focus ?? 0, hover: o.hover, prog: o.prog, vr: o.vr === undefined ? MV[key] : o.vr, vro: o.vro })}
  ${o.noInfo ? '' : movieInfo(m, { bottom: (o.bottom ?? 72) + VB, focus: o.infoFocus })}
  ${o.extra || ''}`);
}

// ---------- frames ----------
const FR = {};
function frame(id, w, h, k, html, cap, opts = {}) {
  FR[id] = { w, h };
  return `<figure class="frame ${opts.cls || ''}" id="${id}" data-w="${w}" data-h="${h}" data-k="${k}"><div class="fwrap"><div class="fscale">${html}</div></div><figcaption><span>${cap}</span><code>jpg/${id}.jpg · ${w}×${h}</code></figcaption></figure>`;
}
const tv = (id, html, cap, opts) => frame(id, 1920, 1080, 1, html, cap, opts);

const F = {};

// Variants
F.v1 = tv('D2-v1-buehne', seriesPage({ focus: -1, cardState: { 2: { marked: true, focus: true } } }), 'Variante 1 · Bühne: eine ruhige Seite ohne Scrollen. Fokus auf Folge 2 im Streifen, Text und Buttons oben zeigen diese Folge, Serieninfos klein rechts.');

{
  const top = scr(ser({ W: 1920, H: 1080, mode: 'tv', cls: 'series v2a' }), `${art('sherlock', 'ser full')}${rail()}
    <div class="copy series" style="bottom:250px"><div class="logo slogo big" style="background-image:var(--sherlock-logo)"></div>
    <div class="meta"><span>2010 – 2014</span><span>3 Staffeln</span><span>Krimi, Drama, Mystery</span><span class="fsk">12</span>${chips(['1080P', 'H.264', '5.1'])}</div>
    <p class="ov">${SH.ov}</p>${progress(62, 'S1 · F2 · Noch 34 Min.')}${actions([['resume', ' S1 · F2'], ['restart'], ['versions', ' · 3'], ['watched']], 0)}</div>
    <div class="peek"><span>Staffel 1</span><span>Staffel 2</span><span>Staffel 3</span><span class="p2">Folgen · Über die Serie · Technik ${ic('chev', 22)}</span></div>`);
  const low = scr(ser({ W: 1920, H: 1080, mode: 'tv', cls: 'series v2b' }), `<div class="amb" style="background-image:var(--sherlock-bd)"></div><div class="scrim2"></div>${rail()}
    <div class="v2h">Staffel 1 <em>Staffel 2</em><em>Staffel 3</em></div>
    <div class="v2eps">${[1, 2, 3].map(n => { const e = E(1, n); return `<div class="v2ep ${n === 2 ? 'f' : ''}"><div class="still" style="background-image:var(--sh-1${n})">${n === 2 ? '<span class="sprog"><u style="width:62%"></u></span>' : ''}</div><b>${n} · ${e.t}</b><span>${e.min} Min. · ${deDate(e.air)}</span><p>${e.ov}</p></div>`; }).join('')}</div>
    <div class="v2sec"><h3>Über die Serie</h3><p>${SH.ov}</p></div>
    <div class="v2sec tech"><h3>Technik · S1 · F2</h3>${V_SHER.map(v => `<div class="v2v"><b>${v.t}</b>${chips(v.spec)}<span class="mp m-${v.m}">${METHOD[v.m]}</span></div>`).join('')}</div>`);
  F.v2 = tv('D2-v2-ebenen', `<div class="board2"><div class="bhead"><b>Variante 2 · Ebenen</b><span>Beim Öffnen nur Serie und Play · Runter scrollt die ganze Seite zu Folgen, Serieninfo und Technik</span></div><div class="bmini"><div class="bscale">${top}</div><span>Ebene 1 · beim Öffnen</span></div><div class="barrow">${ic('right', 64)}<b>Runter</b></div><div class="bmini"><div class="bscale">${low}</div><span>Ebene 2 · nach Runter (Seite scrollt)</span></div></div>`, 'Variante 2 · Ebenen: oben nur die Serie und Play, nach unten scrollt die Seite zu großen Folgenkarten, „Über die Serie“ und einem ruhigen Technik-Abschnitt.');
}
F.v3 = tv('D2-v3-spotlight', scr(ser({ W: 1920, H: 1080, mode: 'tv', cls: 'series v3' }), `<div class="amb" style="background-image:var(--sh-12-hd)"></div><div class="bd v3bd" style="background-image:var(--sh-12-hd)"></div><div class="scrim"></div>${rail()}
  <div class="v3top"><div class="logo slogo" style="background-image:var(--sherlock-logo)"></div><span>2010 – 2014 · 3 Staffeln · Krimi, Drama, Mystery</span><span class="fsk">12</span></div>
  ${seriesCopy(E(1, 2), { legacy: true, noLogo: true, bottom: 330, actions: [['resume'], ['restart'], ['versions', ' · 3'], ['watched']], focus: -1, state: { next: true, prog: [62, 'Noch 34 Min.'] } })}
  <div class="v3strip">${[[1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 3], [3, 1]].map(([s, e], i) => `<div class="v3c ${i === 1 ? 'f' : ''}"><div class="still" style="background-image:var(--sh-${s}${e})">${i === 0 ? `<span class="seen">${ic('check', 18)}</span>` : ''}${i === 1 ? '<span class="sprog"><u style="width:62%"></u></span>' : ''}</div><span>S${s} · F${e}</span></div>`).join('')}</div>`),
  'Variante 3 · Spotlight: das Standbild der Folge wird zum Hintergrund, Staffeln laufen in einem Streifen durch, Serieninfos schrumpfen auf eine Zeile oben.');

// Recommended: movie
F.mDefault = tv('D2-movie-default', moviePage('bunny', {}), 'Film · Standard (Big Buck Bunny): Fokus auf „Abspielen“, beide Specs in einer Zeile, Versionen hinter einem Button, Details rechts klein.');
F.mResume = tv('D2-movie-resume', moviePage('sintel', { actions: [['resume'], ['restart'], ['versions', ' · 3'], ['watched']], prog: [28, 'Noch 11 Min.'], focus: 0 }), 'Film · Fortsetzen (Sintel): Fortschritt, „Von vorne“ daneben; Fokus auf Fortsetzen.');
{
  const mini = (html, label) => `<div class="qcell"><div class="qscale">${html}</div><span>${label}</span></div>`;
  F.mStates = tv('D2-movie-states', `<div class="quad">
  ${mini(moviePage('cosmos', { actions: [['again'], ['versions', ' · 2'], ['unwatched']], focus: 0 }), 'Gesehen: „Erneut ansehen“, Haken gefüllt')}
  ${mini(moviePage('tears', { actions: [['none'], ['watched']], vro: { state: 'none', none: 'Für diesen Film gibt es noch keine abspielbare Version.' }, focus: 0 }), 'Keine Version: nur der Hinweis-Button (fokussierbar, ohne Aktion) und Gesehen')}
  ${mini(moviePage('sprite', { actions: [['play'], ['details'], ['watched']], focus: 1 }), 'Eine Version, Wiedergabe mit VLC: „Details“ statt „Versionen · N“')}
  ${mini(moviePage('sintel', { actions: [['play'], ['versions', ' · 3'], ['watched']], vr: CH.sintelHdr, focus: 0 }), 'Nur Umwege: die Chip-Zeile sagt „Transkodiert“ und warum (HDR10 → SDR)')}
  </div>`, 'Film · Zustände: gesehen, keine Version, eine Version, nur Transkodierung.');
}

// Version sheet
F.sheetTv = tv('D2-sheet-tv', moviePage('bunny', { focus: -1, extra: sheet(V_BUNNY, { sub: 'Big Buck Bunny · erwartete Wiedergabe auf diesem Gerät', focus: 0, both: ['4K · HDR10', '1080p SDR'] }) }), 'Versions-Sheet auf dem TV: eigene Route über der Seite, Fokus gefangen, Start auf der empfohlenen Version; Select spielt, Menu/Zurück schließt und gibt den Fokus an „Versionen“ zurück.');
F.sheetIpad = frame('D2-sheet-ipad', 1366, 1024, 0.72, moviePage('bunny', { W: 1897, H: 1422, mode: 'ipad', focus: -1, bottom: 110, extra: sheet(V_BUNNY, { kind: 'ipad', sub: 'Big Buck Bunny · erwartete Wiedergabe auf diesem iPad', both: ['4K · HDR10', '1080p SDR'] }) + finger(1060, 760) }), 'iPad: formSheet (Liquid Glass, bestehende Route versions/[workId]), schließen mit ✕, Wischen nach unten oder Tippen daneben.');
F.sheetWeb = tv('D2-sheet-web', moviePage('bunny', { mode: 'web', focus: -1, extra: sheet(V_BUNNY, { kind: 'web', sub: 'Big Buck Bunny · erwartete Wiedergabe in diesem Browser', hover: 1, both: ['4K · HDR10', '1080p SDR'] }) + cursor(1760, 540) }), 'Web: Schublade rechts, Esc / ✕ / Klick daneben schließt, Fokus bleibt drin (Tab), Hover hebt die Karte an.');

// Series
F.sInit = tv('D2-series-initial', seriesPage({ focus: 0 }), 'Serie · beim Öffnen: Fokus auf „Fortsetzen“, die nächste Folge (S1 · F2) ist vorausgewählt und im Streifen markiert.');
F.sStrip = tv('D2-series-strip', seriesPage({
  ep: E(1, 3), state: {}, actions: [['play'], ['versions', ' · 2'], ['watched']], focus: -1,
  cardState: { 2: {}, 3: { marked: true, focus: true } }, count: 'Folge 3 von 3',
}), 'Serie · Fokus wandert im Streifen: Folge 3 bekommt den Fokus, oben wechseln Titel, Text, Specs und Buttons (Abspielen statt Fortsetzen). Select spielt sie.');
F.sS3 = tv('D2-series-season3', seriesPage({
  ep: E(3, 2), state: { noVersion: true }, actions: [['none'], ['watched']], focus: -1, season: 3, count: 'Folge 2 von 3', seasonList: [[1, '1/3'], [2, '0/3'], [3, '0/3'], [0, '0/2']],
  cards: [ecard(E(3, 1), { noVersion: true, dim: true }), ecard(E(3, 2), { noVersion: true, marked: true, focus: true, dim: true }), ecard(E(3, 3), { noVersion: true, dim: true, title: E(3, 3).t + ' – Teil eins einer sehr langen Doppelfolge' })],
}), 'Serie · Staffel ohne Versionen, Specials am Ende, langer Titel: Karten gedimmt mit „Keine Version“, oben der Hinweis statt Play.');

// TV focus maps
{
  const map = fmap(1920, 1080, [
    { t: 'n', x: 160, y: 466, s: '1' },
    { t: 'l', x: 958, y: 462, s: 'Erster Fokus · ← → zwischen Buttons', w: 380 },
    { t: 'a', x1: 162, y1: 498, x2: 112, y2: 498 },
    { t: 'a', x1: 948, y1: 498, x2: 1352, y2: 498 }, { t: 'l', x: 1010, y: 548, s: 'Rechts: Über die Serie', w: 250 },
    { t: 'a', x1: 140, y1: 520, x2: 140, y2: 680, both: true },
    { t: 'l', x: 1010, y: 626, s: 'Runter überspringt die Chip-Zeile (nur Info) → Staffeln', w: 560 },
    { t: 'a', x1: 140, y1: 700, x2: 140, y2: 830, both: true },
    { t: 'a', x1: 180, y1: 1032, x2: 1290, y2: 1032, both: true },
    { t: 'l', x: 330, y: 1058, s: 'Fokus = Vorschau oben nach 150 ms · Select spielt · Select halten: Versionen dieser Folge', w: 870 },
    { t: 'a', d: 'M 690 736 C 690 672, 960 684, 960 616 L 960 566 C 960 544, 930 538, 890 538 L 396 538', back: true },
    { t: 'l', x: 720, y: 698, s: 'Zurück (Android TV): Streifen → Fortsetzen → Seite verlassen', back: true, w: 600 },
  ]);
  F.fmap = tv('D2-focus-map', seriesPage({ focus: 0, extra: map }), 'TV-Fokuskarte (Android TV und Web-Tastatur): nur gerade Wege zwischen ausgerichteten Reihen, kein Sprung zu weit entfernten Elementen.');
  F.atv = tv('D2-apple-tv', seriesPage({ mode: 'atv', focus: -1, cardState: { 2: { marked: true, focus: true } } }), 'Apple TV (tvOS 27): dieselbe Seite unter der nativen Tab-Leiste; Fokus nur über Geometrie und autoFocus-Guides.');
}

// iPad / web / tablet
F.ipadL = frame('D2-ipad-landscape', 1366, 1024, 0.72, seriesPage({ W: 1897, H: 1422, mode: 'ipad', focus: -1, cardState: { 2: { marked: true, playOverlay: true } } }), 'iPad Pro 13 quer: gleiche Seite, mehr Bildfläche oben; Tippen wählt eine Folge, ▶ auf der markierten Karte spielt sie. Zurück-Button oben links (F6).');
F.ipadP = frame('D2-ipad-portrait', 1024, 1366, 0.7, seriesPage({ W: 1463, H: 1951, mode: 'ipad', cls: 'portrait', focus: -1, ovLines: 4, cardState: { 2: { marked: true, playOverlay: true } } }), 'iPad hochkant: Serieninfo rückt unter die Buttons, der Streifen bleibt unten, das Bild bekommt die obere Hälfte.');
F.ipadW = frame('D2-ipad-window', 980, 760, 0.7, seriesPage({ W: 1400, H: 1086, mode: 'ipadwin', cls: 'narrow', focus: -1, noInfo: true, actions: [['resume'], ['versions', ' · 3'], ['info'], ['watched']], cardState: { 2: { marked: true, playOverlay: true } } }), 'iPad-Fenster (Stage Manager, 980 × 760): Fenstersteuerung freigehalten, rechte Spalte entfällt, „Mehr zur Serie“ wird ein Button.');
F.web1280 = frame('D2-web-1280', 1280, 800, 0.6667, seriesPage({ W: 1920, H: 1200, mode: 'web', focus: -1, cardState: { 2: { marked: true }, 3: { hover: true, playOverlay: true } }, extra: cursor(1010, 940) }), 'Web 1280 × 800: Hover auf Folge 3 zeigt ▶ (Klick auf ▶ spielt, Klick auf die Karte wählt aus); die markierte Folge 2 bleibt markiert.');
F.web1920 = tv('D2-web-1920', moviePage('sintel', { mode: 'web', actions: [['resume'], ['restart'], ['versions', ' · 3'], ['watched']], prog: [28, 'Noch 11 Min.'], focus: -1, hover: 2, extra: cursor(790, 950) }), 'Web 1920 × 1080: Hover auf „Versionen“ (Taste V öffnet das Sheet), Tastaturfokus wie TV-Fokus (:focus-visible).');
F.square = frame('D2-tablet-square', 1180, 1080, 0.66, seriesPage({ W: 1788, H: 1636, mode: 'ipad', cls: 'square', focus: -1, cardState: { 2: { marked: true, playOverlay: true } } }), 'Fast quadratisch (Tablet im geteilten Bildschirm, 1180 × 1080): alles hängt unten, der zusätzliche Platz geht ans Bild.');

// Loading / error
F.loading = tv('D2-loading', scr(ser({ W: 1920, H: 1080, mode: 'tv', cls: 'series loading' }), `<div class="amb plain"></div>${rail()}
  <div class="copy series" style="bottom:${G.copyB}px"><div class="sk" style="width:330px;height:60px"></div><div class="sk pill" style="width:240px;height:34px;margin-top:22px"></div><div class="sk" style="width:560px;height:52px;margin-top:16px"></div><div class="sk" style="width:420px;height:26px;margin-top:16px"></div><div class="sk" style="width:780px;height:22px;margin-top:22px"></div><div class="sk" style="width:740px;height:22px;margin-top:12px"></div><div class="sk" style="width:520px;height:22px;margin-top:12px"></div>
  ${actions([['resume'], ['versions'], ['watched']], 0).replace('class="actions"', 'class="actions skel"')}${vrow(CH.sherE2, { state: 'loading' })}</div>
  <aside class="info" style="bottom:${G.copyB + VB}px"><div class="sk" style="width:160px;height:20px"></div><div class="sk" style="width:100%;height:18px;margin-top:18px"></div><div class="sk" style="width:90%;height:18px;margin-top:10px"></div><div class="sk" style="width:70%;height:18px;margin-top:10px"></div><div class="sk" style="width:60%;height:18px;margin-top:22px"></div></aside>
  <div class="seasons" style="bottom:${G.seasonsB}px">${[1, 2, 3].map(() => '<span class="sk pill" style="width:150px;height:44px"></span>').join('')}</div>
  <div class="strip" style="bottom:${G.strip}px">${[1, 2, 3, 4, 5].map(() => '<div class="ecard"><div class="still sk"></div><div class="ecap"><div class="sk" style="width:240px;height:22px"></div><div class="sk" style="width:110px;height:18px;margin-top:10px"></div></div></div>').join('')}</div>`),
  'Laden: Skelett in der endgültigen Geometrie (kein Springen), Hintergrund ist die Ambient-Farbe aus dem Katalog-Eintrag, Fokus liegt sofort auf „Abspielen“.');
F.error = tv('D2-error', scr(ser({ W: 1920, H: 1080, mode: 'tv', cls: 'series' }), `${art('sherlock', 'ser')}${rail()}
  ${seriesCopy(E(1, 2), { bottom: G.copyB, actions: [['resume'], ['restart'], ['versions', ' · 3'], ['watched']], focus: -1, state: { next: true, prog: [62, 'Noch 34 Min.'] } })}
  ${seriesInfo({ bottom: G.copyB + VB })}
  ${seasons(2, { bottom: G.seasonsB, count: '' })}
  <div class="serr" style="bottom:${G.strip + 40}px"><div class="eic">${ic('wifi', 40)}</div><div><b>Staffel 2 konnte nicht geladen werden</b><span>Der Server antwortet gerade nicht. Die übrige Seite bleibt nutzbar.</span></div><div class="btn f">${ic('restart', 24)}<span>Erneut versuchen</span></div></div>`),
  'Fehler: nur der betroffene Teil (hier die Staffel) zeigt den Fehler mit „Erneut versuchen“ im Fokus; scheitert die ganze Seite, bleibt die heutige Fehlerseite.');

// Phone
F.phone = frame('D2-phone', 390, 844, 1, `<div class="scr m-phone phone" style="width:390px;height:844px;--tint:#5d8aa8;--tint2:#1a2a36">
  <div class="amb" style="background-image:var(--sherlock-bd)"></div><div class="ph-hero" style="background-image:var(--sherlock-bd)"></div>
  <div class="ph-status"><span>12:04</span><span>●●● ▮</span></div><div class="ph-back">${ic('back', 22)}</div>
  <div class="ph-body"><div class="logo" style="background-image:var(--sherlock-logo);height:40px;width:230px"></div>
  <div class="meta"><span>2010</span><span>3 Staffeln</span><span class="fsk">12</span></div>
  <div class="btn pri wide">${ic('play', 22)}<span>S1 · F2 fortsetzen</span></div>
  <div class="ph-ver"><div><small>VERSION</small><b>1080p · BluRay</b><span><em class="mp m-remux">Direkt-Stream</em> H.264 · DD 5.1</span></div><span>3 ›</span></div>
  <div class="ph-seasons"><span class="on">Staffel 1</span><span>Staffel 2</span><span>Staffel 3</span></div>
  ${[1, 2, 3].map(n => { const e = E(1, n); return `<div class="ph-ep"><div class="still" style="background-image:var(--sh-1${n})">${n === 2 ? '<span class="sprog"><u style="width:62%"></u></span>' : ''}</div><div><b>${n}. ${e.t}</b><span>${e.min} Min.${n === 1 ? ' · Gesehen' : ''}</span></div></div>`; }).join('')}
  </div><div class="ph-tabs"><span>${ic('home', 22)}</span><span>${ic('search', 22)}</span><span>${ic('film', 22)}</span><span class="on">${ic('tv', 22)}</span></div></div>`, 'Telefon: bleibt wie heute (kompakte Liste, Versionszeile, Sheet). Kein Teil von F7.');

// ---------- D2b: version chip row ----------
const tall = (id, h, html, cap) => frame(id, 1920, h, 1, html, cap);
F.b_direct = tv('D2b-movie-direct', moviePage('bunny', { focus: 0 }), 'Film · Abspielen, empfohlene Version läuft direkt (Android TV): grüner Chip „Direkt“, dann 1080P · H.264 · AAC 2.0 · WEB-DL · 360 MB. Die Zeile darunter ersetzt die alte Technikzeile: „4K · HDR10 vorhanden, läuft hier nur transkodiert“.');
F.b_trans = tv('D2b-movie-transcode', moviePage('tears', { mode: 'atv', actions: [['play'], ['versions', ' · 2'], ['watched']], focus: 0 }), 'Film · Apple TV (Simulator-Profil ohne HDR/HEVC): die empfohlene Version muss transkodiert werden. Gelber Chip „Transkodiert“, darunter die zwei Gründe in Klartext „HDR10 → SDR · HEVC → H.264“; die Chips beschreiben die Datei, die Gründe, was daraus wird.');
F.b_resume = tv('D2b-movie-resume-other-version', moviePage('bunny', { actions: [['resume', ' · 1:36'], ['restart'], ['versions', ' · 3'], ['watched']], prog: [20, 'Noch 6 Min.'], vr: CH.bunnyBr, vro: { last: true, hint: 'Direkt möglich: <b>1080p WEB-DL</b> in „Versionen“' } }), 'Fortsetzen mit der zuletzt gespielten Version (BluRay, Direkt-Stream), nicht mit der empfohlenen. Marker „Zuletzt gespielt“ am Ende der Zeile; die Grund-Zeile nennt in einem Satzteil, dass eine bessere Version direkt laufen würde. Keine zweite Chip-Zeile.');
F.b_strip = tv('D2b-series-strip-chips', seriesPage({ ep: E(1, 3), state: {}, actions: [['play'], ['versions', ' · 2'], ['watched']], focus: -1, cardState: { 2: {}, 3: { marked: true, focus: true } }, count: 'Folge 3 von 3', vr: CH.sherE3 }), 'Serie · Folge 3 im Streifen gewählt: die Chips zeigen die Version, die „Abspielen“ für diese Folge startet (WEB-DL, direkt). Bei Folge 2 stand dort „Direkt-Stream“ mit BluRay.');
{
  const crop = page => `<div class="sbcrop"><div style="position:absolute;left:-59px;top:-35px;transform:scale(.4929);transform-origin:0 0">${page}</div></div>`;
  const p1 = seriesPage({ focus: -1, cardState: { 2: { marked: true, focus: true } } });
  const p2 = seriesPage({ ep: E(1, 3), state: {}, actions: [['play'], ['versions'], ['watched']], focus: -1, cardState: { 2: {}, 3: { marked: true, focus: true } }, count: 'Folge 3 von 3', vro: { state: 'loading' } });
  const p3 = seriesPage({ ep: E(1, 3), state: {}, actions: [['play'], ['versions', ' · 2'], ['watched']], focus: -1, cardState: { 2: {}, 3: { marked: true, focus: true } }, count: 'Folge 3 von 3', vr: CH.sherE3 });
  const route = ok => `<div class="route">Route&nbsp;&nbsp; /series/tmdb-tv-19885<br>Verlauf ${ok ? '<span class="ok">unverändert · 2 Einträge</span>' : '2 Einträge (Start → Serie)'}<br>Events&nbsp; ${ok ? '<span class="ok">keine (nur State)</span>' : '–'}</div>`;
  const arrow = l => `<div class="sbarrow">${ic('right', 54)}<span>${l}</span></div>`;
  F.b_seq = tall('D2b-series-switch-sequence', 1240, `<div class="sb" style="width:1920px;height:1240px"><h2>Folge wechseln ist Zustand, keine Navigation</h2><div class="sub">Die gewählte Folge (und Staffel) ist lokaler Zustand der Seite. Text, Buttons, Chips und Markierung ändern sich an Ort und Stelle; Route, Verlauf und Fokus-Historie bleiben, wie sie sind. Zurück verlässt die Seite.</div>
  <div class="sbrow">
  <div class="sbp">${crop(p1)}<b><em>1</em>Folge 2 markiert</b><p>Fortsetzen · Direkt-Stream (BluRay, Ton wird umgewandelt).</p>${route(false)}</div>${arrow('Rechts')}
  <div class="sbp">${crop(p2)}<b><em>2</em>Fokus auf Folge 3 · nach 150 ms</b><p>Titel, Text und „Abspielen“ wechseln sofort aus den Folgendaten; die Chips laden als Skelett gleicher Breite.</p>${route(true)}</div>${arrow('Daten da')}
  <div class="sbp">${crop(p3)}<b><em>3</em>Versionen von Folge 3 geladen</b><p>„Direkt“ · WEB-DL, „Versionen · 2“. Gleiche Seite, kein Übergang, nichts springt.</p>${route(true)}</div></div>
  <div class="sbfoot"><div class="no"><b>Nie bei Folgen- oder Staffelwechsel</b><code>router.push / replace / setParams / navigate</code>, Web-History-Eintrag, URL-Hash, Seitenübergang, Remount der Seite, Fokus-Reset.</div>
  <div class="yes"><b>Erlaubt</b>setState der Auswahl, Debounce 150 ms, Cross-Fade von Text und Chips an Ort und Stelle, Versionen der Folge nachladen (Cache 5 min).</div>
  <div><b>Zurück / Menu</b>Android TV: Streifen → Hauptbutton → Seite verlassen. Apple TV: verlässt die Seite. Web: Browser-Zurück verlässt die Seite (es gibt keinen Eintrag pro Folge).</div></div></div>`, 'Storyboard · Folge wechseln ohne Navigation (Android TV): 1 → 2 → 3 auf derselben Seite. Die Kästen darunter zeigen Route und Verlauf: sie ändern sich nicht. 1920 × 1240.');
}
{
  const rows = [
    ['Direkt', 'empfohlen, läuft unverändert', CH.bunnyWeb, {}, 'predictedMethod = direct · specGap → Hinweis'],
    ['Direkt-Stream', 'Ton wird umgewandelt', CH.bunnyBr, {}, 'remux + Grund audio_converted'],
    ['Direkt-Stream', 'nur umverpackt (leise)', CH.sintelRemuxQuiet, {}, 'remux, nur container_unsupported → keine Grund-Zeile'],
    ['Transkodiert', 'ein Grund', { ...CH.sintelHdr, why: ['HDR10 → SDR'] }, {}, 'transcode + hdr_unsupported'],
    ['Transkodiert', 'zwei Gründe (Maximum)', CH.tears4k, {}, 'transcode + hdr_unsupported, video_codec_unsupported'],
    ['Mit VLC', 'eingebauter Player kann nicht', CH.sintelAv1, {}, 'vlc + vlc_fallback (nur mit vlcAvailable)'],
    ['Fortsetzen', 'andere Version als empfohlen', CH.bunnyBr, { last: true, hint: 'Direkt möglich: <b>1080p WEB-DL</b>' }, 'watch.lastReleaseId ∈ versions ≠ recommended'],
    ['Lädt', 'Versionen der Folge kommen', null, { state: 'loading' }, 'useVersions pending: Skelett, gleiche Höhe'],
    ['Ungeprüft', 'noch kein Geräteprofil', CH.unknown, {}, 'predictedMethod = unknown'],
    ['Keine Version', '', null, { state: 'none' }, 'versions = [] / versionCount = 0'],
    ['Fehler', 'Versionen nicht geladen', null, { state: 'error' }, 'useVersions error, Play bleibt möglich'],
  ];
  F.b_states = tall('D2b-chip-states', 1300, `<div class="board3" style="width:1920px;height:1300px"><h2>Chip-Zeile · alle Zustände</h2><div class="sub">TV-Größe 1:1 (1920 × 1080 logische pt). Methode zuerst und am stärksten, dann Auflösung · HDR · Video · Ton · Quelle · Größe. Nicht fokussierbar.</div>
  <div class="cs">${rows.map(([a, b, c, o, src]) => `<div class="lab"><b>${a}</b><span>${b}</span></div><div>${vrow(c || CH.bunnyWeb, o)}</div><div class="src">${src}</div>`).join('')}</div></div>`, 'Board · jeder Zustand der Chip-Zeile in TV-Größe, rechts die Datenquelle. Lädt/Fehler/Keine Version behalten die Höhe, nichts springt beim Folgenwechsel. 1920 × 1300.');
}
{
  const ws = [[1240, 'Platz genug (Referenz)'], [880, 'Bühne: TV, iPad, Web (Copy-Spalte 880 pt, alle Fenster ab 980 pt)'], [760, 'Rest neben „Zuletzt gespielt“ (Marker ≈ 220 pt)'], [640, 'sehr knapp: Größe, Quelle und Tonformat sind weg'], [560, 'Minimum: Methode, Auflösung, HDR, Kanäle']];
  F.b_fit = tv('D2b-chip-fit', `<div class="board3" style="width:1920px;height:1080px"><h2>Was zuerst wegfällt</h2><div class="sub">Die Zeile bricht nie um. Reicht der Platz nicht, entfällt in dieser Reihenfolge: ① Größe ② Quelle ③ Tonformat (Kanäle bleiben) ④ Video-Codec. Methode, Auflösung und HDR bleiben immer.</div>
  <div style="display:flex;flex-direction:column;gap:22px;margin-top:40px">${ws.map(([w, l]) => `<div><div style="font:600 19px Figtree;color:rgba(255,255,255,.75);margin-bottom:8px"><span style="font:600 17px 'JetBrains Mono';color:#FFD166;margin-right:14px">${w} pt</span>${l}</div><div class="fitw" style="width:${w}px">${vrow(CH.tearsDv, { maxW: w })}</div></div>`).join('')}</div></div>`, 'Board · Breiten-Regel mit dem längsten Fall (4K · Dolby Vision · Remux · Atmos): bei 880 pt fallen Größe und Quelle, darunter Tonformat und Codec.');
}
F.b_ipad = frame('D2b-ipad', 1366, 1024, 0.72, seriesPage({ W: 1897, H: 1422, mode: 'ipad', focus: -1, cardState: { 2: { marked: true, playOverlay: true } } }) , 'iPad Pro 13 quer: die Chip-Zeile unter den Buttons, eine Zeile in 880 pt (× 0,72 = 634 pt); Tippen auf die Zeile öffnet das Versions-Sheet an dieser Version.');
F.b_web = frame('D2b-web-1280', 1280, 800, 0.6667, moviePage('tears', { W: 1920, H: 1200, mode: 'web', focus: -1, actions: [['play'], ['versions', ' · 2'], ['watched']], vro: { hoverM: true, tip: `<div class="tip"><b>Transkodiert in diesem Browser</b><ul><li>HDR10 wird für diesen Bildschirm in SDR umgewandelt</li><li>HEVC-Video wird für dieses Gerät umgewandelt</li></ul><small>6,1 GB · ≈ 70 Mbit/s · Klick öffnet alle Versionen</small></div>` }, extra: cursor(318, 1068) }), 'Web 1280 × 800: Hover auf den Methoden-Chip zeigt die Gründe als ganze Sätze (Tooltip, auch per Tastaturfokus); Klick öffnet das Sheet. Auf dem TV gibt es keinen Tooltip, dort steht der Grund als Text in der Zeile.');

const cur = f => readFileSync(join(here, 's', f)).toString('base64');
F.__cur = { ipadSeries: cur('cur-ipad-series.jpg'), atvVersions: cur('cur-atv-versions.jpg'), gtvSintel: cur('cur-gtv-sintel.jpg'), atvNoVersion: cur('cur-atv-noversion.jpg') };
const css = readFileSync(join(here, 'styles.css'), 'utf8');
const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Streamarr · D2 · Detailseite auf großen Bildschirmen</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600&family=Outfit:wght@500;600;700;800&display=block" rel="stylesheet">
<style>:root{${vars}}</style><style>${css}</style></head><body>
${DOC(F, { ic })}
<script>
const shot=new URLSearchParams(location.search).get('shot');
if(shot){document.body.classList.add('shot');const f=document.getElementById(shot);f.classList.add('only');document.body.appendChild(f);}
function fit(){document.querySelectorAll('.frame').forEach(f=>{const w=+f.dataset.w,h=+f.dataset.h,k=+f.dataset.k,wr=f.querySelector('.fwrap'),s=f.classList.contains('only')?1:Math.min(1,wr.parentElement.clientWidth/w);wr.style.width=w*s+'px';wr.style.height=h*s+'px';f.querySelector('.fscale').style.transform='scale('+(s*k)+')';});}
addEventListener('resize',fit);fit();
</script></body></html>`;
writeFileSync(join(here, '..', '..', 'detail-concept.html'), html);
writeFileSync(join(here, 'frames.txt'), Object.entries(FR).map(([id, f]) => `${id} ${f.w} ${f.h}`).join('\n') + '\n');
console.log('bytes', Buffer.byteLength(html), 'frames', Object.keys(FR).length);
