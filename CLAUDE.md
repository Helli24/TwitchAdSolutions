# TwitchAdSolutions

Fork of pixeltris/TwitchAdSolutions (archived). Script code imported from ryanbr/TwitchAdSolutions at v68.5.7 (history preserved). Remote `origin` = Helli24/TwitchAdSolutions; ryanbr is an optional upstream for cherry-picking later fixes (`git remote add ryanbr https://github.com/ryanbr/TwitchAdSolutions.git`).

All userscript `@namespace` / `@updateURL` / `@downloadURL` headers, README links and the release workflow's permalink rewrite must point to `Helli24/TwitchAdSolutions`. When pulling changes from ryanbr, keep these headers on Helli24.

## Worker Blob Serialization (CRITICAL)

Functions serialized via `.toString()` into the Web Worker blob CANNOT reference outer-scope variables. This includes: `processM3U8`, `stripAdSegments`, `hookWorkerFetch`, `getAccessToken`, `gqlRequest`, `hasAdTags`, `getMatchedAdSignifiers`, `notifyAdComplete`, `getStreamUrlForResolution`, `parseAttributes`, `getServerTimeFromM3u8`, `replaceServerTimeInM3u8`, `pruneStreamInfos`, `createStreamInfo`, `getWasmWorkerJs`, `videoCodecFamily`, `getBackupSequenceOffset`, `shiftMediaSequence`, `describeRequestUrl`, `noteUntrackedPlaylist`, `planUntrackedAdReload`.

- Declare variables in `declareOptions()` (also serialized) or in the inline blob template literal
- To pass window-scope values to the worker, inject after `declareOptions(self)`: e.g. `ReloadPlayerAfterAd = ${ReloadPlayerAfterAd};`
- Regex hoisting or referencing outer-scope variables from these functions causes `ReferenceError`

## Files

Synced pairs (same logic, different format):
- `vaft/vaft.user.js` + `vaft/vaft-ublock-origin.js`
- `vaft/vaft_testing.user.js` + `vaft/vaft-testing-ublock-origin.js`
- `video-swap-new/video-swap-new.user.js` + `video-swap-new/video-swap-new-ublock-origin.js`
- `video-swap-new/video-swap-new-ublock-origin-testing.js` (testing only)
- `strip/strip.user.js` (standalone)

uBlock files have `twitch-videoad.js text/javascript` as line 1 (not valid JS — uBlock resource header).

## Naming Differences

| | vaft | video-swap-new | strip |
|---|---|---|---|
| Signifiers | `AdSignifiers` | `AD_SIGNIFIERS` | N/A |
| URL patterns | `AdSegmentURLPatterns` | `AD_SEGMENT_URL_PATTERNS` | N/A |
| Player type | `ForceAccessTokenPlayerType` | `OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE` | `ForceAccessTokenPlayerType` (default `site`) |
| Reload after ad | `ReloadPlayerAfterAd` | `ReloadPlayerAfterAd` | `ReloadPlayerAfterAds` |

## Versions

Bump `@version` (userscript header) and `ourTwitchAdSolutionsVersion` together for functional changes. Current: vaft 68.11.0/108, video-swap-new 1.87/55, strip 1.10/27. Testing: vaft 678.0.0/678, video-swap-new -/621.

## localStorage Config

All read at init, injected into worker blob:
- `twitchAdSolutions_reloadPlayerAfterAd` — `true`/`false`, default `true`
- `twitchAdSolutions_playerType` — string, default `popout`
- `twitchAdSolutions_pinBackupPlayerType` — `true`/`false`, default `false` (vaft default `true`)
- `twitchAdSolutions_hideAdOverlay` — `true` to hide the internal `.tas-adblock-overlay` banner (SDA wrapper hide always runs), default not set
- `twitchAdSolutions_reloadCooldownSeconds` — number, default `30` (0 to disable)
- `twitchAdSolutions_disableReloadCap` — `true` to revert to unlimited reloads
- `twitchAdSolutions_driftCorrectionRate` — number, default `1.1` (0 to disable)
- `twitchAdSolutions_earlyReloadPollThreshold` — number, default `3` (0 to disable; thin cache overrides to 1)
- `twitchAdSolutions_preferLowQualityBackup` — hybrid mode (sticky escape hatch + autoplay last-resort backup), default `true`; set to `false` to disable (vaft only)
- `twitchAdSolutions_backupSwapFirst` — on ad detect, immediately swap to backup player-type m3u8 (TTV-AB-style) instead of sticky CSAI strip. Default `true` as of v63.0.0; set to `false` for legacy strip-first path (vaft only)
- `twitchAdSolutions_lowQualityFirst` — fork default `true`. Moves `autoplay` (360p) to position 0 of `playerTypesToTry` on every break (after pin and fast-autoplay reorders, before the contamination reorder) and starts the post-reload minimal-requests window at 0. Set to `'false'` to probe Source types first (vaft only)
- `twitchAdSolutions_alignBackupSequence` — fork default `true`. At each backup switch, `processM3U8` stores `getBackupSequenceOffset(native, backup).offset` = (native last seq − backup last seq) − floor(PDT difference of the newest segments / segment duration) in `streamInfo.BackupSequenceOffset` and applies `shiftMediaSequence` (MEDIA-SEQUENCE + TWITCH-LIVE-SEQUENCE) to every backup poll; reset at end of break. Sequence numbers never go below 0: at a preroll (native `0..2`, backup 14 segments) the oldest backup segments that would land below 0 are dropped instead. Set to `'false'` to disable (vaft only)
- `twitchAdSolutions_untrackedReload` — fork default `true`. When a live playlist that is not in `StreamInfosByUrl` carries ad markers, `planUntrackedAdReload()` makes `processM3U8` post `ReloadPlayer` with kind `untracked-ads` (max one per 30s, two per 10 minutes, then one `giving up` log). Set to `'false'` to disable (vaft only)
- `twitchAdSolutions_fastAutoplayFirstTry` — opt-out (default `true` as of v67.1.0). Prepend autoplay (360p) to position 0 of the iteration when the prior break committed autoplay via PreferLowQualityBackup escape hatch. Saves ~1.5-2s of probe-loop buffering. Auto-resets when a Source-tier type wins (channel recovered) so quality returns to full automatically. Set to `'false'` to force full Source-tier probe on every break (vaft only)
- `twitchAdSolutions_recoverFromSilentMute` — opt-out (default `true`). On hard reload, if the element is already muted but vaft has successfully unmuted at any point earlier this session, recover via the 5500ms backstop (Twitch's silent re-mute pattern — issue #200). Disable via `'false'` if you deliberately mute mid-session and want that preserved across reloads. Users muted from session start are always respected (vaftEverUnmuted=false short-circuits the recovery check). vaft only.
- `twitchAdSolutions_disableAdSpoofing` — opt-in via `'false'` (default `'true'` — spoofing is OFF). When enabled, on ad detect vaft fires the GQL ad-tracking beacons (`video_ad_impression`, `video_ad_quartile_complete` × 4, `video_ad_pod_complete`) that Twitch's player would have sent if the ad had played normally. Originally intended to mimic the ad-completion signal Twitch expects and may reduce detection escalation — but the always-100%-watched + audible + visible beacon pattern may itself fingerprint as anomalous (silently, without GQL rejection) and trigger detection escalation in the other direction (observed correlation with CSAI ads reaching committed backups + TTV-AB maintainer hypothesis). Default flipped from on→off after v68.2.0. Set to `'false'` to re-enable (for A/B testing whether spoofing affects ad break duration / CSAI escalation on your channels). Failures swallowed (never blocks ad-block flow). vaft only.
- `twitchAdSolutions_disableInAdGapSeek` — opt-out via `'true'` (default off = feature on). Disables the in-ad frozen-buffer-gap seek (v660, TTV-AB #33 mirror) for A/B isolation of mid-break pause/loading-circle reports. vaft testing only.
- `twitchAdSolutions_disableInAdFreezeReload` — opt-out via `'true'` (default off = feature on). Disables the in-ad frozen-playhead reload escalation (v662, audio-gap CSAI backstop) for A/B isolation. vaft testing only.
- `twitchAdSolutions_disablePostBreakWedge` — opt-out via `'true'` (default off = feature on). Disables the post-break video-wedge recovery (v667/v68.5.0, TTV-AB _checkPostBreakWedge mirror) for A/B isolation.
- `twitchAdSolutions_disableBackgroundResume` — opt-out via `'true'` (default off = feature on). Disables the hidden-tab resume guard (v672, issue #255): a Twitch-initiated pause while the tab is hidden is resumed with a retry chain (strike-capped so a deliberate media-key pause is respected) instead of staying paused until tab focus. vaft testing only.

## CSAI vs SSAI

- **SSAI** (Server-Side Ad Insertion) — ads embedded in m3u8 segments. Blockable by stripping.
- **CSAI** (Client-Side Ad Insertion) — ads delivered via `edge.ads.twitch.tv`, outside m3u8. Not blockable at m3u8 level. Detected via fetch/XHR hooks for logging only.
- When `hadStrippedSegments === false` (CSAI-only), skip reload entirely to prevent cascade.

## Key Architecture (vaft)

- **Buffer monitor** (`monitorPlayerBuffering`) — polls player state every 1-3s (visibility-aware). Detects stalls, fires pause/play or reload.
- **Reload cooldown** — 30s default, auto-escalates to 90s if 3+ reloads in 5 minutes.
- **Reload cap** — buffer monitor reloads at most once per recovery window (`recoveryReloadUsed`).
- **Grace periods** — 15s after reload, 10s after backup switch. Buffer monitor skips fixes during these.
- **Drift correction** — `startDriftCorrection(videoElement)` shared function. 1.1× playback rate, 30s safety timeout. Restarts fresh on re-entry (clears stale timers). Used by post-reload drift and buffer gap seek.
- **Reload routing** — worker → main `ReloadPlayer` messages carry a `kind` field. `doTwitchPlayerTask(isPausePlay, isReload, reloadKind)` picks `setSrc` params: `kind === 'early'` → hard reload (`isNewMediaPlayerInstance: true, refreshAccessToken: true`, new session); otherwise soft reload. The two flags are **not** coupled: on Apple touch devices `iosSoftReload` downgrades `isNewMediaPlayerInstance` to false while `refreshAccessToken` stays true (v68.5.5 — not yet validated on a device). Early reload sites (both sticky + normal paths) send `kind: 'early'`; post-ad reload sites send `'post-ad'` when `SoftReloadNoStrip` is on and the break stripped nothing (v68.5.0), `'early'` otherwise. HEVC force reload stays soft (codec change, no strip involved). Hard reload flushes the MediaSource buffer — required after strip activity (BLANK_MP4 injection, recovery replay) to avoid audio/video desync from accumulated timestamp drift.
- **Early reload** — fires during prolonged all-stripped freeze. Threshold: 3 polls (~6s), or 1 poll when recovery cache <3 segments (thin-cache fast path). Budget: `max(1, PodLength)` or `max(2, PodLength)` when thin. `EarlyReloadTriggered` resets on "still ads" (both sticky + normal paths) to allow budget-based re-fire. Override via `twitchAdSolutions_earlyReloadPollThreshold`.
- **Sticky CSAI fast path** — once a break enters CSAI fast path (all segments live), stays on it for the whole break. Has its own early-reload trigger + `EarlyReloadAwaitingResult` check (normal-path check unreachable due to early return).
- **Latency-aware reload health check** — measures `seekable.end - currentTime` before skipping post-ad reload. If >7s behind live or seekable unavailable/garbage, proceeds with reload. Guards against 2^30 sentinel values via `Number.isFinite` + 3600s cap.
- **User pause intent** — tracks video pause/play events to distinguish user vs script pauses. `weJustPaused` only resets when player wasn't paused (guards against clearing intent during stall recovery).
- **Stream registration** — `processM3U8` only filters playlists whose URL is in `StreamInfosByUrl` (filled when the master playlist passes `hookWorkerFetch`); anything else is passed through unfiltered. `pruneStreamInfos()` (every 5 min) drops a stream not polled for 30 min only while another stream in the worker is being polled, because a paused player polls nothing but resumes with the same variant URLs. Unknown live playlists are logged by `noteUntrackedPlaylist()`; if they carry ad markers, `planUntrackedAdReload()` requests a player reload.
- **Recovery reload kinds** — `isRecoveryReloadKind()`: `'worker-recovery'` and `'untracked-ads'` skip the healthy-player check in `doTwitchPlayerTask` and are hard reloads with token refresh (the new media player instance constructs a new worker and requests the master playlist again).
- **Unhooked-worker recovery** — `checkUnhookedPlayerWorker()` (called from the buffer monitor) compares `player.core.worker` against the `hookedTwitchWorkers` WeakSet. A worker created before vaft loaded triggers `doTwitchPlayerTask(false, true, 'worker-recovery')` (hard reload, skips the healthy-player check), max 1 per page load; if the worker is still unhooked afterwards, `tryUnhookedPageReload()` reloads the page once per 10 min per tab (sessionStorage `twitchAdSolutions_unhookedPageReloadAt`; opt-out localStorage `twitchAdSolutions_unhookedPageReload=false`).
- **Ad watchdog (diagnostic)** — `checkAdWatchdog(player)` (called from the buffer monitor) looks for Twitch's visible ad UI with non-empty text (`AdWatchdogSelectors`, text fallback `AdWatchdogTextPattern` inside the player). Once per appearance (re-armed after 10s without it) it logs `Ad watchdog —` lines: vaft break state, element/text, worker hook state, `<video>`/`<iframe>` sources, main-thread requests of the last 30s (`PerformanceObserver` → `recentMainRequests`) and worker requests (`GetRecentRequests` sent to `player.core.worker` when hooked → `RecentWorkerRequests`, filled by `hookWorkerFetch`), both grouped by host via `summarizeRecentRequests()`. URLs pass through `describeRequestUrl()` (host + path, no query). Read-only.
- **User mute intent** — `trackUserMuteIntent()` (document capture listeners) sets `playerBufferState.userMuteIntent` when the player `<video>` is muted/unmuted within 1.5s of input aimed at the player (pointerdown/pointerup/drag/wheel inside `.video-player`, keydown outside text fields). Chat typing and vaft's own hard-reload pre-mute (`lastOwnMuteAt`) do not count. Silent re-mute recovery on hard reload (`shouldRecover`) is skipped while it is true.
- **Stale player ref** — `playerForMonitoringBuffering = null` on reload to force re-acquisition.
- **StreamInfo factory** — `createStreamInfo()` declares all fields up-front (46 fields vaft, 31 fields video-swap-new). Serialized into worker blob.

## Debug Logging

All logs use `[AD DEBUG]` prefix. Logs in `.toString()` functions must use `console.log` directly. Some logs are deduped (once per ad break or once per page load) to prevent console spam.

## Releases

`.github/workflows/release.yml` runs on every push to master that touches `vaft/`, `video-swap-new/` or `strip/` (and manually). If vaft's `@version` has no tag yet it rewrites the README permalinks, commits `vX.Y.Z`, tags it (commit and tag in one atomic push) and publishes a GitHub release via the `gh` CLI with the scripts, a ZIP and `SHA256SUMS` as assets and only that version's CHANGELOG section as notes. Already tagged versions are skipped (a manual run re-attaches assets). So: bump `@version` and add a `## vX.Y.Z (date)` CHANGELOG section in the same PR. The README install link uses `releases/latest/download/vaft.user.js` (counted by the downloads badge); `@updateURL` stays on raw master.

## Validation

`npm ci` once, then:
- `npm test` — unit tests. `tests/scripts.js` parses `vaft/vaft.user.js` and `vaft/vaft-ublock-origin.js` with acorn, extracts declarations from the IIFE body by name and evaluates them in a `vm` context (worker functions after `declareOptions(globalThis)`, like the blob; main-thread functions with mocked globals). Every suite runs against both formats. Never copy script functions into tests; add the name to the `loadWorker`/`loadMain` call instead. New fork logic should live in a named function so it can be tested this way.
- `npm run syntax` — `tests/syntax.js` parses all ten shipped scripts with acorn (uBlock files without their header line). Add new script files to its lists.
- `npm test` also compares the code tokens of `vaft.user.js` and `vaft-ublock-origin.js` (`findPairDifferences()` in `tests/scripts.js`): a change made to only one of the two fails. Known upstream differences (host check line, comments, two log strings) are listed there.

GitHub Actions (`validate.yml`) runs both on every push/PR touching `.js` or `package*.json`; the release workflow runs them before tagging. `tests/benchmark.js` still uses copied historical implementations and is not part of CI.

## Testing

Testing files include experimental features (ad completion spoofing, lower thresholds, removed pruneStreamInfos). Don't apply to main scripts without explicit request. Testing-script-only changes commit directly to master; PRs are for release scripts.

## Backup Player Types

- **vaft**: `embed`, `site`, `popout`, `mobile_web` (autoplay removed — gets stuck in loading circle on transition back)
- **video-swap-new**: `embed`, `popout`, `mobile_web` (autoplay + picture-by-picture removed)

## Ad Overlay Hiding

`hideTwitchAdOverlays()` hides one overlay type during ad blocking:
- **Stream display ads (SDA)** — via exact `[data-test-selector="sda-wrapper"]` selector, no parent walking

Called on every buffer monitor tick. Guards via `dataset.tasHidden` to skip already-hidden elements.

**Previously removed:**
- Turbo promo / "allow ads" overlay hide (PR #143) — used `.player-overlay-background` which is Twitch's generic modal scrim (also used for content gates, error dialogs, subscription warnings). Too broad to use safely.
- Ad-break-card text match (PR #141) — scanned `span/p/h1/h2/h3` text for "taking an ad break" phrases then walked up via fuzzy `[class*="overlay"]` + `parentElement` fallback. Could hide player controls on false matches. TTV-AB doesn't attempt this either.

Only keep overlay hides that use exact attribute selectors with no parent walking.
