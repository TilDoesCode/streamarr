// Mock data for the D2 frames: real Dev World titles (German metadata from the viewer API, 2026-10-02).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SH = JSON.parse(readFileSync(join(here, 'sherlock.json'), 'utf8'));

export const MOVIES = {
  bunny: {
    t: 'Big Buck Bunny', y: 2008, min: 8, g: ['Animation', 'Komödie', 'Familie'], fsk: '6', vote: '6,5', tint: '#9ccc52', tint2: '#26361a',
    ov: 'Der Hauptcharakter ist ein ungewöhnlich großes und fülliges Kaninchen („Big Buck Bunny“), das sich zu Beginn des Films an Blumen und Schmetterlingen erfreut. Als jedoch das Flughörnchen Frank, das Eichhörnchen Rinky und das Chinchilla Gamera auftauchen, zwei Schmetterlinge töten und Bunny ärgern, beschließt dieser, sich zu rächen.',
    spec: ['1080P', 'H.264', '2.0'], both: '4K · HDR10 verfügbar · spielt hier in 1080p', orig: 'Big Buck Bunny', crew: [['Regie', 'Sacha Goedegebure']],
  },
  sintel: {
    t: 'Sintel', y: 2010, min: 15, g: ['Animation', 'Fantasy'], fsk: '12', vote: '7,2', tint: '#8fb3d6', tint2: '#22303f', logo: 1,
    ov: 'Der Einstieg des Films ist der Überfall eines Drachentöters auf die durch eine verschneite Landschaft streifende, junge, weibliche Hauptfigur Sintel. Bei dem Überfall scheint sie ihrem Angreifer hoffnungslos unterlegen, kann jedoch seinen Speerattacken ausweichen und ihn mit dem Schwert besiegen.',
    spec: ['1080P', 'H.264', '5.1'], both: 'HDR10 verfügbar · spielt hier in 1080p SDR', orig: 'Sintel', crew: [['Regie', 'Colin Levy'], ['Drehbuch', 'Esther Wouda']],
  },
  cosmos: {
    t: 'Cosmos Laundromat', y: 2015, min: 12, g: ['Animation', 'Fantasy'], fsk: '12', vote: '6,9', tint: '#d99a3e', tint2: '#5a3a1c',
    ov: 'Auf einer trostlosen Insel begegnet ein selbstmörderisches Schaf namens Franck seinem Schicksal, denn es bekommt von dem mysteriösen Geschäftsmann Victor eine Maschine geschenkt, mit der es neue Abenteuer in anderen Welten erleben kann.',
    spec: ['1080P', 'H.264', '2.0'], both: '', orig: 'Cosmos Laundromat: First Cycle', crew: [['Regie', 'Mathieu Auvray']],
  },
  sprite: {
    t: 'Sprite Fright', y: 2021, min: 11, g: ['Animation', 'Horror', 'Komödie'], fsk: '12', vote: '7,0', tint: '#3fcf7a', tint2: '#0f3a26', logo: 1,
    ov: 'Großbritannien in den 80ern: Eine Gruppe randalierender Teenager wandert in einen abgelegenen Wald und entdeckt friedliche Pilzwesen, die sich als unerwartete Naturgewalt entpuppen.',
    spec: ['1080P', 'AV1', '5.1'], both: '', orig: 'Sprite Fright', crew: [['Regie', 'Matthew Luhn, Hjalti Hjalmarsson']],
  },
  tears: {
    t: 'Tears of Steel', y: 2012, min: 12, g: ['Science-Fiction'], fsk: '12', vote: '6,1', tint: '#4f86b0', tint2: '#1b2c3d', logo: 1,
    ov: 'Eine Gruppe Krieger und Wissenschaftler versammelt sich in der Oude Kerk in Amsterdam, um ein entscheidendes Ereignis der Vergangenheit nachzustellen – ein verzweifelter Versuch, die Welt vor zerstörerischen Robotern zu retten.',
    spec: ['4K', 'HEVC', 'HDR10'], both: '', orig: 'Tears of Steel', crew: [['Regie', 'Ian Hubert']],
  },
};

export const V_BUNNY = [
  { t: '1080p · WEB-DL', spec: ['H.264', 'AAC 2.0'], facts: '360 MB · ≈ 6 Mbit/s · 400 Tage alt', health: 4, local: 'Sofort', m: 'direct', why: ['Läuft unverändert auf diesem Gerät.'], rel: 'Big.Buck.Bunny.2008.1080p.WEB-DL.AAC2.0.H.264-DEVWORLD', badges: ['Empfohlen'] },
  { t: '1080p · BluRay', spec: ['H.264', 'DD+ 5.1'], facts: '600 MB · ≈ 10 Mbit/s · 900 Tage alt', health: 4, local: '', m: 'remux', why: ['Ton wird von Dolby Digital+ in AAC umgewandelt', 'MKV-Container wird zu HLS umverpackt'], rel: 'Big.Buck.Bunny.2008.1080p.BluRay.DDP5.1.x264-DEVWORLD', badges: ['Zuletzt gespielt'] },
  { t: '4K · HDR10 · BluRay', spec: ['HEVC 10 BIT', 'HDR10', 'TRUEHD 5.1'], facts: '2,4 GB · ≈ 40 Mbit/s · 300 Tage alt', health: 2, local: 'Wird vorbereitet', m: 'transcode', why: ['HDR10 wird für diesen Bildschirm in SDR umgewandelt', '4K wird auf 1080p verkleinert'], rel: 'Big.Buck.Bunny.2008.2160p.UHD.BluRay.TrueHD.5.1.HDR10.x265-DEVWORLD', badges: [] },
];
export const V_SINTEL = [
  { t: '1080p · BluRay', spec: ['H.264', 'DD 5.1', 'DEUTSCH'], facts: '1,3 GB · ≈ 12 Mbit/s · 800 Tage alt', health: 4, local: 'Sofort', m: 'remux', why: ['Ton wird von Dolby Digital in AAC umgewandelt', 'MKV-Container wird zu HLS umverpackt'], rel: 'Sintel.2010.German.DL.1080p.BluRay.DD5.1.x264-DEVWORLD', badges: ['Empfohlen', 'Zuletzt gespielt'] },
  { t: '1080p · HDR10 · BluRay', spec: ['HEVC 10 BIT', 'HDR10', 'DTS 5.1'], facts: '840 MB · ≈ 8 Mbit/s · 1.500 Tage alt', health: 4, local: '', m: 'transcode', why: ['HDR10 wird für diesen Bildschirm in SDR umgewandelt'], rel: 'Sintel.2010.1080p.BluRay.DTS.5.1.HDR10.10bit.x265-DEVWORLD', badges: [] },
  { t: '1080p · WEB-DL', spec: ['AV1', 'OPUS 5.1'], facts: '420 MB · ≈ 4 Mbit/s · 60 Tage alt', health: 0, local: '', m: 'vlc', why: ['Der eingebaute Player kann AV1 nicht abspielen'], rel: 'Sintel.2010.1080p.WEB-DL.Opus.5.1.AV1-DEVWORLD', badges: [] },
];
export const V_SHER = [
  { t: '1080p · BluRay', spec: ['H.264', 'DD 5.1', 'DEUTSCH'], facts: '10,7 GB · ≈ 16 Mbit/s · 4 Tage alt', health: 4, local: 'Sofort', m: 'remux', why: ['Ton wird von Dolby Digital in AAC umgewandelt', 'MKV-Container wird zu HLS umverpackt'], rel: 'Sherlock.S01E02.German.DL.1080p.BluRay.DD5.1.x264-GHOST', badges: ['Empfohlen', 'Zuletzt gespielt'] },
  { t: '1080p · BluRay', spec: ['H.264', 'DD 5.1', 'DEUTSCH'], facts: '8 GB · ≈ 12 Mbit/s · 1.600 Tage alt', health: 2, local: '', m: 'remux', why: ['Ton wird von Dolby Digital in AAC umgewandelt', 'MKV-Container wird zu HLS umverpackt'], rel: 'Sherlock.S01E02.German.DL.1080p.BluRay.DD5.1.x264-DEVWORLD', badges: [] },
  { t: '720p · WEB-DL', spec: ['H.264', 'AAC 2.0'], facts: '2 GB · ≈ 3 Mbit/s · 1.200 Tage alt', health: 0, local: '', m: 'remux', why: ['MKV-Container wird zu HLS umverpackt'], rel: 'Sherlock.S01E02.720p.WEB-DL.AAC2.0.H.264-DEVWORLD', badges: [] },
];

export const METHOD = { direct: 'Direkte Wiedergabe', remux: 'Direkt-Stream', transcode: 'Transkodierung', vlc: 'Wiedergabe mit VLC' };

const MONTHS = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.'];
export const deDate = iso => { const [y, m, d] = iso.split('-').map(Number); return `${d}. ${MONTHS[m - 1]} ${y}`; };
export const ep = (s, e) => SH.eps.find(x => x.s === s && x.e === e);

// D2b: the version a button starts, as the chip row shows it (short method label, spec chips in drop order, max two reasons).
export const METHOD_SHORT = { direct: 'Direkt', remux: 'Direkt-Stream', transcode: 'Transkodiert', vlc: 'Mit VLC', unknown: 'Ungeprüft' };
export const CH = {
  bunnyWeb: { m: 'direct', res: '1080P', vc: 'H.264', au: ['AAC', '2.0'], src: 'WEB-DL', size: '360 MB', note: '4K · HDR10 vorhanden, läuft hier nur transkodiert' },
  bunnyBr: { m: 'remux', res: '1080P', vc: 'H.264', au: ['DD+', '5.1'], src: 'BLURAY', size: '600 MB', why: ['Ton wird umgewandelt (DD+ → AAC)'] },
  bunny4k: { m: 'transcode', res: '4K', hdr: 'HDR10', vc: 'HEVC 10 BIT', au: ['TRUEHD', '5.1'], src: 'BLURAY', size: '2,4 GB', why: ['HDR10 → SDR', '4K → 1080p'] },
  tears4k: { m: 'transcode', res: '4K', hdr: 'HDR10', vc: 'HEVC 10 BIT', au: ['TRUEHD', '7.1'], src: 'BLURAY', size: '6,1 GB', why: ['HDR10 → SDR', 'HEVC → H.264'] },
  tearsDv: { m: 'transcode', res: '4K', hdr: 'DOLBY VISION', vc: 'HEVC 10 BIT', au: ['TRUEHD', '7.1 ATMOS'], src: 'REMUX', size: '58 GB', why: ['Dolby Vision → SDR', '4K → 1080p'] },
  sintelBr: { m: 'remux', res: '1080P', vc: 'H.264', au: ['DD', '5.1'], src: 'BLURAY', size: '1,3 GB', why: ['Ton wird umgewandelt (DD → AAC)'] },
  sintelRemuxQuiet: { m: 'remux', res: '1080P', vc: 'H.264', au: ['AAC', '5.1'], src: 'BLURAY', size: '1,1 GB', why: [] },
  sintelAv1: { m: 'vlc', res: '1080P', vc: 'AV1', au: ['OPUS', '5.1'], src: 'WEB-DL', size: '420 MB', why: ['Eingebauter Player kann AV1 nicht'] },
  sintelHdr: { m: 'transcode', res: '1080P', hdr: 'HDR10', vc: 'HEVC 10 BIT', au: ['DTS', '5.1'], src: 'BLURAY', size: '840 MB', why: ['HDR10 → SDR', 'DTS → AAC'] },
  cosmos: { m: 'direct', res: '1080P', vc: 'H.264', au: ['AAC', '2.0'], src: 'WEB-DL', size: '410 MB' },
  sprite: { m: 'vlc', res: '1080P', vc: 'AV1', au: ['OPUS', '5.1'], src: 'WEB-DL', size: '520 MB', why: ['Eingebauter Player kann AV1 nicht'] },
  sherE2: { m: 'remux', res: '1080P', vc: 'H.264', au: ['DD', '5.1'], src: 'BLURAY', size: '10,7 GB', why: ['Ton wird umgewandelt (DD → AAC)'] },
  sherE3: { m: 'direct', res: '1080P', vc: 'H.264', au: ['AAC', '2.0'], src: 'WEB-DL', size: '2,1 GB' },
  sherE1: { m: 'direct', res: '1080P', vc: 'H.264', au: ['AAC', '2.0'], src: 'WEB-DL', size: '2,3 GB' },
  unknown: { m: 'unknown', res: '1080P', vc: 'H.264', au: ['DD+', '5.1'], src: 'WEB-DL', size: '1,6 GB', why: ['Gerät noch nicht erkannt, der Server entscheidet beim Start'] },
};
