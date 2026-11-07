#!/usr/bin/env python3
"""Live anchor-language checks on verifier port 39311; optional local catalog setup."""
import copy
import json
import os
from pathlib import Path
import sys
import adversarial as a

CATALOG = a.OUT / 'round2b-catalog.json'


def write_catalog():
    data = json.loads((a.ROOT / 'server/tests/Streamarr.DevWorld/fixtures/catalog.json').read_text())
    german = copy.deepcopy(data['variants']['mp4-h264-aac-720p'])
    german['audio'][0].update(language='ger', title='German')
    data['variants']['verify-german-mp4-720p'] = german
    show = next(t for t in data['series'] if t['key'] == 'sherlock')
    for episode in show['seasons'][1]['episodes'][:2]:
        n = episode['episodeNumber']
        episode['releases'] += [
            dict(name=f'Sherlock.S02E{n:02d}.German.720p.HDTV.AAC2.0.H.264-GERMAN', variant='verify-german-mp4-720p', grabs=100, ageDays=3),
            dict(name=f'Sherlock.S02E{n:02d}.2160p.UHD.BluRay.TrueHD.5.1.HDR10.x265-ENGLISH', variant='mkv-hevc-hdr10-truehd-2160p', grabs=100, ageDays=3),
        ]
    CATALOG.write_text(json.dumps(data, indent=2))
    print('Wrote verifier catalog', CATALOG)


def run():
    os.environ['DL_VERIFY_RESULT_FILE'] = 'round2b-live-results.json'
    token = a.login('anna')
    # Explicit device profile: the UHD fixture has TrueHD audio. This check tests
    # declared capability support, not any claim about a particular TV's hardware.
    device = copy.deepcopy(a.TV)
    device['engines'][0]['audioCodecs'].append(dict(codec='truehd'))
    base = '/api/v1/viewer/downloads'
    w1, w2, w3 = [f'tmdb-tv-19885-s02e{n:02d}' for n in (1, 2, 3)]

    def candidates(work, profile=device, languages=None):
        s, body, _ = a.call('POST', base + '/candidates', dict(workId=work, device=profile, audioLanguages=languages), token)
        assert s == 200, (s, body)
        return body['candidates']

    def name(candidate):
        return candidate['version']['name']

    def plan(anchor, languages=None, profile=device, targets=None):
        s, body, _ = a.call('POST', base + '/plan', dict(anchorWorkId=w1, anchorReleaseId=anchor['version']['releaseId'], workIds=targets or [w2], device=profile, audioLanguages=languages), token)
        assert s == 200, (s, body)
        return body['items']

    def summary(item):
        return dict(workId=item['workId'], match=item['match'], score=item['score'], pick=name(item['candidate']) if item['candidate'] else None, notes=item['notes'])

    rows = candidates(w1)
    german = next(c for c in rows if name(c).endswith('-GERMAN'))
    english = next(c for c in rows if name(c).endswith('-ENGLISH'))
    untagged = next(c for c in rows if name(c) == 'Sherlock.S02E01.720p.WEB-DL.AAC2.0.H.264-DEVWORLD')
    mixed = next(c for c in rows if not c['seasonPack'] and '.German.DL.' in name(c))
    pack = next(c for c in rows if c['seasonPack'] and '1080p' in name(c))
    for label, anchor, preference, tail in [('German anchor / English viewer', german, ['en'], '-GERMAN'), ('English anchor / German viewer', english, ['de'], '-ENGLISH')]:
        item = plan(anchor, preference)[0]
        a.check(label, item['match'] == 'same_release' and name(item['candidate']).endswith(tail) and not item['notes'], summary(item))
    for language in (['de'], ['en'], None):
        items = plan(untagged, language, targets=[w2, w3])
        a.check('Sherlock untagged anchor ' + str(language), all(i['match'] == 'same_release' and i['score'] == 100 and not i['notes'] and '.720p.WEB-DL.AAC2.0.H.264-DEVWORLD' in name(i['candidate']) for i in items), [summary(i) for i in items])
    item = plan(mixed, ['en'])[0]
    a.check('German.DL primary stays German', item['match'] == 'same_release' and '.German.DL.' in name(item['candidate']) and not item['notes'], summary(item))
    item = plan(pack, ['en'], targets=[w3])[0]
    a.check('pack anchor selects same pack as candidate', item['match'] == 'same_release' and item['candidate']['seasonPack'] and name(item['candidate']) == name(pack), summary(item))

    # The manifest names the original copy. The merged versions list selects its
    # other-indexer mirror, so the known original is deliberately absent there.
    manifest = a.call('GET', '/devworld.json')[1]
    season = next(t for t in manifest['titles'] if t['key'] == 'sherlock')['seasons'][1]
    original = next(p for p in season['seasonPacks'] if '1080p' in p['name'])
    original_id = original['releaseId']
    a.check('known copy anchor absent from merged candidate list', all(c['version']['releaseId'] != original_id for c in rows), dict(originalName=original['name']))
    original_anchor = dict(version=dict(releaseId=original_id))
    item = plan(original_anchor, ['en'], targets=[w3])[0]
    a.check('known omitted anchor still determines language', item['match'] == 'same_release' and '.German.DL.' in name(item['candidate']) and not item['notes'], summary(item))

    limited_device = copy.deepcopy(a.TV)
    limited_device['engines'][0]['audioCodecs'] = [dict(codec='aac')]
    limited_device['engines'][0]['maxAudioChannels'] = 2
    limited = candidates(w2, limited_device, ['de'])
    english_limited = next(c for c in limited if name(c).endswith('-ENGLISH'))
    a.check('English anchor language is not playable on limited device', not english_limited['offline']['playable'], english_limited['offline'])
    item = plan(english, ['de'], limited_device)[0]
    differs = [n for n in item['notes'] if n['code'] == 'language_differs']
    a.check('unplayable anchor language falls back with note', item['match'] == 'best_available' and name(item['candidate']).endswith('-GERMAN') and len(differs) == 1 and differs[0]['params'] == dict(languages='de', anchorLanguages='en'), summary(item))
    no_codec = copy.deepcopy(limited_device)
    no_codec['engines'][0]['videoCodecs'] = [dict(codec='vp9')]
    item = plan(german, ['de'], no_codec)[0]
    a.check('no downloadable candidate yields none', item['match'] == 'none' and item['candidate'] is None and any(n['code'] == 'not_offline_playable' for n in item['notes']), summary(item))

    for language, tag in [('de', 'German'), ('en', 'ENGLISH')]:
        recommended = [c for c in candidates(w1, languages=[language]) if c['recommended']]
        a.check('candidate recommendation remains viewer-language ' + language, len(recommended) == 1 and tag in name(recommended[0]) and recommended[0]['version']['recommended'], [name(c) for c in recommended])
    a.check('candidate file metadata matches the conflict fixture', german['version']['resolution'] == '720p' and english['version']['resolution'] == '2160p' and german['offline']['playable'] and english['offline']['playable'], dict(german=name(german), english=name(english)))
    print(f'{sum(r["passed"] for r in a.RESULTS)}/{len(a.RESULTS)} live language assertions passed')
    return 0 if all(r['passed'] for r in a.RESULTS) else 1


if __name__ == '__main__':
    if '--write-catalog' in sys.argv:
        write_catalog()
    else:
        sys.exit(run())
