// Unit tests for TwitchAdSolutions (vaft)
// Run: npm test   (or: node tests/test.js after npm install)
//
// The functions under test are loaded from the shipped files by tests/scripts.js — nothing is
// copied into this file — and every suite runs against both vaft.user.js and vaft-ublock-origin.js,
// so the two formats cannot drift apart unnoticed.

const { formats, findPairDifferences } = require('./scripts');

let passed = 0;
let failed = 0;
let currentFormat = '';

function report(ok, message, detail) {
    if (ok) {
        passed++;
    } else {
        failed++;
        console.error('FAIL [' + currentFormat + ']: ' + message + (detail ? ' — ' + detail : ''));
    }
}

function assert(condition, message) {
    report(!!condition, message);
}

function assertEq(actual, expected, message) {
    report(actual === expected, message, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

function assertDeepEq(actual, expected, message) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    report(a === e, message, 'expected ' + e + ', got ' + a);
}

function section(name) {
    console.log('--- [' + currentFormat + '] ' + name + ' ---');
}

// Builds a playlist whose newest segment starts at newestIso; segments are segDur seconds apart
function playlist(firstSeq, count, newestIso, segDur = 2) {
    const newest = Date.parse(newestIso);
    const lines = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:' + firstSeq, '#EXT-X-TWITCH-LIVE-SEQUENCE:' + firstSeq];
    for (let i = 0; i < count; i++) {
        lines.push('#EXT-X-PROGRAM-DATE-TIME:' + new Date(newest - (count - 1 - i) * segDur * 1000).toISOString());
        lines.push('#EXTINF:' + segDur.toFixed(3) + ',live');
        lines.push('https://example.invalid/' + (firstSeq + i) + '.ts');
    }
    return lines.join('\n');
}

// ============================================================
// Worker functions (hasAdTags, stripAdSegments, ...)
// ============================================================
function workerTests(format) {
    const W = format.loadWorker([
        'hasAdTags', 'getMatchedAdSignifiers', 'parseAttributes', 'getServerTimeFromM3u8',
        'replaceServerTimeInM3u8', 'getStreamUrlForResolution', 'stripAdSegments', 'createStreamInfo',
        'getBackupSequenceOffset', 'shiftMediaSequence', 'describeRequestUrl', 'noteUntrackedPlaylist',
        'planUntrackedAdReload', 'pruneStreamInfos', 'processM3U8'
    ]);
    const newStreamInfo = (overrides) => Object.assign(W.createStreamInfo('test', '', {}), overrides);

    section('hasAdTags');
    assert(W.hasAdTags('stitched-ad-12345.ts') === true, 'detects stitched-ad');
    assert(W.hasAdTags('#EXT-X-CUE-OUT:DURATION=30') === true, 'detects EXT-X-CUE-OUT');
    assert(W.hasAdTags('#EXT-X-DATERANGE:CLASS="twitch-stitched-ad"') === true, 'detects twitch-stitched-ad');
    assert(W.hasAdTags('#EXT-X-DATERANGE:CLASS="twitch-maf-ad"') === true, 'detects twitch-maf-ad');
    assert(W.hasAdTags('#EXT-X-DATERANGE:CLASS="twitch-stitched-mid"') === true, 'detects twitch-stitched-* via prefix');
    // Added upstream (ryanbr "adsignifiers-twitch-trigger") after the old copied tests were written
    assert(W.hasAdTags('#EXT-X-DATERANGE:CLASS="twitch-trigger"') === true, 'detects twitch-trigger');
    assert(W.hasAdTags('normal-segment-12345.ts') === false, 'clean segment returns false');
    assert(W.hasAdTags('#EXTINF:2.000,live\nhttps://video.twitch.tv/segment.ts') === false, 'normal m3u8 returns false');
    assert(W.hasAdTags('') === false, 'empty string returns false');
    // Narrowed out upstream (PR #120 false positives)
    assert(W.hasAdTags('stitched') === false, 'bare stitched is not a signifier');
    assert(W.hasAdTags('X-TV-TWITCH-AD-URL="http://example.com"') === false, 'X-TV-TWITCH-AD is not a signifier');
    assert(W.hasAdTags('#EXT-X-DATERANGE:CLASS="twitch-stream-source"') === false, 'twitch-stream-source is not a signifier');
    assert(W.hasAdTags('#EXT-X-DATERANGE:CLASS="twitch-ad-quartile"') === false, 'twitch-ad-quartile is not a signifier');
    // Marker seen in a field playlist captured during a midroll (2026-10-31)
    assert(W.hasAdTags('#EXT-X-DATERANGE:ID="stitched-ad-1793442681-20320999990",CLASS="twitch-stitched-ad",START-DATE="2026-10-31T10:31:21.988Z",DURATION=20.321') === true, 'detects the field midroll marker');

    section('getMatchedAdSignifiers');
    assertDeepEq(W.getMatchedAdSignifiers('stitched-ad with #EXT-X-CUE-OUT marker'), ['stitched-ad', 'EXT-X-CUE-OUT'], 'matches multiple signifiers');
    assertDeepEq(W.getMatchedAdSignifiers('normal content'), [], 'no matches on clean content');
    assertDeepEq(W.getMatchedAdSignifiers('#EXT-X-DATERANGE:CLASS="twitch-stitched-ad"'), ['stitched-ad', 'twitch-stitched'], 'twitch-stitched-ad matches substring and prefix');

    section('parseAttributes');
    const attrs1 = W.parseAttributes('#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.4D4028",FRAME-RATE=30.0');
    assertEq(attrs1['RESOLUTION'], '1920x1080', 'parses resolution');
    assertEq(attrs1['FRAME-RATE'], 30, 'parses frame rate as number');
    assertEq(attrs1['CODECS'], 'avc1.4D4028', 'parses quoted codecs');
    assertEq(W.parseAttributes('BANDWIDTH=6000000,RESOLUTION=1920x1080')['BANDWIDTH'], 6000000, 'parses bandwidth as number');
    assertEq(W.parseAttributes('#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=852x480,CODECS="hev1.1.6.L120",FRAME-RATE=60.0')['CODECS'], 'hev1.1.6.L120', 'parses HEVC codec');
    assert(typeof W.parseAttributes('') === 'object', 'returns object for empty string');

    section('getServerTimeFromM3u8 / replaceServerTimeInM3u8');
    W.V2API = false;
    assertEq(W.getServerTimeFromM3u8('#EXT-X-TWITCH-ELAPSED-SECS:10.5,SERVER-TIME="1234567890.123"'), '1234567890.123', 'extracts v1 server time');
    assertEq(W.getServerTimeFromM3u8('no server time here'), null, 'null when no v1 server time');
    assertEq(W.getServerTimeFromM3u8('SERVER-TIME="abc"'), null, 'null for non-numeric v1 time');
    const m3u8WithTime = '#EXT-X-TWITCH-ELAPSED-SECS:10.5,SERVER-TIME="1234567890.123"';
    assert(W.replaceServerTimeInM3u8(m3u8WithTime, '9999999999.000').includes('SERVER-TIME="9999999999.000"'), 'replaces v1 server time');
    assertEq(W.replaceServerTimeInM3u8(m3u8WithTime, null), m3u8WithTime, 'unchanged when new time is null');
    W.V2API = true;
    assertEq(W.getServerTimeFromM3u8('#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="9876543210.456"'), '9876543210.456', 'extracts v2 server time');
    assertEq(W.getServerTimeFromM3u8('#EXT-X-SESSION-DATA:DATA-ID="OTHER",VALUE="123"'), null, 'null for wrong v2 DATA-ID');
    assert(W.replaceServerTimeInM3u8('#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="1234567890.123"', '9999999999.000').includes('VALUE="9999999999.000"'), 'replaces v2 server time');
    W.V2API = false;

    section('getStreamUrlForResolution');
    const encodingsM3u8 = [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.4D4028",FRAME-RATE=30.0',
        'https://video.twitch.tv/1080p30.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.4D401F",FRAME-RATE=60.0',
        'https://video.twitch.tv/720p60.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360,CODECS="avc1.4D401E",FRAME-RATE=30.0',
        'https://video.twitch.tv/360p30.m3u8'
    ].join('\n');
    assertEq(W.getStreamUrlForResolution(encodingsM3u8, { Resolution: '1920x1080', FrameRate: 30 }), 'https://video.twitch.tv/1080p30.m3u8', 'exact resolution + frame rate');
    assertEq(W.getStreamUrlForResolution(encodingsM3u8, { Resolution: '1280x720', FrameRate: 30 }), 'https://video.twitch.tv/720p60.m3u8', 'resolution match without frame-rate match');
    assert(W.getStreamUrlForResolution(encodingsM3u8, { Resolution: '1600x900', FrameRate: 30 }) != null, 'non-exact resolution returns closest');
    assertEq(W.getStreamUrlForResolution('', { Resolution: '1920x1080', FrameRate: 30 }), null, 'null for empty playlist');

    section('stripAdSegments');
    W.AdSegmentCache = new Map();
    let info = newStreamInfo();
    let result = W.stripAdSegments(['#EXTM3U', '#EXT-X-TWITCH-PREFETCH:https://prefetch.url', '#EXTINF:2.000,stitched-ad', 'https://ad-1.ts', '#EXTINF:2.000,live', 'https://live-1.ts'].join('\n'), false, info);
    assertEq(info.NumStrippedAdSegments, 1, 'counts stripped ad segment');
    assert(info.IsStrippingAdSegments === true, 'marks as stripping');
    assert(W.AdSegmentCache.has('https://ad-1.ts'), 'caches ad segment URL');
    assert(!result.includes('https://prefetch.url'), 'removes prefetch URLs during ads');

    W.AdSegmentCache = new Map();
    info = newStreamInfo({ NumStrippedAdSegments: 5 });
    W.stripAdSegments(['#EXTM3U', '#EXTINF:2.000,live', 'https://live-1.ts', '#EXTINF:2.000,live', 'https://live-2.ts'].join('\n'), false, info);
    assertEq(info.NumStrippedAdSegments, 0, 'resets stripped count on clean playlist');
    assert(info.IsStrippingAdSegments === false, 'not stripping on clean playlist');

    W.AdSegmentCache = new Map();
    W.stripAdSegments(['#EXTM3U', '#EXT-X-CUE-OUT:DURATION=30', '#EXTINF:2.000,live', 'https://cue-out.ts', '#EXT-X-CUE-IN', '#EXTINF:2.000,live', 'https://normal.ts'].join('\n'), false, newStreamInfo());
    assert(W.AdSegmentCache.has('https://cue-out.ts'), 'strips segment inside CUE-OUT');
    assert(!W.AdSegmentCache.has('https://normal.ts'), 'keeps segment after CUE-IN');

    W.AdSegmentCache = new Map();
    W.stripAdSegments(['#EXTM3U', '#EXTINF:2.000,live', 'https://cdn.twitch.tv/adsquared/ad.ts', '#EXTINF:2.000,live', 'https://cdn.twitch.tv/_404/x.ts', '#EXTINF:2.000,live', 'https://cdn.twitch.tv/processing/y.ts', '#EXTINF:2.000,live', 'https://cdn.twitch.tv/normal.ts'].join('\n'), false, newStreamInfo());
    assert(W.AdSegmentCache.has('https://cdn.twitch.tv/adsquared/ad.ts'), 'detects /adsquared/ URL pattern');
    assert(W.AdSegmentCache.has('https://cdn.twitch.tv/_404/x.ts'), 'detects /_404/ URL pattern');
    assert(W.AdSegmentCache.has('https://cdn.twitch.tv/processing/y.ts'), 'detects /processing URL pattern');
    assert(!W.AdSegmentCache.has('https://cdn.twitch.tv/normal.ts'), 'does not flag a normal URL');

    W.AdSegmentCache = new Map();
    result = W.stripAdSegments(['#EXTM3U', '#EXTINF:2.000,stitched-ad', 'https://ad.ts', 'X-TV-TWITCH-AD-URL="https://tracking.example.com"', 'X-TV-TWITCH-AD-CLICK-TRACKING-URL="https://click.example.com"', 'X-TV-TWITCH-AD-IMPRESSION-URLS="https://imp.example.com"', 'X-TV-TWITCH-AD-COMMERCIAL-ID="abc123"'].join('\n'), false, newStreamInfo());
    assert(result.includes('X-TV-TWITCH-AD-URL="https://twitch.tv"'), 'replaces ad URL');
    assert(result.includes('X-TV-TWITCH-AD-CLICK-TRACKING-URL="https://twitch.tv"'), 'replaces click tracking URL');
    assert(result.includes('X-TV-TWITCH-AD-IMPRESSION-URLS="https://twitch.tv"'), 'replaces impression URLS');
    assert(result.includes('X-TV-TWITCH-AD-COMMERCIAL-ID="abc123"'), 'keeps non-URL attributes');

    W.AdSegmentCache = new Map();
    W.stripAdSegments(['#EXTM3U', '#EXTINF:2.000,live', 'https://live.ts'].join('\n'), true, newStreamInfo());
    assert(W.AdSegmentCache.has('https://live.ts'), 'stripAllSegments strips live segments');

    W.AdSegmentCache = new Map();
    const dupe = ['#EXTM3U', '#EXTINF:2.000,stitched-ad', 'https://same-ad.ts'].join('\n');
    info = newStreamInfo();
    W.stripAdSegments(dupe, false, info);
    assertEq(info.NumStrippedAdSegments, 1, 'first strip counts the segment');
    const info2 = newStreamInfo();
    W.stripAdSegments(dupe, false, info2);
    assertEq(info2.NumStrippedAdSegments, 0, 'already cached segment is not counted again');

    // Fork: AlignBackupSequence (68.8.0) — offsets from field logs (backup/native ranges and newest PDTs)
    section('getBackupSequenceOffset / shiftMediaSequence');
    const cases = [
        // [label, backup first, count, newest, native first, count, newest, expected offset]
        ['15:25 stall (backup numbered 11 lower)', 10630, 14, '2026-10-31T14:25:20.188Z', 10640, 15, '2026-10-31T14:25:21.631Z', 11],
        ['15:43 stall (backup numbered 14 lower)', 11169, 14, '2026-10-31T14:43:18.188Z', 11182, 15, '2026-10-31T14:43:18.279Z', 14],
        ['14:31 smooth (identical numbering)', 9009, 14, '2026-10-31T13:31:18.188Z', 9009, 14, '2026-10-31T13:31:18.188Z', 0],
        ['11:25 smooth (backup newest +1.9s)', 1443, 14, '2026-11-01T10:25:49.611Z', 1441, 15, '2026-11-01T10:25:47.694Z', 0],
        ['papaplatte preroll (native just started)', 957, 14, '2026-11-02T10:46:51.548Z', 0, 3, '2026-11-02T10:46:51.551Z', -968]
    ];
    for (const [label, bFirst, bCount, bNewest, nFirst, nCount, nNewest, expected] of cases) {
        const r = W.getBackupSequenceOffset(playlist(nFirst, nCount, nNewest), playlist(bFirst, bCount, bNewest));
        assertEq(r.offset, expected, label);
        if (expected !== 0) {
            // After the shift the backup's newest segment is numbered within one segment of native's newest
            assert(Math.abs((r.backupInfo.last + r.offset) - r.nativeInfo.last) <= 1, label + ': newest numbers aligned');
        }
    }
    assertEq(W.getBackupSequenceOffset('#EXTM3U\n#EXTINF:2.000,live\nx.ts', playlist(5, 3, '2026-11-01T00:00:00Z')).offset, 0, 'missing sequence/PDT gives offset 0');
    const shifted = W.shiftMediaSequence(playlist(10630, 2, '2026-10-31T14:25:20.188Z'), 11);
    assert(shifted.includes('#EXT-X-MEDIA-SEQUENCE:10641'), 'shifts MEDIA-SEQUENCE');
    assert(shifted.includes('#EXT-X-TWITCH-LIVE-SEQUENCE:10641'), 'shifts TWITCH-LIVE-SEQUENCE');
    const unshifted = playlist(5, 2, '2026-11-01T00:00:00Z');
    assertEq(W.shiftMediaSequence(unshifted, 0), unshifted, 'offset 0 leaves the playlist unchanged');
    assert(W.shiftMediaSequence(playlist(1000, 2, '2026-11-01T00:00:00Z'), -968).includes('#EXT-X-MEDIA-SEQUENCE:32'), 'negative offset shifts down');
    // Preroll (field 21:18: backup 13..26, native 0..2, offset -24): no sequence number below 0
    const prerollBackup = playlist(13, 14, '2026-11-08T20:18:53.384Z');
    const trimmed = W.shiftMediaSequence(prerollBackup, -24);
    assert(trimmed.includes('#EXT-X-MEDIA-SEQUENCE:0\n') && trimmed.includes('#EXT-X-TWITCH-LIVE-SEQUENCE:0\n'), 'a shift below 0 is numbered from 0');
    assert(!/SEQUENCE:-/.test(trimmed), 'never emits a negative sequence number');
    assertEq((trimmed.match(/#EXTINF/g) || []).length, 3, 'keeps exactly the segments that line up with native 0..2');
    assertEq((trimmed.match(/#EXT-X-PROGRAM-DATE-TIME/g) || []).length, 3, 'drops the PROGRAM-DATE-TIME of dropped segments');
    assert(trimmed.includes('/24.ts') && trimmed.includes('/26.ts') && !trimmed.includes('/23.ts'), 'drops the oldest segments, keeps the newest');
    assert(trimmed.includes('2026-11-08T20:18:53.384Z'), 'the newest segment keeps its PROGRAM-DATE-TIME');
    const nextPoll = W.shiftMediaSequence(playlist(15, 14, '2026-11-08T20:18:57.384Z'), -24);
    assert(nextPoll.includes('#EXT-X-MEDIA-SEQUENCE:0\n') && (nextPoll.match(/#EXTINF/g) || []).length === 5, 'the next poll continues the numbering (0..4)');
    const allBelow = W.shiftMediaSequence(playlist(13, 3, '2026-11-08T20:18:53.384Z'), -100);
    assert(allBelow.includes('#EXT-X-MEDIA-SEQUENCE:0\n') && (allBelow.match(/#EXTINF/g) || []).length === 1, 'always keeps at least one segment');
    const withTags = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:2', '#EXT-X-MAP:URI="init.mp4"', '#EXT-X-DATERANGE:ID="x",CLASS="twitch-session"',
        '#EXT-X-PROGRAM-DATE-TIME:2026-11-08T20:00:00.000Z', '#EXTINF:2.000,live', 'a.mp4',
        '#EXT-X-DISCONTINUITY', '#EXT-X-PROGRAM-DATE-TIME:2026-11-08T20:00:02.000Z', '#EXTINF:2.000,live', 'b.mp4',
        '#EXT-X-DISCONTINUITY', '#EXT-X-PROGRAM-DATE-TIME:2026-11-08T20:00:04.000Z', '#EXTINF:2.000,live', 'c.mp4',
        '#EXT-X-TWITCH-PREFETCH:https://example.invalid/d.mp4'].join('\n');
    const trimmedTags = W.shiftMediaSequence(withTags, -4);
    assert(trimmedTags.includes('#EXT-X-MAP:URI="init.mp4"') && trimmedTags.includes('twitch-session') && trimmedTags.includes('#EXT-X-TWITCH-PREFETCH'), 'header, MAP, DATERANGE and prefetch tags survive the trim');
    assert(!trimmedTags.includes('a.mp4') && !trimmedTags.includes('b.mp4') && trimmedTags.includes('c.mp4'), 'drops whole segments');
    assert(trimmedTags.includes('#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-DISCONTINUITY-SEQUENCE:1\n'), 'a dropped discontinuity is counted into DISCONTINUITY-SEQUENCE');
    assertEq((trimmedTags.match(/#EXT-X-DISCONTINUITY\n/g) || []).length, 1, 'the discontinuity before the first kept segment stays');

    // Fork: ad watchdog (68.10.0)
    section('describeRequestUrl');
    assertEq(W.describeRequestUrl('https://edge.ads.twitch.tv/ads?bp=midroll&token=secret'), 'edge.ads.twitch.tv/ads', 'drops the query (tokens)');
    assertEq(W.describeRequestUrl('https://example.invalid/a#frag'), 'example.invalid/a', 'drops the fragment');
    const longPath = W.describeRequestUrl('https://video-edge.example/v1/segment/' + 'x'.repeat(200) + '.ts');
    assert(longPath.length <= 'video-edge.example'.length + 61 && longPath.endsWith('…'), 'cuts long paths to 60 chars');
    assertEq(W.describeRequestUrl('blob:https://www.twitch.tv/1234'), null, 'blob: URLs are not requests');
    assertEq(W.describeRequestUrl('not a url'), null, 'relative/invalid input gives null');
    assertEq(W.describeRequestUrl(undefined), null, 'undefined gives null');
    assert(Array.isArray(W.RecentWorkerRequests) && W.RecentWorkerRequests.length === 0, 'declareOptions creates the worker request ring buffer');

    // Fork: untracked-playlist diagnostic (68.10.1)
    section('noteUntrackedPlaylist');
    const cleanList = playlist(100, 3, '2026-11-09T00:00:00Z');
    const adList = cleanList.replace('#EXTINF', '#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad"\n#EXTINF');
    const t0 = 1000000;
    assertEq(W.noteUntrackedPlaylist('https://v.example/a.m3u8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nx.m3u8', t0), null, 'master playlists are ignored');
    assertEq(W.noteUntrackedPlaylist('https://v.example/vod.m3u8', '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:10.000,\n0.ts', t0), null, 'VOD playlists are ignored');
    assertEq(W.noteUntrackedPlaylist('https://v.example/ended.m3u8', cleanList + '\n#EXT-X-ENDLIST', t0), null, 'ended playlists are ignored');
    assertEq(Object.keys(W.UntrackedPlaylists).length, 0, 'ignored playlists do not use up the URL cap');
    const first = W.noteUntrackedPlaylist('https://v.example/a.m3u8?token=secret', cleanList, t0);
    assert(first && first.includes('Untracked media playlist — v.example/a.m3u8') && first.includes('ad markers: none'), 'first sighting of an untracked media playlist is logged');
    assert(!first.includes('secret'), 'no query string in the log');
    assertEq(W.noteUntrackedPlaylist('https://v.example/a.m3u8', cleanList, t0 + 2000), null, 'repeat polls without ads stay quiet');
    const adLine = W.noteUntrackedPlaylist('https://v.example/a.m3u8', adList, t0 + 4000);
    assert(adLine && adLine.includes('carries ads (NOT BLOCKED)') && adLine.includes('stitched-ad'), 'ads in a known untracked playlist are reported');
    assertEq(W.noteUntrackedPlaylist('https://v.example/a.m3u8', adList, t0 + 6000), null, 'ad reports are rate-limited to 30s');
    assert(W.noteUntrackedPlaylist('https://v.example/a.m3u8', adList, t0 + 35000) !== null, 'and repeat after 30s');
    const firstWithAds = W.noteUntrackedPlaylist('https://v.example/b.m3u8', adList, t0);
    assert(firstWithAds.includes('(ADS NOT BLOCKED)'), 'a first sighting with ads says so');
    for (const name of ['c', 'd', 'e']) W.noteUntrackedPlaylist('https://v.example/' + name + '.m3u8', cleanList, t0);
    assertEq(W.noteUntrackedPlaylist('https://v.example/f.m3u8', cleanList, t0), null, 'at most 5 distinct URLs are logged');
    assert(W.noteUntrackedPlaylist('https://v.example/g.m3u8', adList, t0) !== null, 'over the cap, ads are still reported');
    assertEq(W.noteUntrackedPlaylist('https://v.example/h.m3u8', adList, t0 + 1000), null, 'over the cap, one ad report per 30s overall');

    // Fork: player reload when an untracked playlist carries ads (68.11.0)
    section('planUntrackedAdReload');
    assertEq(W.planUntrackedAdReload(cleanList, t0), null, 'no ad markers: nothing to do');
    assertEq(W.planUntrackedAdReload('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nx.m3u8', t0), null, 'master playlists are ignored');
    assertEq(W.planUntrackedAdReload(adList + '\n#EXT-X-ENDLIST', t0), null, 'ended/VOD playlists are ignored');
    const firstReload = W.planUntrackedAdReload(adList, t0);
    assert(firstReload && firstReload.reload === true && firstReload.log.includes('(1/2 in 10 minutes)'), 'ads in an untracked live playlist ask for a player reload');
    assertEq(W.planUntrackedAdReload(adList, t0 + 2000), null, 'the next polls within 30s do not ask again');
    const secondReload = W.planUntrackedAdReload(adList, t0 + 31000);
    assert(secondReload && secondReload.reload === true && secondReload.log.includes('(2/2'), 'a second reload is allowed after 30s');
    const gaveUp = W.planUntrackedAdReload(adList, t0 + 62000);
    assert(gaveUp && gaveUp.reload === false && gaveUp.log.includes('giving up'), 'after two reloads in 10 minutes it gives up and says so');
    assertEq(W.planUntrackedAdReload(adList, t0 + 93000), null, 'the giving-up line is logged once, not on every poll');
    const afterWindow = W.planUntrackedAdReload(adList, t0 + 31000 + 600001);
    assert(afterWindow && afterWindow.reload === true && afterWindow.log.includes('(1/2'), 'the budget is back once the reloads are older than 10 minutes');
    W.UntrackedReload = false;
    W.UntrackedAdReloads.length = 0;
    assertEq(W.planUntrackedAdReload(adList, t0), null, 'opt-out disables the reload');
    W.UntrackedReload = true;
    // processM3U8 itself: an unknown playlist with ads is passed through and the worker asks for the reload.
    // The untracked branch has no await, so its effects are visible right after the call.
    const workerMessages = [];
    W.postMessage = (message) => workerMessages.push(message);
    W.processM3U8('https://v.example/unknown-with-ads.m3u8', adList, null);
    assertDeepEq(workerMessages, [{ key: 'ReloadPlayer', kind: 'untracked-ads' }], 'processM3U8 posts ReloadPlayer (untracked-ads) for an unknown playlist with ads');
    W.processM3U8('https://v.example/unknown-with-ads.m3u8', adList, null);
    assertEq(workerMessages.length, 1, 'and does not repeat it on the next poll');
    workerMessages.length = 0;
    W.UntrackedAdReloads.length = 0;
    W.processM3U8('https://v.example/unknown-clean.m3u8', cleanList, null);
    assertEq(workerMessages.length, 0, 'an unknown playlist without ads triggers no reload');

    // Fork: a paused player keeps its stream registered (68.11.0)
    section('pruneStreamInfos');
    const maxAge = W.StreamInfoMaxAgeMs;
    const addStream = (name, seenAgoMs) => {
        const info = W.createStreamInfo(name, '', {});
        info.LastSeenAt = Date.now() - seenAgoMs;
        info.Urls['https://v.example/' + name + '.m3u8'] = {};
        W.StreamInfos[name] = info;
        W.StreamInfosByUrl['https://v.example/' + name + '.m3u8'] = info;
        return info;
    };
    const tracked = () => Object.keys(W.StreamInfosByUrl).sort().join(',');
    for (const key of Object.keys(W.StreamInfos)) delete W.StreamInfos[key];
    for (const key of Object.keys(W.StreamInfosByUrl)) delete W.StreamInfosByUrl[key];
    addStream('paused', 3 * 60 * 60 * 1000);
    W.pruneStreamInfos();
    assertEq(tracked(), 'https://v.example/paused.m3u8', 'the only stream stays registered however long it was not polled (paused player)');
    addStream('paused2', 2 * 60 * 60 * 1000);
    W.pruneStreamInfos();
    assertEq(Object.keys(W.StreamInfos).length, 2, 'two paused streams: neither is pruned');
    addStream('watching', 1000);
    W.pruneStreamInfos();
    assertEq(Object.keys(W.StreamInfos).join(','), 'watching', 'streams left for another one are pruned once that one is being polled');
    assertEq(tracked(), 'https://v.example/watching.m3u8', 'pruning removes the variant URLs of the pruned streams only');
    addStream('recent', maxAge - 60000);
    W.pruneStreamInfos();
    assertEq(Object.keys(W.StreamInfos).sort().join(','), 'recent,watching', 'a stream polled within the window is kept');
    W.StreamInfos.broken = null;
    W.pruneStreamInfos();
    assert(!('broken' in W.StreamInfos), 'malformed entries are removed');
}

// ============================================================
// Main-thread functions
// ============================================================
function mainTests(format) {
    section('isValidWorker');
    const M = format.loadMain(['workerStringConflicts', 'workerStringReinsert', 'isValidWorker'], {});
    assert(M.isValidWorker({ toString: () => 'function Worker() { /* twitch worker */ }' }) === false, 'rejects worker with twitch conflict');
    assert(M.isValidWorker({ toString: () => 'function Worker() { isVariantA }' }) === true, 'allows TwitchNoSub reinsert pattern');
    assert(M.isValidWorker({ toString: () => 'function Worker() { besuper/ }' }) === true, 'allows besuper reinsert');
    assert(M.isValidWorker({ toString: () => 'function Worker() { /* clean */ }' }) === true, 'allows clean worker');
    assert(M.isValidWorker({ toString: () => 'function Worker() { ${patch_url} }' }) === true, 'allows ${patch_url} reinsert');

    // Fork: unhooked-worker recovery (68.6.0 / 68.9.0)
    section('checkUnhookedPlayerWorker / tryUnhookedPageReload');
    const makeUnhooked = (storage = {}) => {
        const calls = { playerTask: [], pageReloads: 0 };
        const store = (initial) => {
            const data = Object.assign({}, initial);
            return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, data };
        };
        const ctx = format.loadMain(
            ['hookedTwitchWorkers', 'unhookedWorkerState', 'MaxUnhookedWorkerReloads', 'UnhookedPageReloadKey',
                'UnhookedPageReloadMinIntervalMs', 'tryUnhookedPageReload', 'checkUnhookedPlayerWorker'],
            {
                playerBufferState: { userPauseIntent: false },
                doTwitchPlayerTask: (...args) => calls.playerTask.push(args),
                document: { hidden: false, pictureInPictureElement: null },
                location: { reload: () => { calls.pageReloads++; } },
                localStorage: store(storage.local),
                sessionStorage: store(storage.session)
            });
        const video = { isConnected: true, readyState: 4, paused: false, ended: false };
        const worker = { postMessage() {} };
        const player = { core: { worker }, getHTMLVideoElement: () => video };
        // Simulates the 5s of playback the check waits for before acting
        const tickAfterWait = () => { ctx.unhookedWorkerState.firstSeenAt = Date.now() - 6000; ctx.checkUnhookedPlayerWorker(player); };
        return { ctx, calls, video, worker, player, tickAfterWait };
    };

    let t = makeUnhooked();
    t.ctx.hookedTwitchWorkers.add(t.worker);
    t.ctx.checkUnhookedPlayerWorker(t.player);
    t.tickAfterWait();
    assertEq(t.calls.playerTask.length, 0, 'hooked worker: no recovery');

    t = makeUnhooked();
    t.ctx.checkUnhookedPlayerWorker(t.player);
    assertEq(t.calls.playerTask.length, 0, 'unhooked worker: waits before acting');
    t.tickAfterWait();
    assertDeepEq(t.calls.playerTask, [[false, true, 'worker-recovery']], 'unhooked worker: one worker-recovery player reload');
    t.tickAfterWait();
    assertEq(t.calls.pageReloads, 1, 'still unhooked after the player reload: page reload');
    assert(t.ctx.sessionStorage.data[t.ctx.UnhookedPageReloadKey], 'page reload stores its timestamp');
    t.tickAfterWait();
    assertEq(t.calls.pageReloads, 1, 'page reload happens only once per page');
    assertEq(t.calls.playerTask.length, 1, 'player reload happens only once per page');

    t = makeUnhooked({ session: { twitchAdSolutions_unhookedPageReloadAt: String(Date.now() - 60 * 1000) } });
    t.ctx.checkUnhookedPlayerWorker(t.player);
    t.tickAfterWait();
    t.tickAfterWait();
    assertEq(t.calls.pageReloads, 0, 'no page reload within 10 minutes of the last one');

    t = makeUnhooked({ local: { twitchAdSolutions_unhookedPageReload: 'false' } });
    t.ctx.checkUnhookedPlayerWorker(t.player);
    t.tickAfterWait();
    t.tickAfterWait();
    assertEq(t.calls.pageReloads, 0, 'page reload opt-out is respected');

    t = makeUnhooked();
    t.video.paused = true;
    t.ctx.checkUnhookedPlayerWorker(t.player);
    t.tickAfterWait();
    assertEq(t.calls.playerTask.length, 0, 'paused video: no recovery');

    // The worker blob is a template literal evaluated when Twitch constructs its worker: a serialized
    // function or injected option that does not exist is a ReferenceError there, which no syntax check sees.
    section('worker blob references');
    const blobSource = format.declarationSource('hookWindowWorker');
    const optionsSource = format.declarationSource('declareOptions');
    const serializedNames = [...blobSource.matchAll(/\$\{(\w+)\.toString\(\)\}/g)].map((m) => m[1]);
    assert(serializedNames.length >= 20, 'finds the functions serialized into the worker blob (' + serializedNames.length + ')');
    assertDeepEq(serializedNames.filter((name) => !format.hasDeclaration(name)), [], 'every function serialized into the worker blob is declared');
    for (const name of ['processM3U8', 'hookWorkerFetch', 'pruneStreamInfos', 'noteUntrackedPlaylist', 'planUntrackedAdReload', 'describeRequestUrl', 'shiftMediaSequence', 'getBackupSequenceOffset']) {
        assert(serializedNames.includes(name), name + ' is serialized into the worker blob');
    }
    const injectedOptions = [...blobSource.matchAll(/^\s*(\w+) = \$\{(\w+)\};/gm)];
    assert(injectedOptions.length >= 10, 'finds the options injected into the worker blob (' + injectedOptions.length + ')');
    assertDeepEq(injectedOptions.filter((m) => m[1] !== m[2] || !optionsSource.includes('scope.' + m[1] + ' = ')).map((m) => m[0].trim()), [], 'every injected option is declared in declareOptions under the same name');
    assert(injectedOptions.some((m) => m[1] === 'UntrackedReload'), 'UntrackedReload is injected into the worker blob');

    // Fork: reload kinds that replace a healthy player (68.11.0)
    section('isRecoveryReloadKind');
    const kinds = format.loadMain(['isRecoveryReloadKind'], {});
    assert(kinds.isRecoveryReloadKind('worker-recovery') && kinds.isRecoveryReloadKind('untracked-ads') && kinds.isRecoveryReloadKind('error-recovery'), 'worker-recovery, untracked-ads and error-recovery replace the player unconditionally');
    assert(!kinds.isRecoveryReloadKind('early') && !kinds.isRecoveryReloadKind('post-ad') && !kinds.isRecoveryReloadKind('codec-swap') && !kinds.isRecoveryReloadKind(undefined), 'early, post-ad, codec-swap and plain reloads keep the healthy-player check');

    // Fork: player error recovery (68.12.0). Field log: soft codec-swap reload at 12:15:51.017, player error
    // 6 ms later, Twitch shows "(Error #4000)", the 'early' reload 390 ms later is dropped (player paused).
    section('player error recovery');
    const makeErrorCtx = () => {
        const logs = [];
        const tasks = [];
        const dom = { playerText: '' };
        const ctx = format.loadMain(
            ['PlayerErrorPattern', 'playerErrorState', 'findPlayerErrorCode', 'planPlayerErrorRecovery', 'checkPlayerErrorRecovery'],
            {
                console: { log: (m) => logs.push(String(m)) },
                document: { querySelector: (selector) => selector === '[data-a-target="video-player"]' ? { textContent: dom.playerText } : null },
                playerBufferState: { lastReloadAt: 0, lastReloadDesc: '', inAdBreak: false },
                doTwitchPlayerTask: (...args) => tasks.push(args)
            });
        return { ctx, logs, tasks, dom };
    };
    let pe = makeErrorCtx();
    const errorText = 'This video is either unavailable or not supported in this browser. (Error #4000)';
    assertEq(pe.ctx.findPlayerErrorCode(), null, 'no error overlay: no code');
    pe.dom.playerText = 'LIVE 1,353 viewers';
    assertEq(pe.ctx.findPlayerErrorCode(), null, 'ordinary player text is not an error');
    pe.dom.playerText = errorText;
    assertEq(pe.ctx.findPlayerErrorCode(), '4000', 'reads the code from Twitch\'s error overlay');
    pe.dom.playerText = 'Beim Abspielen ist ein Fehler aufgetreten. (Fehler #2000)';
    assertEq(pe.ctx.findPlayerErrorCode(), '2000', 'German UI text');
    pe.dom.playerText = 'This content is not available. (Error #5000)';
    assertEq(pe.ctx.findPlayerErrorCode(), null, 'errors a reload cannot fix (#5000) are ignored');

    const p0 = 5000000;
    assertEq(pe.ctx.planPlayerErrorRecovery('4000', p0, 5000, Infinity, false), null, 'an error unrelated to vaft (no recent reload, no ad break) is left alone');
    assertEq(pe.ctx.planPlayerErrorRecovery('4000', p0, 500, 600, true), null, 'waits until the error has been up for 2s');
    const firstRecovery = pe.ctx.planPlayerErrorRecovery('4000', p0, 2500, 2500, false);
    assert(firstRecovery && firstRecovery.reload === true && firstRecovery.log.includes('#4000') && firstRecovery.log.includes('(1/2'), 'error after a vaft reload: replace the player');
    assertEq(pe.ctx.planPlayerErrorRecovery('4000', p0 + 5000, 7500, 5000, false), null, 'no second attempt within 15s');
    const secondRecovery = pe.ctx.planPlayerErrorRecovery('4000', p0 + 16000, 3000, 16000, true);
    assert(secondRecovery && secondRecovery.reload === true && secondRecovery.log.includes('(2/2'), 'a second attempt is allowed after 15s');
    const errorGaveUp = pe.ctx.planPlayerErrorRecovery('4000', p0 + 40000, 3000, 24000, true);
    assert(errorGaveUp && errorGaveUp.reload === false && errorGaveUp.log.includes('giving up'), 'after two attempts in 10 minutes it gives up and says so');
    assertEq(pe.ctx.planPlayerErrorRecovery('4000', p0 + 60000, 3000, 44000, true), null, 'the giving-up line is logged once');
    const errorAfterWindow = pe.ctx.planPlayerErrorRecovery('3000', p0 + 16000 + 600001, 3000, 100, true);
    assert(errorAfterWindow && errorAfterWindow.reload === true && errorAfterWindow.log.includes('(1/2'), 'the budget is back after 10 minutes');
    pe.ctx.playerErrorState.recoveries.length = 0;
    assert(pe.ctx.planPlayerErrorRecovery('4000', p0, 3000, Infinity, true) !== null, 'an error during an ad break is recovered even without a recent reload');
    pe.ctx.playerErrorState.recoveries.length = 0;
    pe.ctx.playerErrorState.enabled = false;
    assertEq(pe.ctx.planPlayerErrorRecovery('4000', p0, 3000, 100, true), null, 'opt-out disables the recovery');

    // The whole check, as the buffer monitor runs it
    pe = makeErrorCtx();
    pe.ctx.playerBufferState.lastReloadAt = Date.now() - 400;
    pe.ctx.playerBufferState.lastReloadDesc = 'soft, codec-swap';
    pe.ctx.playerBufferState.inAdBreak = true;
    pe.ctx.checkPlayerErrorRecovery();
    assertEq(pe.logs.length, 0, 'no error overlay: nothing logged');
    pe.dom.playerText = errorText;
    pe.ctx.checkPlayerErrorRecovery();
    assert(pe.logs.length === 1 && pe.logs[0].includes('Player error #4000 shown') && pe.logs[0].includes('(soft, codec-swap)') && pe.logs[0].includes('ad break: yes'), 'first sighting logs the error with the last reload and the break state');
    assertEq(pe.tasks.length, 0, 'no reload on the first sighting');
    pe.ctx.checkPlayerErrorRecovery();
    assertEq(pe.logs.length, 1, 'the sighting is logged once');
    pe.ctx.playerErrorState.firstSeenAt = Date.now() - 2100;
    pe.ctx.checkPlayerErrorRecovery();
    assertDeepEq(pe.tasks, [[false, true, 'error-recovery']], 'after 2s the player is replaced with an error-recovery reload');
    pe.ctx.checkPlayerErrorRecovery();
    assertEq(pe.tasks.length, 1, 'no second reload on the next tick');
    pe.dom.playerText = 'LIVE';
    pe.ctx.checkPlayerErrorRecovery();
    assert(pe.ctx.playerErrorState.firstSeenAt === 0 && pe.ctx.playerErrorState.logged === false, 'state resets once the error is gone');
    pe = makeErrorCtx();
    pe.dom.playerText = errorText;
    pe.ctx.checkPlayerErrorRecovery();
    pe.ctx.playerErrorState.firstSeenAt = Date.now() - 5000;
    pe.ctx.checkPlayerErrorRecovery();
    assert(pe.logs.length === 1 && pe.logs[0].includes('last vaft reload: none') && pe.tasks.length === 0, 'an error without any vaft involvement is logged but not touched');

    // The real doTwitchPlayerTask with a mocked Twitch player: reload routing for the fork's kinds
    section('doTwitchPlayerTask reload routing');
    const makeReloadCtx = (paused) => {
        const logs = [];
        const srcCalls = [];
        const posted = [];
        const video = { muted: false, readyState: paused ? 0 : 4, paused: paused, ended: false, isConnected: true };
        const player = { isPaused: () => paused, core: { paused: paused, state: {} }, pause() {}, play() { return Promise.resolve(); }, getHTMLVideoElement: () => video };
        const ctx = format.loadMain(['isRecoveryReloadKind', 'doTwitchPlayerTask'], {
            console: { log: (m) => logs.push(String(m)) },
            getPlayerAndState: () => ({ player, state: { setSrc: (options) => srcCalls.push(options) } }),
            playerBufferState: { userPauseIntent: false, weJustPaused: 0, lastReloadAt: 0, lastReloadDesc: '' },
            document: { pictureInPictureElement: null, addEventListener() {}, removeEventListener() {}, getElementsByTagName: () => [] },
            localStorage: { getItem: () => null, setItem() {} },
            getPlayerVideoElement: () => video,
            postTwitchWorkerMessage: (key) => posted.push(key),
            iosSoftReload: false,
            RecoverFromSilentMute: true,
            setTimeout: () => 1
        });
        return { ctx, logs, srcCalls, posted };
    };
    let rl = makeReloadCtx(true);// player stopped with an error: reports paused, readyState 0
    rl.ctx.doTwitchPlayerTask(false, true, 'early');
    assertEq(rl.srcCalls.length, 0, 'an early reload for a paused player is dropped (as before)');
    assert(rl.logs.join('|').includes('Reload request (early) ignored — player is paused'), 'and the drop is logged now');
    rl.ctx.doTwitchPlayerTask(false, true, 'early');
    assertEq(rl.logs.length, 1, 'the drop log is rate-limited');
    rl.ctx.doTwitchPlayerTask(false, true, 'error-recovery');
    assertDeepEq(rl.srcCalls, [{ isNewMediaPlayerInstance: true, refreshAccessToken: true }], 'error-recovery replaces a paused/errored player: new media player instance and new token');
    assertDeepEq(rl.posted, ['TriggeredPlayerReload'], 'and tells the worker about the reload');
    assert(rl.logs.join('|').includes('Reloading Twitch player (hard) — error-recovery'), 'the reload log names the kind');
    assertEq(rl.ctx.playerBufferState.lastReloadDesc, 'hard, error-recovery', 'the reload is remembered for the error diagnostic');
    rl = makeReloadCtx(false);
    rl.ctx.doTwitchPlayerTask(false, true, 'codec-swap');
    assertDeepEq(rl.srcCalls, [{ isNewMediaPlayerInstance: false, refreshAccessToken: false }], 'codec-swap stays a soft reload without token refresh (upstream behaviour)');
    assert(rl.logs.join('|').includes('Reloading Twitch player (soft) — codec-swap'), 'and is named in the log');
    rl = makeReloadCtx(false);
    rl.ctx.doTwitchPlayerTask(false, true);
    assert(rl.logs.join('|').endsWith('Reloading Twitch player (soft)'), 'a reload without a kind logs as before');

    // Fork: user mute intent (68.9.1, input filter 68.10.3)
    section('trackUserMuteIntent');
    class HTMLVideoElement {}
    const playerVideo = new HTMLVideoElement();
    const otherVideo = new HTMLVideoElement();
    const handlers = {};
    const muteCtx = format.loadMain(['trackUserMuteIntent'], {
        HTMLVideoElement,
        playerBufferState: { userMuteIntent: false, lastUserInputAt: 0, lastOwnMuteAt: 0 },
        getPlayerVideoElement: () => playerVideo,
        document: { addEventListener: (type, fn) => { handlers[type] = fn; } }
    });
    muteCtx.trackUserMuteIntent();
    const state = muteCtx.playerBufferState;
    const inPlayerEl = { tagName: 'BUTTON', closest: (sel) => sel.includes('.video-player') ? {} : null };
    const outsideEl = { tagName: 'DIV', closest: () => null };
    const chatInput = { tagName: 'DIV', isContentEditable: true, closest: () => null };
    const forgetInput = () => { state.lastUserInputAt = Date.now() - 5000; };
    playerVideo.muted = true;
    handlers.volumechange({ target: playerVideo });
    assertEq(state.userMuteIntent, false, 'mute without user input is not the user\'s');
    handlers.pointerdown({ target: outsideEl });
    handlers.volumechange({ target: playerVideo });
    assertEq(state.userMuteIntent, false, 'a click outside the player does not make a mute the user\'s');
    handlers.keydown({ target: chatInput });
    handlers.keydown({ target: { tagName: 'INPUT' } });
    handlers.volumechange({ target: playerVideo });
    assertEq(state.userMuteIntent, false, 'typing in chat or a text field does not make a mute the user\'s');
    handlers.pointerdown({ target: inPlayerEl });
    state.lastOwnMuteAt = Date.now();
    handlers.volumechange({ target: playerVideo });
    assertEq(state.userMuteIntent, false, 'vaft\'s own pre-mute on a hard reload is not the user\'s');
    state.lastOwnMuteAt = 0;
    handlers.volumechange({ target: playerVideo });
    assertEq(state.userMuteIntent, true, 'mute right after a click on the player is the user\'s');
    otherVideo.muted = false;
    handlers.keydown({ target: { tagName: 'BODY' } });
    handlers.volumechange({ target: otherVideo });
    assertEq(state.userMuteIntent, true, 'other <video> elements (ads) are ignored');
    forgetInput();
    playerVideo.muted = false;
    handlers.volumechange({ target: playerVideo });
    assertEq(state.userMuteIntent, true, 'unmute without recent input keeps the user mute (Twitch restoring volume on a new element)');
    handlers.keydown({ target: { tagName: 'BODY' } });
    handlers.volumechange({ target: playerVideo });
    assertEq(state.userMuteIntent, false, 'unmute right after a keypress outside a text field clears it');
    forgetInput();
    playerVideo.muted = true;
    handlers.pointermove({ target: inPlayerEl, buttons: 0 });
    handlers.volumechange({ target: playerVideo });
    assertEq(state.userMuteIntent, false, 'moving the pointer over the player is not input');
    handlers.pointermove({ target: inPlayerEl, buttons: 1 });
    handlers.volumechange({ target: playerVideo });
    assertEq(state.userMuteIntent, true, 'dragging the volume slider to 0 is the user\'s mute');
    forgetInput();
    playerVideo.muted = false;
    handlers.wheel({ target: inPlayerEl });
    handlers.volumechange({ target: playerVideo });
    assertEq(state.userMuteIntent, false, 'wheel over the player counts as input');

    // Fork: ad watchdog (68.10.0)
    section('checkAdWatchdog');
    const makeWatchdog = () => {
        const logs = [];
        const posted = [];
        const visible = { getClientRects: () => [{}] };
        const hidden = { getClientRects: () => [] };
        const dom = { adUi: [], videos: [], iframes: [], playerRoot: null, textNodes: [] };
        const ctx = format.loadMain(
            ['hookedTwitchWorkers', 'describeRequestUrl', 'AdWatchdogSelectors', 'AdWatchdogTextPattern', 'adWatchdogState', 'recentMainRequests',
                'startAdWatchdogRequestLog', 'summarizeRecentRequests', 'findVisibleAdUi', 'describeMediaElements',
                'checkAdWatchdog', 'logAdWatchdogWorkerRequests'],
            {
                console: { log: (m) => logs.push(String(m)) },
                document: {
                    querySelectorAll: (selector) => selector === 'video' ? dom.videos : selector === 'iframe' ? dom.iframes
                        : selector === '[data-a-target="video-ad-label"]' ? dom.adUi : [],
                    querySelector: (selector) => selector === '[data-a-target="video-player"]' ? dom.playerRoot : null,
                    createTreeWalker: () => {
                        let i = 0;
                        return { nextNode: () => dom.textNodes[i++] || null };
                    }
                },
                NodeFilter: { SHOW_TEXT: 4 },
                playerBufferState: { inAdBreak: false },
                getPlayerVideoElement: () => dom.videos[0] || null,
                postTwitchWorkerMessage: (key) => posted.push('all:' + key),
                PerformanceObserver: class { observe() {} },
                performance: { timeOrigin: 0 },
                setTimeout: () => 1,
                clearTimeout: () => {}
            });
        return { ctx, logs, posted, dom, visible, hidden };
    };
    let wd = makeWatchdog();
    const playerWorker = { postMessage: (msg) => wd.posted.push('player:' + msg.key) };
    const wdPlayer = { core: { worker: playerWorker } };
    wd.ctx.hookedTwitchWorkers.add(playerWorker);
    wd.ctx.checkAdWatchdog(wdPlayer);
    assertEq(wd.logs.length, 0, 'no ad UI: nothing logged');
    wd.dom.adUi = [wd.hidden];
    wd.ctx.checkAdWatchdog(wdPlayer);
    assertEq(wd.logs.length, 0, 'hidden ad UI element: nothing logged');
    wd.dom.adUi = [Object.assign({ textContent: '  ' }, wd.visible)];
    wd.ctx.checkAdWatchdog(wdPlayer);
    assertEq(wd.logs.length, 0, 'visible element without text (field: ax-overlay at page load): nothing logged');
    wd.dom.adUi = [Object.assign({ textContent: ' Ad 1 of 2\n 0:15 ' }, wd.visible)];
    wd.dom.videos = [{ currentSrc: 'blob:https://www.twitch.tv/x', clientWidth: 1280, clientHeight: 720, paused: false, muted: false },
        { currentSrc: 'https://m.media-amazon.com/ad.mp4?sig=secret', clientWidth: 1280, clientHeight: 720, paused: false, muted: false }];
    // Buffer order is completion order: an old long request can follow a newer one
    wd.ctx.recentMainRequests.push({ t: Date.now() - 5000, u: 'edge.ads.twitch.tv/ads' }, { t: Date.now() - 120000, u: 'old.example/x' });
    for (let i = 0; i < 40; i++) wd.ctx.recentMainRequests.push({ t: Date.now() - 1000, u: 'static-cdn.example/emoticons/' + i + '.png' });
    wd.ctx.checkAdWatchdog(wdPlayer);
    const wdLog = wd.logs.join('\n');
    assert(wdLog.includes('Twitch ad UI visible, vaft saw NO ad break'), 'visible ad UI without a break is reported');
    assert(wdLog.includes('"Ad 1 of 2 0:15"'), 'reports the ad UI text with whitespace collapsed');
    assert(wdLog.includes('player worker hooked'), 'reports the worker hook state');
    assert(wdLog.includes('PLAYER blob 1280x720 playing') && wdLog.includes('m.media-amazon.com/ad.mp4'), 'lists the player video and the ad video host');
    assert(!wdLog.includes('secret'), 'never logs query strings');
    assert(wdLog.includes('edge.ads.twitch.tv ×1: /ads') && !wdLog.includes('old.example'), 'lists only requests from the last 30s');
    assert(wdLog.includes('static-cdn.example ×40: /emoticons/39.png , /emoticons/38.png (+38 more paths)'), 'groups requests by host, newest paths first, so a busy host cannot push others out');
    assertDeepEq(wd.posted, ['player:GetRecentRequests'], 'asks the player\'s own hooked worker for its requests');
    const linesAfterFirst = wd.logs.length;
    wd.ctx.checkAdWatchdog(wdPlayer);
    assertEq(wd.logs.length, linesAfterFirst, 'logs only once per ad UI appearance');
    wd.ctx.logAdWatchdogWorkerRequests([{ t: Date.now() - 1000, u: 'video-weaver.example/v1/playlist/abc.m3u8' }]);
    assert(wd.logs[wd.logs.length - 1].includes('worker requests (last 30s): video-weaver.example ×1: /v1/playlist/abc.m3u8'), 'logs the worker requests reply');
    wd.ctx.logAdWatchdogWorkerRequests([{ t: Date.now(), u: 'late.example/x' }]);
    assert(!wd.logs.join('\n').includes('late.example'), 'ignores worker replies nobody asked for');
    wd.dom.adUi = [];
    wd.ctx.adWatchdogState.lastSeenAt = Date.now() - 11000;
    wd.ctx.checkAdWatchdog(wdPlayer);
    wd.dom.adUi = [Object.assign({ textContent: 'Ad' }, wd.visible)];
    wd.ctx.playerBufferState.inAdBreak = true;
    wd.ctx.checkAdWatchdog({ core: { worker: { postMessage() {} } } });
    const rearmLog = wd.logs.slice(linesAfterFirst + 1).join('\n');
    assert(rearmLog.includes('vaft IS blocking an ad break'), 're-arms after the UI was gone 10s and reports a blocked break');
    assert(rearmLog.includes('player worker NOT hooked'), 'reports an unhooked player worker');
    assertDeepEq(wd.posted, ['player:GetRecentRequests', 'all:GetRecentRequests'], 'falls back to the tracked workers when the player worker is not hooked');
    const manyHosts = [];
    for (let i = 0; i < 25; i++) manyHosts.push({ t: 1000, u: 'h' + i + '.example/x' });
    const hostSummary = wd.ctx.summarizeRecentRequests(manyHosts, 1000, 30000, 20);
    assertEq(hostSummary.length, 21, 'caps the number of hosts');
    assertEq(hostSummary[0], 'h24.example ×1: /x', 'most recent host first');
    assertEq(hostSummary[20], '+5 more hosts', 'says how many hosts were left out');
    assertDeepEq(Array.from(wd.ctx.summarizeRecentRequests([null, { t: 1000 }, { t: 1000, u: 'bare-host.example' }], 1000, 30000, 20)), ['bare-host.example ×1: /'], 'tolerates malformed entries from the worker');

    // Text fallback (attributes renamed) + video fed through srcObject (MSE in the worker)
    wd = makeWatchdog();
    const banner = Object.assign({ tagName: 'P', getAttribute: (a) => a === 'class' ? 'CoreText-sc-1' : null,
        textContent: 'nyanners is taking an ad break; stick around to support the stream!' }, wd.visible);
    const label = Object.assign({ tagName: 'SPAN', getAttribute: () => null, textContent: 'Ad (0:02)' }, wd.visible);
    const bar = { textContent: '', parentElement: null };
    banner.parentElement = bar;
    label.parentElement = bar;
    bar.textContent = banner.textContent + ' Ad (0:02)';
    wd.dom.playerRoot = { textContent: 'Live ' + bar.textContent };
    wd.dom.textNodes = [{ nodeValue: 'Live', parentElement: Object.assign({ tagName: 'DIV', getAttribute: () => null }, wd.hidden) },
        { nodeValue: banner.textContent, parentElement: banner }, { nodeValue: 'Ad (0:02)', parentElement: label }];
    class MediaSourceHandle {}
    wd.dom.videos = [{ currentSrc: '', src: '', srcObject: new MediaSourceHandle(), clientWidth: 1259, clientHeight: 708, paused: false, muted: false }];
    wd.ctx.checkAdWatchdog(wdPlayer);
    const textLog = wd.logs.join('\n');
    assert(textLog.includes('text match <p class="CoreText-sc-1">'), 'text fallback names the matching element');
    assert(textLog.includes('Ad (0:02)'), 'text fallback reports the surrounding ad UI text');
    assert(textLog.includes('PLAYER srcObject:MediaSourceHandle 1259x708 playing'), 'describes a srcObject-fed player video');
    wd = makeWatchdog();
    wd.dom.playerRoot = { textContent: 'Live chat about ads' };
    wd.ctx.checkAdWatchdog(wdPlayer);
    assertEq(wd.logs.length, 0, 'no ad UI text in the player: nothing logged');
}

for (const format of formats) {
    currentFormat = format.name;
    workerTests(format);
    mainTests(format);
}

// Both formats must carry the same code (CLAUDE.md: synced pair)
currentFormat = 'pair';
section('vaft.user.js and vaft-ublock-origin.js in sync');
const pairDifferences = findPairDifferences();
assertDeepEq(pairDifferences, [], 'no code differences between the two formats');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
