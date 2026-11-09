// Unit tests for TwitchAdSolutions (vaft)
// Run: npm test   (or: node tests/test.js after npm install)
//
// The functions under test are loaded from the shipped files by tests/scripts.js — nothing is
// copied into this file — and every suite runs against both vaft.user.js and vaft-ublock-origin.js,
// so the two formats cannot drift apart unnoticed.

const { formats } = require('./scripts');

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
        'getBackupSequenceOffset', 'shiftMediaSequence', 'describeRequestUrl'
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

    // Fork: user mute intent (68.9.1)
    section('trackUserMuteIntent');
    class HTMLVideoElement {}
    const playerVideo = new HTMLVideoElement();
    const otherVideo = new HTMLVideoElement();
    const handlers = {};
    const muteCtx = format.loadMain(['trackUserMuteIntent'], {
        HTMLVideoElement,
        playerBufferState: { userMuteIntent: false, lastUserInputAt: 0 },
        getPlayerVideoElement: () => playerVideo,
        document: { addEventListener: (type, fn) => { handlers[type] = fn; } }
    });
    muteCtx.trackUserMuteIntent();
    const state = muteCtx.playerBufferState;
    playerVideo.muted = true;
    handlers.volumechange({ target: playerVideo });
    assertEq(state.userMuteIntent, false, 'mute without user input is not the user\'s');
    handlers.pointerdown();
    handlers.volumechange({ target: playerVideo });
    assertEq(state.userMuteIntent, true, 'mute right after a click is the user\'s');
    otherVideo.muted = false;
    handlers.keydown();
    handlers.volumechange({ target: otherVideo });
    assertEq(state.userMuteIntent, true, 'other <video> elements (ads) are ignored');
    state.lastUserInputAt = Date.now() - 5000;
    playerVideo.muted = false;
    handlers.volumechange({ target: playerVideo });
    assertEq(state.userMuteIntent, true, 'unmute without recent input keeps the user mute');
    handlers.keydown();
    handlers.volumechange({ target: playerVideo });
    assertEq(state.userMuteIntent, false, 'unmute right after a keypress clears it');

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
                postTwitchWorkerMessage: (key) => posted.push(key),
                PerformanceObserver: class { observe() {} },
                performance: { timeOrigin: 0 },
                setTimeout: () => 1,
                clearTimeout: () => {}
            });
        return { ctx, logs, posted, dom, visible, hidden };
    };
    let wd = makeWatchdog();
    const playerWorker = { postMessage() {} };
    const wdPlayer = { core: { worker: playerWorker } };
    wd.ctx.hookedTwitchWorkers.add(playerWorker);
    wd.ctx.checkAdWatchdog(wdPlayer);
    assertEq(wd.logs.length, 0, 'no ad UI: nothing logged');
    wd.dom.adUi = [wd.hidden];
    wd.ctx.checkAdWatchdog(wdPlayer);
    assertEq(wd.logs.length, 0, 'hidden ad UI element: nothing logged');
    wd.dom.adUi = [Object.assign({ textContent: ' Ad 1 of 2\n 0:15 ' }, wd.visible)];
    wd.dom.videos = [{ currentSrc: 'blob:https://www.twitch.tv/x', clientWidth: 1280, clientHeight: 720, paused: false, muted: false },
        { currentSrc: 'https://m.media-amazon.com/ad.mp4?sig=secret', clientWidth: 1280, clientHeight: 720, paused: false, muted: false }];
    // Buffer order is completion order: an old long request can follow a newer one
    wd.ctx.recentMainRequests.push({ t: Date.now() - 5000, u: 'edge.ads.twitch.tv/ads' }, { t: Date.now() - 120000, u: 'old.example/x' });
    wd.ctx.checkAdWatchdog(wdPlayer);
    const wdLog = wd.logs.join('\n');
    assert(wdLog.includes('Twitch ad UI visible, vaft saw NO ad break'), 'visible ad UI without a break is reported');
    assert(wdLog.includes('"Ad 1 of 2 0:15"'), 'reports the ad UI text with whitespace collapsed');
    assert(wdLog.includes('player worker hooked'), 'reports the worker hook state');
    assert(wdLog.includes('PLAYER blob 1280x720 playing') && wdLog.includes('m.media-amazon.com/ad.mp4'), 'lists the player video and the ad video host');
    assert(!wdLog.includes('secret'), 'never logs query strings');
    assert(wdLog.includes('edge.ads.twitch.tv/ads') && !wdLog.includes('old.example'), 'lists only requests from the last 30s');
    assertDeepEq(wd.posted, ['GetRecentRequests'], 'asks the hooked worker for its requests');
    const linesAfterFirst = wd.logs.length;
    wd.ctx.checkAdWatchdog(wdPlayer);
    assertEq(wd.logs.length, linesAfterFirst, 'logs only once per ad UI appearance');
    wd.ctx.logAdWatchdogWorkerRequests([{ t: Date.now() - 1000, u: 'video-weaver.example/v1/playlist/abc.m3u8' }]);
    assert(wd.logs[wd.logs.length - 1].includes('worker requests (last 30s): video-weaver.example/v1/playlist/abc.m3u8'), 'logs the worker requests reply');
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

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
