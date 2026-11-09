# TwitchAdSolutions

<p align="center">
  <a href="https://github.com/Helli24/TwitchAdSolutions/releases"><img alt="Latest version" src="https://img.shields.io/github/v/release/Helli24/TwitchAdSolutions?display_name=tag&label=version"></a>
  <a href="https://github.com/Helli24/TwitchAdSolutions/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/Helli24/TwitchAdSolutions/total?label=downloads"></a>
  <a href="https://github.com/Helli24/TwitchAdSolutions/commits/master"><img alt="Last commit" src="https://img.shields.io/github/last-commit/Helli24/TwitchAdSolutions"></a>
  <a href="https://github.com/Helli24/TwitchAdSolutions/actions/workflows/validate.yml"><img alt="Validate JS" src="https://img.shields.io/github/actions/workflow/status/Helli24/TwitchAdSolutions/validate.yml?branch=master&label=checks"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/Helli24/TwitchAdSolutions"></a>
</p>

<p align="center">
  Twitch ad blocking with the <b>vaft</b> userscript for Tampermonkey, Violentmonkey and uBlock Origin.<br>
  During ad breaks the stream keeps playing at 360p with sound instead of showing the ads.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#whats-different-in-this-fork">Fork changes</a> ·
  <a href="#scripts">Scripts</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#troubleshooting">Troubleshooting</a>
</p>

Fork of [pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions) (archived). The script code is based on [ryanbr/TwitchAdSolutions](https://github.com/ryanbr/TwitchAdSolutions) v68.5.7 plus the fixes listed below. All update URLs point to this repository.

**Don't combine Twitch specific ad blockers.**

## Install

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/) (recommended) or [Violentmonkey](https://violentmonkey.github.io/). On Safari: [Userscripts](https://apps.apple.com/us/app/userscripts/id1463298887). *Greasemonkey doesn't work with the scripts.*
2. **Chrome / Edge (Manifest V3):** open `chrome://extensions`, click **Details** on the userscript manager and enable **Allow user scripts**.
3. **Tampermonkey:** Dashboard → Settings → set *Config mode* to **Expert** → section *Security* → set **Content Script API** to **UserScripts API Dynamic** → Save. Without it Chrome may start the script after Twitch's player, and ads on that page are not blocked (vaft then reloads the player or the page once to recover).
4. Open the [vaft userscript](https://github.com/Helli24/TwitchAdSolutions/releases/latest/download/vaft.user.js) and confirm the installation. Updates are then fetched automatically from this repository.
5. Reload Twitch. In the browser console (F12) you should see `[AD DEBUG] TwitchAdSolutions vaft v… loading` and `Worker intercepted — injecting ad-block hooks`.

Remove any older TwitchAdSolutions / vaft userscript first (for example from pixeltris or ryanbr), otherwise both run at the same time.

## What's different in this fork

| Version | Change |
|---|---|
| 68.6.0 / 68.9.0 | **Missed worker recovery.** If the userscript manager injects vaft after Twitch has started its video worker, no ad is ever detected on that page. vaft detects this, reloads the player once and, if that does not help, the page once (at most every 10 minutes per tab). |
| 68.7.0 | **360p first** (`lowQualityFirst`). On an ad break the 360p backup stream is tried first, so playback continues with sound instead of freezing while ad-laden full-quality backups are probed. |
| 68.7.x / 68.8.1 | Extra `[AD DEBUG]` diagnostics: switch and playback timing at ad start/end, ads vaft cannot detect, every client-side ad request. |
| 68.8.0 | **Backup sequence alignment** (`alignBackupSequence`). Backup playlists numbered differently from the live playlist froze the picture for 10–30 seconds at the start of a break; they are renumbered onto the live numbering now. |
| 68.9.1 | **Your mute is kept.** A mute set with the player button, the volume slider or the `m` key is no longer undone by the player reload after an ad break. |
| 68.10.x | **Ad watchdog.** If Twitch shows its ad label or countdown, vaft logs a short snapshot (`Ad watchdog —` lines in the console) of where the ad came from, even when it did not detect the ad itself. Playlists that bypass vaft's filter are logged as `Untracked media playlist`. Diagnostic only. |

Details for every version are in the [CHANGELOG](CHANGELOG.md). Every version is also published as a [release](https://github.com/Helli24/TwitchAdSolutions/releases) with all scripts, a ZIP bundle and SHA-256 checksums.

## Scripts

| Script | Userscript | uBlock Origin | Notes |
|---|---|---|---|
| **vaft** | [install](https://github.com/Helli24/TwitchAdSolutions/releases/latest/download/vaft.user.js) | [resource](https://raw.githubusercontent.com/Helli24/TwitchAdSolutions/master/vaft/vaft-ublock-origin.js) / [permalink](https://raw.githubusercontent.com/Helli24/TwitchAdSolutions/72cd45a40212e4257eff88110b38c009df783374/vaft/vaft-ublock-origin.js) | Recommended. Swaps to an ad-free backup stream during ad breaks; the fork changes above apply to vaft only. |
| video-swap-new | [install](https://github.com/Helli24/TwitchAdSolutions/raw/master/video-swap-new/video-swap-new.user.js) | [resource](https://raw.githubusercontent.com/Helli24/TwitchAdSolutions/master/video-swap-new/video-swap-new-ublock-origin.js) / [permalink](https://raw.githubusercontent.com/Helli24/TwitchAdSolutions/72cd45a40212e4257eff88110b38c009df783374/video-swap-new/video-swap-new-ublock-origin.js) | Older approach, not recommended. |
| twitch-brave-fix | [install](https://github.com/Helli24/TwitchAdSolutions/raw/master/vaft/twitch-brave-fix.user.js) | [resource](https://raw.githubusercontent.com/Helli24/TwitchAdSolutions/master/vaft/twitch-brave-fix-ublock-origin.js) | Companion for Brave only, if Twitch rejects requests because of Brave's fingerprint protection. |

### uBlock Origin

The userscript is recommended: uBlock Origin [may stop applying the scripts](https://github.com/pixeltris/TwitchAdSolutions/issues/200) for unknown reasons, and uBlock Origin Lite cannot load them at all.

- Open the uBlock Origin dashboard. Under **My filters** add `twitch.tv##+js(twitch-videoad)`.
- Under **Settings** enable *I am an advanced user*, click the cog and set `userResourcesLocation` to the resource URL (append it with a space if a URL is already set), e.g. `userResourcesLocation https://raw.githubusercontent.com/Helli24/TwitchAdSolutions/master/vaft/vaft-ublock-origin.js`.
- Disable and re-enable uBlock Origin (or restart the browser).

To stop using a script remove the filter and set the URL back to `unset`. Permalinks do not auto update; they are refreshed on every release.

## Configuration

Settings are stored in the browser's `localStorage` for twitch.tv. Open the console on twitch.tv (F12), run the command and reload the page. The defaults work for most people.

```js
// Set a value
localStorage.setItem('twitchAdSolutions_hideAdOverlay', 'true');

// Back to the default
localStorage.removeItem('twitchAdSolutions_hideAdOverlay');

// Show everything that is set
Object.keys(localStorage).filter(k => k.startsWith('twitchAdSolutions_')).forEach(k => console.log(k, '=', localStorage.getItem(k)));
```

Common settings (vaft):

| Key | Default | Effect |
|---|---|---|
| `twitchAdSolutions_hideAdOverlay` | not set | `true` hides the "Blocking ads" banner on the player. |
| `twitchAdSolutions_lowQualityFirst` | `true` | Try the 360p backup first on every ad break. `false` probes full-quality backups first (better quality when one is clean, freezes when none is). *Fork.* |
| `twitchAdSolutions_preferLowQualityBackup` | `true` | Use the 360p backup when every full-quality backup carries ads. |
| `twitchAdSolutions_reloadPlayerAfterAd` | `true` | Reload the player after a break to return to full quality. `false` uses pause/play (faster, less reliable). |
| `twitchAdSolutions_recoverFromSilentMute` | `true` | Undo a mute Twitch sets on its own during a player reload. A mute you set yourself is kept (68.9.1). |
| `twitchAdSolutions_playerType` | `popout` | Player type used for stream tokens: `popout`, `embed`, `site`, `autoplay` (360p). |

Advanced settings (vaft):

| Key | Default | Effect |
|---|---|---|
| `twitchAdSolutions_alignBackupSequence` | `true` | Renumber backup playlists onto the live numbering at the switch. *Fork.* |
| `twitchAdSolutions_unhookedPageReload` | `true` | Allow the one-time page reload when vaft missed Twitch's video worker. *Fork.* |
| `twitchAdSolutions_backupSwapFirst` | `true` | Swap to a backup stream on ad detect. `false` strips ad segments from the live stream instead (legacy). |
| `twitchAdSolutions_fastAutoplayFirstTry` | `true` | After a break that needed 360p, try 360p first on the next break. |
| `twitchAdSolutions_pinBackupPlayerType` | `true` | Remember which backup type worked last (360p is never pinned). |
| `twitchAdSolutions_reloadCooldownSeconds` | `30` | Minimum seconds between player reloads; `0` disables it. |
| `twitchAdSolutions_disableReloadCap` | not set | `true` allows unlimited buffer-monitor reloads (risk of reload loops). |
| `twitchAdSolutions_earlyReloadPollThreshold` | `3` | Playlist polls (~2 s each) of frozen playback before an early reload; `0` disables it. |
| `twitchAdSolutions_driftCorrectionRate` | `1.1` | Playback rate used to catch up to live after a reload; `0` disables it. |
| `twitchAdSolutions_softReloadNoStrip` | `true` | Use a soft reload after breaks that stripped no segments. |
| `twitchAdSolutions_disablePostBreakWedge` | not set | `true` disables the "audio plays, video frozen" recovery after breaks. |
| `twitchAdSolutions_disableAdSpoofing` | `true` (off) | `false` sends fake "ad watched" events to Twitch. Not recommended. |
| `twitchAdSolutions_iosSoftReload` | `true` | iPhone/iPad only: soft instead of hard reloads. |

## Troubleshooting

- Open the console (F12), type `AD DEBUG` into the filter and reload the page. See [DEBUG.md](DEBUG.md) for what the lines mean.
- **Ads play although vaft is installed:** check for `Worker intercepted` after `vaft … loading`. If it is missing, see step 3 of [Install](#install).
- **An ad plays although `Worker intercepted` is there:** vaft logs `Ad watchdog —` lines whenever Twitch shows its ad label or countdown, and `Untracked media playlist` when a playlist bypasses its filter. Include these lines in the issue.
- More known issues: [issues.md](issues.md).
- Still not working? [Open an issue](https://github.com/Helli24/TwitchAdSolutions/issues/new?template=bug_report.yml) with the `[AD DEBUG]` console lines.

### Known extension conflicts

- **7TV**: may cause black screen / infinite buffering ([ryanbr#17](https://github.com/ryanbr/TwitchAdSolutions/issues/17)).
- **TwitchNoSub**: handled automatically, older versions may conflict.
- **TTV-AB**, **Purple AdBlock**: Twitch ad blockers themselves. Use only one.
- **AdGuard Extra**: works on a different layer and can be used alongside.

## Other solutions

Proxies are the most reliable way of avoiding ads ([buffering / downtime info](full-list.md#proxy-issues)):

- `TTV LOL PRO` - [chrome](https://chrome.google.com/webstore/detail/ttv-lol-pro/bpaoeijjlplfjbagceilcgbkcdjbomjd) / [firefox](https://addons.mozilla.org/addon/ttv-lol-pro/) / [code](https://github.com/younesaassila/ttv-lol-pro)
- `Twitch Turbo` - https://www.twitch.tv/turbo
- `Alternate Player for Twitch.tv` - [chrome](https://chrome.google.com/webstore/detail/alternate-player-for-twit/bhplkbgoehhhddaoolmakpocnenplmhf) / [firefox](https://addons.mozilla.org/en-US/firefox/addon/twitch_5/)
- `AdGuard Extra` - [chrome](https://chrome.google.com/webstore/detail/adguard-extra-beta/mglpocjcjbekdckiahfhagndealpkpbj) / [firefox](https://github.com/AdguardTeam/AdGuardExtra/#firefox) / [userscript](https://userscripts.adtidy.org/release/adguard-extra/1.0/adguard-extra.user.js)

[Full list with descriptions](full-list.md) · [List maintained by @zGato](https://github.com/zGato/ScrewTwitchAds)

## Credits

Based on [pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions) and [ryanbr/TwitchAdSolutions](https://github.com/ryanbr/TwitchAdSolutions); vaft originates from [cleanlock/VideoAdBlockForTwitch](https://github.com/cleanlock/VideoAdBlockForTwitch#credits). Several fixes follow [GosuDRM/TTV-AB](https://github.com/GosuDRM/TTV-AB). [MIT License](LICENSE).
