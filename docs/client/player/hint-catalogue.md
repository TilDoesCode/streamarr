# Player hint catalogue

Every text the player shows about a state, in German and English, as the viewer reads it. Generated from the locale
files (`client/src/i18n/locales/{player.,}{de,en}.json`) by `client/jest/player/hint-catalogue.ts`; the test
`client/src/player/__tests__/hint-catalogue.test.ts` fails when this file and the locale files disagree. Regenerate
with `UPDATE_CATALOGUE=1 npx jest hint-catalogue` from `client/`. Placeholders are filled with sample values
(times, a device name, measured numbers) so number formats per locale are visible.

Every text says what happened, then what the app does about it, and where the viewer can do something, what.
The layers, from first seen to last resort: the start card (S), status hints over the picture (H), notices after
the app changed something (N), the failure card (C categories, F codes, its reason line and actions), and the card's
"What was tried" list (W).

## Start card (S)

| Row | State | de | en | Action | Shows when | Clears when |
|---|---|---|---|---|---|---|
| S01 | Start card heading | Wiedergabe wird vorbereitet | Preparing playback | — | start begins | first frame |
| S02 | Step label: version check | Version prüfen | Check version | — | server state resolving | next state |
| S03 | Current step: version check | Es wird geprüft, ob alle Teile dieser Version verfügbar sind. | Checking that every part of this version is available. | — | server state resolving | next state |
| S04 | Step label: next version | Nächste Version | Next version | — | server state fallback | next state |
| S05 | Current step: the version is missing data | 2160p WEB-DL ist unvollständig, deshalb wird die nächste Version versucht. | 2160p WEB-DL is missing data, so the next version is tried. | — | server state fallback | next state |
| S06 | Step label: repair | Reparatur | Repair | — | server state repairing | next state |
| S07 | Current step: repair | Fehlende Teile werden aus Wiederherstellungsdaten neu erzeugt. | Rebuilding missing parts from recovery data. | — | server state repairing | next state |
| S08 | Repair progress with time left | 42 % repariert · noch etwa 3 min | 42% repaired · about 3 min left | — | the server reports progress and an estimate | repair done |
| S09 | Repair progress without estimate | 42 % repariert | 42% repaired | — | the server reports progress only | repair done |
| S10 | Step label: choose how to play | Wiedergabeart wählen | Choose how to play | — | server state planning | next state |
| S11 | Current step: choose how to play | Die beste Wiedergabeart für dieses Gerät wird gewählt. | Picking the best way to play on this device. | — | server state planning | next state |
| S12 | Step label: start | Wiedergabe starten | Start playback | — | server state starting | ready |
| S13 | Current step: start | Das Video wird geöffnet. | Opening the video. | — | server state starting | ready |
| S14 | Current step: queued for server capacity | Wartet, bis der Server Platz für dieses Video hat. | Waiting until the server has room for this video. | — | server state queued | next state |
| S15 | A version in the list is being checked | wird geprüft | checking | — | attempt state resolving | checked |
| S16 | A version in the list is ready | bereit | ready | — | attempt state ready | — |
| S17 | A version in the list misses parts that can be repaired | reparierbar | repairable | — | attempt state degraded | repaired |
| S18 | A version in the list misses data for good | unvollständig | missing data | — | attempt state dead | — |
| S19 | A viewer switch runs (quality, version, audio) | Wird umgeschaltet… | Switching… | — | phase switching | the new source plays, or the switch failed notice |
| S20 | Start card heading after a failed start | Wiedergabe nicht möglich | Can’t play | — | the start failed | retry or leave |

## Status hints over the picture (H)

At most one hint at a time, under the spinner. A hint appears 4 s after a stall or as soon as a recovery step runs;
during a step the viewer's own actions wait (none shown).

| Row | State | de | en | Action | Shows when | Clears when |
|---|---|---|---|---|---|---|
| H01 | Start, no picture yet | Wiedergabe startet … | Starting playback… | — / — | never on its own: the start stepper covers it | first frame |
| H02 | Start or reload takes longer than its budget | Der Start dauert länger als üblich. Der Server wandelt das Video um. | Starting takes longer than usual. The server is converting the video. | Niedrigere Qualität, Abbrechen / Lower quality, Cancel | a start state lasts past its budget (queued/resolving 60 s, planning 30 s, starting 45 s), or no picture 10 s after a load | first frame, or the start_stuck card |
| H03 | Stall, measured throughput below the bitrate | Langsame Verbindung: 2,4 von 8,5 Mbit/s. Wird gepuffert … | Slow connection: 2.4 of 8.5 Mbit/s. Buffering… | Niedrigere Qualität / Lower quality | a stall lasts 4 s and the last segment came slower than 1.2 × the bitrate | the picture runs again; after 15 s the stall ladder (lower quality) takes over |
| H04 | Stall, the server converts slower than real time | Der Server wandelt langsamer um, als das Video läuft. Wird gepuffert … | The server converts slower than the video plays. Buffering… | Niedrigere Qualität / Lower quality | a stall of a converted playback lasts 4 s and the last 3 segments delivered less than real time | the picture runs again; after 15 s the stall ladder |
| H05 | Connection lost, the app retries | Verbindung unterbrochen. Neuer Versuch in 4 s … | Connection lost. Retrying in 4 s… | Jetzt versuchen, Zurück / Try now, Back | an app request fails without an answer and the next try is scheduled | the request goes through, or the T1 card |
| H06 | This device has no network | Keine Netzwerkverbindung. Es geht weiter, sobald das Gerät wieder online ist. | No network connection. Playback continues once this device is back online. | Zurück / Back | the device reports offline (at once) | back online: the playback continues (reload at the position if needed) |
| H07 | The server ended the playback (T2), a new one starts | Der Server hat die Wiedergabe beendet. Neustart bei 42:10 … | The server ended this playback. Restarting at 42:10… | — / — | step N for T2 runs, after 4 s of a stalled picture | the step is done: the picture plays again, or the next step or the card follows |
| H08 | Picture frozen while playback runs | Das Bild hängt. Wird bei 42:10 neu geladen … | The picture is stuck. Reloading at 42:10… | — / — | the watchdog sees no new frames while the clock runs | the step is done: the picture plays again, or the next step or the card follows |
| H09 | Sound but no picture (black) | Kein Bild. Eine andere Wiedergabeart wird versucht … | No picture. Trying another way to play… | — / — | the watchdog sees a black picture with moving frames, or a device failure recurs | the step is done: the picture plays again, or the next step or the card follows |
| H10 | Picture but no sound | Kein Ton. Die Tonspur wird neu geladen … | No sound. Reloading the audio… | Andere Tonspur / Other audio track | the watchdog hears silence while the audio track should play, or only the audio requests fail | the step is done: the picture plays again, or the next step or the card follows |
| H11 | This device drops too many frames | Das Gerät kommt nicht hinterher (37 % Bilder ausgelassen). Eine niedrigere Qualität hilft. | This device can’t keep up (37% of frames dropped). A lower quality helps. | Niedrigere Qualität / Lower quality | the watchdog counts more than the allowed share of dropped frames | frames stay smooth again, or the viewer lowers the quality |
| H12 | The file ends before its announced length | Die Datei endet bei 1:31:02, 12:40 vor dem Ende. Eine andere Version hat vielleicht den Rest. | The file ends at 1:31:02, 12:40 before the end. Another version may have the rest. | Andere Version, Zurück / Other version, Back | the engine ends more than 12 s before the end and the server confirms the short file | the viewer picks another version or leaves |
| H13 | The system paused playback | Pausiert: Anruf. | Paused: incoming call. | Weiter / Resume | an engine pause the app did not ask for lasts 1 s | the viewer resumes |
| H14 | Playing on an AirPlay device | Läuft auf Living room. | Playing on Living room. | — / — | AirPlay is active | AirPlay ends |
| H15 | Step S runs after the device refused a named format (native decoder error, HDR tag mismatch) | Dieses Gerät kann HEVC nicht abspielen. Eine andere Wiedergabeart wird versucht, es geht weiter bei 42:10 … | This device can’t play HEVC. Trying another way to play at 42:10… | — / — | the step runs and the failure names a format (HEVC, AV1, Dolby Vision, HDR, E-AC-3 …) | the step is done: the picture plays again, or the next step or the card follows |
| H16 | Web: the browser only allowed a muted start | Ohne Ton gestartet (Vorgabe des Browsers). | Started without sound (browser rule). | Ton an / Unmute | the muted autoplay fallback was used | the viewer unmutes |
| H17 | Web: the browser blocked the start | Der Browser hat den Start verhindert. Drücke Abspielen. | The browser didn’t let the video start. Press Play. | Abspielen / Play | play() was refused even muted | the viewer presses Play |
| H18 | Server busy (T4), the app waits for Retry-After | Der Server ist ausgelastet. Neuer Versuch in 8 s … | The server is busy. Retrying in 8 s… | Jetzt versuchen / Try now | a T4 answer with a wait time | the retry goes through, or the T4 card |
| H19 | Stream limit: waiting for the other device to stop | Startet, sobald die Wiedergabe auf Apple TV endet. | Starts as soon as playback on Apple TV stops. | Zurück / Back | too_many_streams names the device and the app waits | the other playback stops, or the viewer goes back |
| H20 | Stall without a known cause | Das Laden dauert länger als üblich. Wird gepuffert … | Loading takes longer than usual. Buffering… | Niedrigere Qualität / Lower quality | a stall lasts 4 s and neither the connection nor the server is measured slow | the picture runs again; after 15 s the stall ladder |
| H21 | Server error (T6), the app retries | Der Server hatte ein Problem. Neuer Versuch in 2 s … | The server had a problem. Retrying in 2 s… | Jetzt versuchen / Try now | a T6 answer and the next try is scheduled | the retry goes through, or the next step |
| H22 | Step R or N runs (reload or new start at the position) | Die Wiedergabe ist stehen geblieben. Es geht weiter bei 42:10 … | Playback stopped. Resuming at 42:10… | — / — | the step runs, after 4 s of a stalled picture | the step is done: the picture plays again, or the next step or the card follows |
| H23 | Step Q runs (lower quality) | Wechsel zu einer niedrigeren Qualität, es geht weiter bei 42:10 … | Switching to a lower quality to keep playing at 42:10… | — / — | the step runs | the step is done: the picture plays again, or the next step or the card follows |
| H24 | Step S runs (another way to play) | Eine andere Wiedergabeart wird versucht, es geht weiter bei 42:10 … | Trying another way to play at 42:10… | — / — | the step runs | the step is done: the picture plays again, or the next step or the card follows |
| H25 | Step V runs (another version) | Eine andere Version wird versucht, es geht weiter bei 42:10 … | Trying another version at 42:10… | — / — | the step runs | the step is done: the picture plays again, or the next step or the card follows |
| H26 | Step A runs (sound converted on the server) | Kein Ton. Der Ton wird umgewandelt, es geht weiter bei 42:10 … | No sound. Converting the audio to keep playing at 42:10… | — / — | the step runs | the step is done: the picture plays again, or the next step or the card follows |
| H27 | A media request fails with a server status, the player retries | Der Server hatte ein Problem mit diesem Teil des Videos. Neuer Versuch … | The server had a problem with this part of the video. Retrying… | — / — | a stall while the engine retries an HTTP 4xx/5xx | the retry goes through, or the stall ladder |
| H28 | The server repairs missing data of the file | Der Server repariert fehlende Daten dieses Videos. Wird gepuffert … | The server is repairing missing data of this video. Buffering… | — / — | a stall while the server reports a repair | the picture runs again |
| H29 | The stream keeps breaking off while the server answers (T6 delivery_interrupted) | Der Stream bricht immer wieder ab. Wird bei 42:10 neu geladen … | The stream keeps breaking off. Reloading at 42:10… | — / — | step R runs for a media break without a status (AVPlayer -1005) while the app's own requests answer | the step is done: the picture plays again, or the next step or the card follows |

### Causes inside a hint

| Cause | de | en |
|---|---|---|
| `call` | Anruf | incoming call |
| `otherAudio` | eine andere App spielt Ton | another app is playing sound |
| `headphones` | Kopfhörer getrennt | headphones disconnected |
| `locked` | Bildschirm gesperrt | screen locked |
| `pipClosed` | Bild-in-Bild geschlossen | picture-in-picture closed |
| `airplayLost` | AirPlay getrennt | AirPlay disconnected |
| `outside` | außerhalb der App | outside the app |
| `converting` | Der Server wandelt das Video um. | The server is converting the video. |
| `slowConnection` | Die Verbindung ist langsam. | The connection is slow. |
| `loadingFile` | Der Player öffnet die Datei noch. | The player is still opening the file. |
| `preparing` | Der Server bereitet das Video noch vor. | The server is still preparing the video. |

### Hint actions

| Action | de | en |
|---|---|---|
| `lowerQuality` | Niedrigere Qualität | Lower quality |
| `cancel` | Abbrechen | Cancel |
| `tryNow` | Jetzt versuchen | Try now |
| `back` | Zurück | Back |
| `otherVersion` | Andere Version | Other version |
| `otherAudio` | Andere Tonspur | Other audio track |
| `otherSubtitles` | Andere Untertitel | Other subtitles |
| `resume` | Weiter | Resume |
| `unmute` | Ton an | Unmute |
| `play` | Abspielen | Play |
| `signIn` | Erneut anmelden | Sign in again |

## Notices (N)

A short banner after the app changed something on its own, or when a change the viewer asked for failed. A
step-down notice says the reason first (N06–N09), then what changed.

| Row | State | de | en | Action | Shows when | Clears when |
|---|---|---|---|---|---|---|
| N01 | Step S switched the way to play | Das Video kam zu langsam an. Wiedergabeart gewechselt, damit es weitergeht. | The video loaded too slowly. Switched to another way to play to keep it going. | — | step S succeeded | 6 s (TV 8 s) |
| N02 | Step S switched to VLC | Zu VLC gewechselt, damit es weitergeht. | Switched to VLC to keep playing. | — | step S chose VLC | 6 s (TV 8 s) |
| N03 | Step S switched to direct play | Zur direkten Wiedergabe gewechselt, damit es weitergeht. | Switched to direct play to keep playing. | — | step S chose direct play | 6 s (TV 8 s) |
| N04 | Step S switched to direct stream | Zum Direkt-Stream gewechselt, damit es weitergeht. | Switched to direct stream to keep playing. | — | step S chose direct stream | 6 s (TV 8 s) |
| N05 | Step S switched to conversion | Zur Umwandlung auf dem Server gewechselt, damit es weitergeht. | Switched to conversion on the server to keep playing. | — | step S chose conversion | 6 s (TV 8 s) |
| N06 | Reason before a step-down: decoding failed | Dieses Gerät konnte das Video nicht dekodieren. | This device couldn’t decode the video. | — | with N01–N05 | with the notice |
| N07 | Reason before a step-down: too slow | Das Video kam zu langsam an. | The video loaded too slowly. | — | with N01–N05 | with the notice |
| N08 | Reason before a step-down: server problem | Der Server hatte ein Problem. | The server had a problem. | — | with N01–N05 | with the notice |
| N09 | Reason before a step-down: black picture | Das Bild blieb schwarz. | The picture stayed black. | — | with N01–N05 | with the notice |
| N21 | Reason before a step-down: a stuck picture without a decoder error | Das Bild blieb hängen. | The picture got stuck. | — | with N01–N05 (playback_stalled, seek_stalled, picture_frozen, video_stalled) | with the notice |
| N10 | Reason before a step-down: the video data is damaged at that spot (a segment that does not parse) | Die Videodaten sind bei 0:41 beschädigt. | The video data is damaged at 0:41. | — | with N01–N05, after one reload at the spot | with the notice |
| N10 | Step V switched the version | Zu einer anderen Version gewechselt, damit es weitergeht. | Switched to another version to keep playing. | — | step V succeeded | 6 s (TV 8 s) |
| N18 | Step V: the other version lacks the viewer's subtitle language | Diese Version hat keine Untertitel auf German. | This version has no German subtitles. | Other subtitles | after N10, in the same notice | with N10 |
| N19 | Step V: the other version lacks the viewer's audio language | Diese Version hat keinen Ton auf German. | This version has no German audio. | Other audio track | after N10, in the same notice | with N10 |
| N11 | Step A converted the sound | Ton in Stereo umgewandelt, damit es weitergeht. | Sound converted to stereo to keep playing. | — | step A succeeded | 6 s (TV 8 s) |
| N12 | An audio switch needed a new start | Tonspur gewechselt; die Wiedergabe wurde dafür an derselben Stelle neu gestartet. | Audio track switched; playback restarted at the same spot for it. | — | the in-session audio switch timed out and the server switched | 6 s (TV 8 s) |
| N20 | Web: another tab of this browser started playing | Wiedergabe in einem anderen Tab gestartet, deshalb hier pausiert. Drücke Abspielen, um hier weiterzuschauen. | Playback started in another tab, so it paused here. Press Play to continue here. | Play | the other tab starts or resumes a playback; this one pauses | 6 s (TV 8 s) |
| N13 | A viewer switch was refused, the old source plays on | Umschalten nicht möglich. Der Server wandelt gerade zu viele Videos um. Versuche es gleich noch einmal. Die Wiedergabe läuft wie bisher weiter. | Couldn’t switch. The server is converting too many videos right now. Try again in a moment. Playback continues as before. | — | the switch request failed (reason: the code’s text) | 6 s (TV 8 s) |
| N14 | Subtitles failed once, retried later | Untertitel „English (SDH)“ konnten nicht geladen werden und sind aus. Sie werden in einer Minute erneut versucht. | Subtitles “English (SDH)” couldn’t be loaded and are off. They’ll be tried again in a minute. | Other subtitles (menu) | first subtitle failure | 6 s (TV 8 s); retried after 60 s |
| N15 | Subtitles failed again, off for good | Untertitel „English (SDH)“ konnten nicht geladen werden und sind aus. Wähle andere Untertitel. | Subtitles “English (SDH)” couldn’t be loaded and are off. Choose other subtitles. | Other subtitles (menu) | second failure within 2 min | 6 s (TV 8 s) |
| N16 | Subtitles this device cannot show | Untertitel „English (PGS)“ können auf diesem Gerät nicht angezeigt werden. Wähle andere Untertitel. | Subtitles “English (PGS)” can’t be shown on this device. Choose other subtitles. | Other subtitles (menu) | the server cannot deliver them for this engine | 6 s (TV 8 s) |
| N17 | Subtitles only VLC can show | Untertitel „English (PGS)“ können hier nicht angezeigt werden. Spiele mit VLC ab, um sie zu sehen. | Subtitles “English (PGS)” can’t be shown here. Play with VLC to see them. | Player → VLC (menu) | as N16, VLC available | 6 s (TV 8 s) |

## Failure card (C, F)

The card shows when the recovery ladder has nothing left to try (or the failure has no step, e.g. signed out). Title
and message come from the code (F); a code without its own text uses its category's text (C). Below them: the
server's reason line, the "What was tried" list and the actions — the ladder's actions for the category, then Back.

### Categories (C) — the text of a code without its own

| Category | de | en | Actions |
|---|---|---|---|
| T1 | Verbindungsproblem — Die Verbindung zum Server wurde unterbrochen. Prüfe das Netzwerk und versuche es erneut. | Connection problem — The connection to the server was interrupted. Check the network and try again. | Try again |
| T2 | Wiedergabe auf dem Server beendet — Der Server kennt diese Wiedergabe nicht mehr. Starte sie neu, um an derselben Stelle weiterzuschauen. | Playback ended on the server — The server no longer knows this playback. Start it again to continue where you left off. | Try again |
| T3 | Abgemeldet — Dieses Gerät wurde abgemeldet. Melde dich erneut an, um weiterzumachen. | Signed out — This device was signed out. Sign in again to continue. | Sign in again |
| T4 | Server ist ausgelastet — Der Server hat gerade zu viel zu tun. Versuche es gleich noch einmal. | Server is busy — The server is handling too much right now. Try again in a moment. | Try again |
| T5 | Zu langsam für die Wiedergabe — Das Video kommt nicht schnell genug an. Versuche eine niedrigere Qualität. | Too slow to play — The video can’t be delivered fast enough. Try a lower quality. | Lower quality, Choose another version |
| T6 | Problem auf dem Server — Auf dem Server ist beim Vorbereiten dieses Videos etwas fehlgeschlagen. Versuche es erneut oder wähle eine andere Version. | The server had a problem — Something failed on the server while preparing this video. Try again or choose another version. | Try again, Choose another version |
| T7 | Dieses Gerät kann das Video nicht abspielen — Das Format wird hier nicht unterstützt. Versuche eine andere Version oder spiele mit VLC ab. | This device can’t play this video — The format isn’t supported here. Try another version or play with VLC. | Choose another version, Play with VLC |
| T8 | Diese Version lässt sich nicht abspielen — Die Datei ist beschädigt, unvollständig oder nicht verfügbar. Wähle eine andere Version. | This version can’t be played — The file is damaged, incomplete or unavailable. Choose another version. | Choose another version |
| T9 | Nicht verfügbar — Das ist für dieses Profil oder auf diesem Server nicht erlaubt. | Not available — This isn’t allowed for this profile or on this server. | — |
| T10 | Vom Gerät pausiert — Das Gerät hat die Wiedergabe unterbrochen. Drücke Abspielen, um weiterzuschauen. | Paused by the device — The device interrupted playback. Press Play to continue. | Try again |
| T11 | Unerwartetes Problem in der App — Versuche es erneut. Wenn es wieder passiert, melde den Code unten. | The app hit an unexpected problem — Try again. If it keeps happening, report the code below. | Try again |

### Codes (F)

| Row | Code (category) | de | en | Actions (en) |
|---|---|---|---|---|
| F01 | `unknown` (T11) | **Etwas ist schiefgelaufen** — Ein unerwarteter Fehler ist aufgetreten. Versuche es gleich noch einmal. | **Something went wrong** — An unexpected error occurred. Try again in a moment. | Try again, Go back |
| F02 | `network_unreachable` (T1) | **Server nicht erreichbar** — Prüfe, ob der Server läuft und dieses Gerät im selben Netzwerk ist. | **Can’t reach the server** — Check that the server is running and that this device is on the same network. | Try again, Go back |
| F03 | `timeout` (T1) | **Der Server antwortet zu langsam** — Die Anfrage hat zu lange gedauert. Versuche es gleich noch einmal. | **The server is taking too long** — The request timed out. Try again in a moment. | Try again, Go back |
| F04 | `tls_error` (T1) | **Sichere Verbindung fehlgeschlagen** — Dieses Gerät vertraut dem Zertifikat des Servers nicht, oder die Verbindung wurde unterbrochen. Prüfe die Adresse und das Zertifikat des Servers. | **Secure connection failed** — The server’s certificate isn’t trusted by this device, or the connection was interrupted. Check the address and the server’s certificate. | Go back |
| F05 | `mixed_content` (T1) | **Unverschlüsselter Server blockiert** — Diese Seite läuft über https, deshalb blockiert der Browser die http-Adresse des Servers. Verwende die https-Adresse des Servers. | **Unencrypted server blocked** — This page is loaded over https, so the browser blocks the server’s plain http address. Use the server’s https address. | Try again, Go back |
| F06 | `aborted` (T11) | **Anfrage abgebrochen** — Die Anfrage wurde abgebrochen, bevor sie fertig war. | **Request cancelled** — The request was cancelled before it finished. | Try again, Go back |
| F07 | `server_error` (T6) | **Serverfehler** — Auf dem Server ist ein Problem aufgetreten. Versuche es gleich noch einmal. | **Server error** — The server ran into a problem. Try again in a moment. | Try again, Choose another version, Go back |
| F08 | `not_found` (T2) | **Nicht gefunden** — Dieser Eintrag existiert auf dem Server nicht mehr. | **Not found** — This item no longer exists on the server. | Try again, Go back |
| F09 | `session_ended` (T3) | **Abgemeldet** — Die Sitzung auf diesem Gerät ist beendet. Melde dich erneut an, um weiterzumachen. | **Signed out** — The session on this device has ended. Sign in again to continue. | Sign in again, Go back |
| F10 | `device_caps_unavailable` (T11) | **Player konnte nicht starten** — Der Player dieses Geräts ließ sich nicht einrichten. Versuche es erneut oder starte die App neu. | **Player couldn’t start** — This device’s player couldn’t be initialised. Try again, or restart the app. | Try again, Go back |
| F11 | `decode_error` (T7) | **Dieses Gerät kann das Video nicht dekodieren** — Der Player dieses Geräts konnte das Video nicht dekodieren. Versuche eine andere Version oder spiele mit VLC ab. | **This device can’t decode the video** — The player on this device couldn’t decode this video. Try another version or play with VLC. | Choose another version, Play with VLC, Go back |
| F12 | `encrypted_media` (T8) | **Video ist verschlüsselt** — Diese Version ist kopiergeschützt und lässt sich nicht abspielen. Wähle eine andere Version. | **Video is encrypted** — This version is copy-protected and can’t be played. Choose another version. | Choose another version, Go back |
| F13 | `player_load_failed` (T11) | **Player konnte nicht laden** — Ein Teil des Players konnte nicht geladen werden. Lade die Seite neu oder starte die App neu. | **Player couldn’t load** — Part of the player couldn’t be loaded. Reload the page or restart the app. | Try again, Go back |
| F14 | `video_stalled` (T7) | **Das Bild ist hängen geblieben** — Das Bild blieb stehen, obwohl die Wiedergabe weiterlief. Versuche eine andere Version oder eine niedrigere Qualität. | **The picture got stuck** — The picture stopped although playback kept running. Try another version or a lower quality. | Choose another version, Play with VLC, Go back |
| F15 | `engine_error` (T7) | **Der Player hat angehalten** — Der Player dieses Geräts konnte das Video nicht weiter abspielen. Versuche eine andere Version oder spiele mit VLC ab. | **The player stopped** — The player on this device couldn’t continue with this video. Try another version or play with VLC. | Choose another version, Play with VLC, Go back |
| F16 | `unexpected_format` (T6) | **Unerwartete Antwort vom Server** — Der Server hat etwas geschickt, das kein Video ist, zum Beispiel von einem Proxy oder einer Anmeldeseite. Prüfe das Netzwerk und versuche es erneut. | **Unexpected answer from the server** — The server sent something that isn’t video, for example from a proxy or a sign-in page. Check the network and try again. | Try again, Choose another version, Go back |
| F17 | `decoder_reclaimed` (T6) | **Eine andere App hat das Video übernommen** — Eine andere App oder das System hat die Videowiedergabe dieses Geräts übernommen. Versuche es erneut. | **Another app took over the video** — Another app or the system took over video playback on this device. Try again. | Try again, Choose another version, Go back |
| F18 | `media_damaged` (T7) | **Das Video ist hier beschädigt** — Die Videodaten sind an dieser Stelle kaputt. Neu laden und eine andere Wiedergabeart kamen nicht darüber hinweg. Versuche eine andere Version. | **The video is damaged here** — The video data is broken at this spot. Playing it again and another way did not get past it. Try another version. | Choose another version, Play with VLC, Go back |
| F19 | `cleartext_not_permitted` (T11) | **Unverschlüsselte Verbindung blockiert** — Dieses Gerät spielt nicht über eine unverschlüsselte http://-Verbindung. Verwende die https://-Adresse des Servers. | **Unencrypted connection blocked** — This device refuses to play over an unencrypted http:// connection. Use the server’s https:// address. | Try again, Go back |
| F20 | `vlc_error` (T7) | **VLC konnte diese Datei nicht abspielen** — VLC hat mit einem Fehler abgebrochen. Eine andere Wiedergabeart wird versucht; sonst wähle eine andere Version. | **VLC could not play this file** — VLC stopped with an error. Another way to play is tried; otherwise choose another version. | Choose another version, Play with VLC, Go back |
| F21 | `vlc_dialog` (T7) | **VLC hat eine Rückfrage gestellt** — VLC hat angehalten und nach einem Zertifikat, einer Anmeldung oder einer fehlenden Komponente gefragt. Die App versucht eine andere Wiedergabeart; klappt das nicht, wähle eine andere Version. | **VLC asked a question** — VLC stopped to ask for a certificate, a login or a missing component. The app tries another way to play; if that fails, choose another version. | Choose another version, Play with VLC, Go back |
| F22 | `playback_stalled` (T5) | **Wiedergabe stockt immer wieder** — Das Video lädt langsamer, als es abgespielt wird. Versuche eine niedrigere Qualität oder eine andere Version. | **Playback keeps stopping** — The video loads slower than it plays. Try a lower quality or another version. | Lower quality, Choose another version, Go back |
| F23 | `picture_timeout` (T7) | **Kein Bild erschienen** — Der Player hat das Video geladen, aber kein Bild gezeigt. Versuche eine andere Version oder spiele mit VLC ab. | **The picture didn’t appear** — The player loaded the video but showed no picture. Try another version or play with VLC. | Try again, Choose another version, Play with VLC, Go back |
| F24 | `seek_stalled` (T5) | **Springen hängt** — Das Video ging nach dem Sprung nicht weiter. Versuche es erneut oder wähle eine niedrigere Qualität. | **Seeking got stuck** — The video didn’t continue after the jump. Try again or choose a lower quality. | Lower quality, Choose another version, Go back |
| F25 | `picture_black` (T7) | **Kein Bild** — Die Wiedergabe lief, aber dieses Gerät hat kein Bild gezeigt. Versuche eine andere Version oder spiele mit VLC ab. | **No picture** — Playback ran, but this device showed no picture. Try another version or play with VLC. | Choose another version, Play with VLC, Go back |
| F26 | `picture_frozen` (T7) | **Das Bild ist eingefroren** — Das Bild blieb stehen, obwohl die Wiedergabe weiterlief. Versuche eine andere Version oder eine niedrigere Qualität. | **The picture froze** — The picture stopped although playback kept running. Try another version or a lower quality. | Choose another version, Play with VLC, Go back |
| F27 | `audio_silent` (T7) | **Kein Ton** — Die Wiedergabe lief, aber es kam kein Ton. Versuche eine andere Tonspur oder eine andere Version. | **No sound** — Playback ran, but no sound came through. Try another audio track or another version. | Choose another version, Play with VLC, Go back |
| F28 | `playback_slideshow` (T5) | **Das Gerät kommt nicht hinterher** — Es wurden zu viele Bilder ausgelassen, um flüssig zu schauen. Versuche eine niedrigere Qualität. | **This device can’t keep up** — Too many frames were dropped to watch smoothly. Try a lower quality. | Lower quality, Choose another version, Go back |
| F29 | `player_internal_error` (T11) | **Interner Fehler im Player** — In der App ist beim Abspielen etwas schiefgelaufen. Erneut versuchen macht dort weiter, wo du warst; passiert es wieder, melde den Code unten. | **The player hit an internal error** — Something in the app went wrong while playing. Retry continues where you were; if it happens again, report the code below. | Try again, Go back |
| F30 | `step_timeout` (T6) | **Der Server hat zu lange gebraucht** — Der Server hat das Video nicht rechtzeitig bereitgestellt. Versuche es erneut oder wähle eine andere Version. | **The server took too long** — The server didn’t get the video ready in time. Try again or choose another version. | Try again, Choose another version, Go back |
| F31 | `stream_interrupted` (T1) | **Der Stream wurde abgebrochen** — Die Verbindung zum Server brach vor dem Ende des Videos ab. Erneut versuchen macht dort weiter, wo es aufgehört hat. | **The stream was cut off** — The connection to the server broke before the end of the video. Retry continues where it stopped. | Try again, Go back |
| F32 | `audio_rendition_failed` (T7) | **Der Ton konnte nicht geladen werden** — Der Server konnte den Ton dieser Version nicht liefern, auch nicht umgewandelt. Versuche es erneut oder wähle eine andere Version. | **The sound couldn’t be loaded** — The server couldn’t deliver the sound of this version, not even converted. Try again or choose another version. | Try again, Choose another version, Go back |
| F33 | `network_intercepted` (T1) | **Das Netzwerk fängt die Verbindung ab** — Etwas zwischen diesem Gerät und dem Server hat statt des Servers geantwortet — oft eine WLAN-Anmeldeseite. Melde dich im Netzwerk an und versuche es dann erneut. | **The network intercepts the connection** — Something between this device and the server answered instead of the server — often a Wi-Fi sign-in page. Sign in to the network, then try again. | Try again, Go back |
| F34 | `start_stuck` (T6) | **Der Server hängt beim Vorbereiten** — Das Vorbereiten des Videos dauert viel länger als üblich. Versuche es erneut oder wähle eine andere Version. | **The server got stuck preparing the video** — Preparing this video took far longer than usual. Try again or choose another version. | Try again, Choose another version, Go back |
| F35 | `audio_decode_error` (T7) | **Ton lässt sich nicht abspielen** — Der Player konnte den Ton dieses Videos nicht dekodieren. Versuche eine andere Tonspur oder eine andere Version. | **This device can’t play the sound** — The player couldn’t decode the audio of this video. Try another audio track or another version. | Choose another version, Play with VLC, Go back |
| F36 | `subtitle_unavailable` (T6) | **Untertitel nicht geladen** — Der Server konnte diese Untertitel nicht liefern. Wähle andere Untertitel oder versuche es später erneut. | **Subtitles couldn’t be loaded** — The server couldn’t deliver these subtitles. Choose other subtitles or try again later. | Try again, Choose another version, Go back |
| F37 | `subtitle_timeout` (T6) | **Untertitel kamen zu spät** — Die Untertitel kamen nicht rechtzeitig an. Sie werden gleich noch einmal versucht. | **Subtitles took too long** — The subtitles didn’t arrive in time. They’ll be tried again in a moment. | Try again, Choose another version, Go back |
| F38 | `subtitle_unreadable` (T8) | **Untertitel sind beschädigt** — Diese Untertiteldatei lässt sich nicht lesen. Wähle andere Untertitel. | **Subtitles are damaged** — This subtitle file can’t be read. Choose other subtitles. | Choose another version, Go back |
| F39 | `empty_media` (T8) | **Diese Version enthält nichts zum Abspielen** — Die Datei dieser Version ist leer oder kürzer als eine Sekunde. Wähle eine andere Version. | **This version has nothing to play** — The file of this version is empty or shorter than a second. Choose another version. | Choose another version, Go back |
| F40 | `delivery_interrupted` (T6) | **Der Stream bricht immer wieder ab** — Der Server antwortet, aber der Videostream bricht immer wieder ab. Versuche es erneut oder wähle eine andere Version. | **The stream keeps breaking off** — The server answers, but the video stream keeps breaking off. Try again or choose another version. | Try again, Choose another version, Go back |
| F41 | `invalid_device_profile` (T11) | **Gerät nicht unterstützt** — Der Server konnte nicht lesen, was dieses Gerät abspielen kann. Aktualisiere die App. | **Device not supported** — The server couldn’t read what this device can play. Update the app. | Go back |
| F42 | `invalid_playback_request` (T11) | **Wiedergabe abgelehnt** — Der Server hat diese Wiedergabe-Anfrage abgelehnt. Aktualisiere die App oder versuche es erneut. | **Playback request rejected** — The server rejected this playback request. Update the app or try again. | Go back |
| F43 | `playback_not_found` (T2) | **Wiedergabe beendet** — Diese Wiedergabe ist beendet oder abgelaufen. Starte sie neu, um an derselben Stelle weiterzuschauen. | **Playback ended** — This playback has ended or expired. Start it again to continue where you left off. | Try again, Go back |
| F44 | `too_many_streams` (T9) | **Zu viele Streams** — Dieses Profil schaut bereits auf einem anderen Gerät. Beende die Wiedergabe dort, um hier zu schauen. | **Too many streams** — This profile is already watching on another device. Stop playback there to watch here. | Go back |
| F45 | `too_many_playbacks` (T4) | **Zu viele Wiedergaben** — Es werden zu viele Wiedergaben vorbereitet. Beende eine und versuche es erneut. | **Too many playbacks** — Too many playbacks are being prepared. Stop one and try again. | Try again, Go back |
| F46 | `release_dead` (T8) | **Version nicht verfügbar** — Dieser Version und den an ihrer Stelle versuchten Versionen fehlen Daten. Wähle eine andere Version. | **Version unavailable** — This version and the versions tried in its place are missing data. Choose another version. | Choose another version, Go back |
| F47 | `repair_failed` (T8) | **Reparatur fehlgeschlagen** — Der Server konnte diese Version nicht reparieren. Wähle eine andere Version. | **Repair failed** — The server couldn’t repair this version. Choose another version. | Choose another version, Go back |
| F48 | `no_versions` (T8) | **Keine Versionen gefunden** — Der Server hat keine Version dieses Titels gefunden. | **No versions found** — The server found no version of this title. | Choose another version, Go back |
| F49 | `release_not_found` (T8) | **Version nicht gefunden** — Diese Version gehört nicht mehr zu diesem Titel. Wähle eine andere Version. | **Version not found** — This version doesn’t belong to the title anymore. Choose another version. | Choose another version, Go back |
| F50 | `transcoding_not_allowed` (T9) | **Umwandlung nicht erlaubt** — Diese Version müsste umgewandelt werden, was für dieses Profil nicht erlaubt ist. Wähle eine andere Version. | **Conversion not allowed** — This version would need a conversion, which isn’t allowed for this profile. Choose another version. | Go back |
| F51 | `transcoding_unavailable` (T6) | **Umwandlung nicht verfügbar** — Diese Version muss umgewandelt werden, aber der Server kann gerade kein Video umwandeln. | **Conversion unavailable** — This version needs a conversion, but the server can’t convert video right now. | Try again, Choose another version, Go back |
| F52 | `no_playable_method` (T7) | **Auf diesem Gerät nicht abspielbar** — Keine Wiedergabeart passt zu diesem Gerät. Versuche eine andere Version. | **Can’t play on this device** — No playback method fits this device. Try another version. | Choose another version, Play with VLC, Go back |
| F53 | `no_more_methods` (T7) | **Keine Möglichkeiten mehr** — Alle Wiedergabearten wurden versucht. Versuche eine andere Version. | **No more options** — Every way to play was tried. Try another version. | Choose another version, Play with VLC, Go back |
| F54 | `unknown_audio_stream` (T11) | **Tonspur nicht gefunden** — Diese Version hat keine solche Tonspur. | **Audio track not found** — This version has no such audio track. | Try again, Go back |
| F55 | `unknown_subtitle_stream` (T11) | **Untertitel nicht gefunden** — Diese Version hat keine solche Untertitelspur. | **Subtitle track not found** — This version has no such subtitle track. | Try again, Go back |
| F56 | `transcode_capacity` (T4) | **Server ist ausgelastet** — Der Server wandelt gerade zu viele Videos um. Versuche es gleich noch einmal. | **Server is busy** — The server is converting too many videos right now. Try again in a moment. | Try again, Go back |
| F57 | `remux_capacity` (T4) | **Server ist ausgelastet** — Der Server bereitet gerade zu viele Streams vor. Versuche es gleich noch einmal. | **Server is busy** — The server is preparing too many streams right now. Try again in a moment. | Try again, Go back |
| F58 | `probe_failed` (T8) | **Datei nicht lesbar** — Der Server konnte diese Version nicht lesen. Versuche eine andere Version. | **File can’t be read** — The server couldn’t read this version. Try another version. | Choose another version, Go back |
| F59 | `stream_expired` (T2) | **Zugang abgelaufen** — Der Zugang zu diesem Video ist abgelaufen. Starte die Wiedergabe neu, um an derselben Stelle weiterzuschauen. | **Access expired** — The access to this video expired. Start playback again to continue where you left off. | Try again, Go back |
| F60 | `no_playable_file` (T8) | **Keine Videodatei** — Diese Version enthält keine abspielbare Videodatei. Wähle eine andere Version. | **No video file** — This version contains no playable video file. Choose another version. | Choose another version, Go back |
| F61 | `invalid_release` (T8) | **Fehlerhafte Version** — Diese Version ist nicht verwendbar. Wähle eine andere Version. | **Broken version** — This version can’t be used. Choose another version. | Choose another version, Go back |
| F62 | `nzb_fetch_failed` (T8) | **Quelle nicht verfügbar** — Der Server konnte diese Version nicht abrufen. Versuche es erneut oder wähle eine andere Version. | **Download source unavailable** — The server couldn’t fetch this version. Try again or choose another version. | Choose another version, Go back |
| F63 | `nzb_host_not_allowed` (T9) | **Quelle blockiert** — Der Server erlaubt die Quelle dieser Version nicht. Wähle eine andere Version. | **Download source blocked** — The server doesn’t allow this version’s source. Choose another version. | Go back |
| F64 | `usenet_unreachable` (T6) | **Quelle nicht erreichbar** — Der Server erreicht seine Quelle gerade nicht. Versuche es später erneut. | **Source unreachable** — The server can’t reach its download source right now. Try again later. | Try again, Choose another version, Go back |
| F65 | `resolve_failed` (T8) | **Version nicht vorbereitet** — Der Server konnte diese Version nicht vorbereiten. Versuche es erneut oder wähle eine andere Version. | **Version couldn’t be prepared** — The server couldn’t prepare this version. Try again or choose another version. | Choose another version, Go back |
| F66 | `playback_failed` (T6) | **Wiedergabe fehlgeschlagen** — Diese Version ließ sich nicht abspielen. Wähle eine andere Version oder eine niedrigere Qualität. | **Playback failed** — This version couldn’t be played. Try another version or a lower quality. | Try again, Choose another version, Go back |
| F67 | `segment_timeout` (T5) | **Umwandlung zu langsam** — Der Server konnte das Video nicht schnell genug umwandeln. Versuche eine niedrigere Qualität. | **Conversion too slow** — The server couldn’t convert the video fast enough. Try a lower quality. | Lower quality, Choose another version, Go back |
| F68 | `transcode_failed` (T6) | **Umwandlung fehlgeschlagen** — Der Server konnte dieses Video nicht umwandeln. Versuche eine andere Version. | **Conversion failed** — The server couldn’t convert this video. Try another version. | Try again, Choose another version, Go back |
| F69 | `start_timeout` (T5) | **Der Server hat zu lange zum Starten gebraucht** — Der Server konnte das Video nicht rechtzeitig bereitstellen. Versuche es erneut oder wähle eine niedrigere Qualität. | **The server took too long to start** — The server couldn’t get this video ready in time. Try again or choose a lower quality. | Lower quality, Choose another version, Go back |
| F70 | `unknown_audio_rendition` (T11) | **Tonspur nicht verfügbar** — Diese Wiedergabe bietet diese Tonspur nicht an. Wähle eine andere oder starte neu. | **Audio track not available** — This playback doesn’t offer that audio track. Pick another one or start again. | Try again, Go back |
| F71 | `rendition_split_failed` (T6) | **Tonspur fehlgeschlagen** — Der Server konnte diese Tonspur nicht vorbereiten. Versuche es erneut oder wähle eine andere. | **Audio track failed** — The server couldn’t prepare this audio track. Try again or pick another one. | Try again, Choose another version, Go back |
| F72 | `unknown_stream` (T2) | **Stream beendet** — Der Server hat diesen Stream geschlossen. Starte die Wiedergabe neu, um weiterzuschauen. | **Stream ended** — The server closed this stream. Start playback again to continue. | Try again, Go back |
| F73 | `stream_capacity` (T4) | **Server ist ausgelastet** — Der Server streamt gerade zu viel. Versuche es gleich noch einmal. | **Server is busy** — The server is streaming too much right now. Try again in a moment. | Try again, Go back |
| F74 | `unknown_transcode` (T2) | **Stream auf dem Server beendet** — Der Server hat diesen Stream nicht mehr, zum Beispiel nach einem Neustart. Starte die Wiedergabe neu, um weiterzuschauen. | **Stream ended on the server** — The server no longer has this stream, for example after a restart. Start playback again to continue. | Try again, Go back |
| F75 | `unknown_segment` (T8) | **Teil des Videos fehlt** — Der Server hat für diese Stelle kein Video. Versuche eine andere Version. | **Part of the video is missing** — The server has no video for this position. Try another version. | Choose another version, Go back |
| F76 | `end_of_stream` (T8) | **Video endet zu früh** — Das Video endet vor seiner angegebenen Länge. Versuche eine andere Version. | **Video ends early** — The video ended before its announced length. Try another version. | Choose another version, Go back |
| F77 | `session_closed` (T2) | **Stream auf dem Server beendet** — Der Server hat diesen Stream beim Laden geschlossen. Starte die Wiedergabe neu, um weiterzuschauen. | **Stream ended on the server** — The server closed this stream while it was loading. Start playback again to continue. | Try again, Go back |
| F78 | `segment_evicted` (T6) | **Teil des Videos entfernt** — Der Server hat diesen Teil entfernt, um Platz zu schaffen. Versuche es gleich noch einmal. | **Part of the video was removed** — The server removed this part to free space. Try again in a moment. | Try again, Choose another version, Go back |
| F79 | `init_unavailable` (T6) | **Video noch nicht bereit** — Der Server konnte den Anfang des Videos nicht rechtzeitig vorbereiten. Versuche es erneut oder wähle eine niedrigere Qualität. | **Video not ready yet** — The server couldn’t prepare the start of the video in time. Try again or choose a lower quality. | Try again, Choose another version, Go back |
| F80 | `segment_unavailable` (T6) | **Video noch nicht bereit** — Der Server konnte diesen Teil des Videos nicht rechtzeitig vorbereiten. Versuche es erneut oder wähle eine niedrigere Qualität. | **Video not ready yet** — The server couldn’t prepare this part of the video in time. Try again or choose a lower quality. | Try again, Choose another version, Go back |
| F81 | `too_many_sessions` (T4) | **Server ist ausgelastet** — Der Server bereitet gerade zu viele Videos vor. Versuche es gleich noch einmal. | **Server is busy** — The server is preparing too many videos right now. Try again in a moment. | Try again, Go back |
| F82 | `ffmpeg_unavailable` (T6) | **Umwandlung nicht verfügbar** — Der Server kann gerade keine Videos umwandeln (der Umwandler fehlt). Versuche eine andere Version. | **Conversion not available** — The server can’t convert videos right now (its converter is missing). Try another version. | Try again, Choose another version, Go back |
| F83 | `transcoding_disabled` (T9) | **Umwandlung ausgeschaltet** — Die Umwandlung ist auf diesem Server ausgeschaltet. Versuche eine andere Version oder spiele mit VLC ab. | **Conversion turned off** — Video conversion is turned off on this server. Try another version or play with VLC. | Go back |
| F84 | `invalid_transcode_request` (T11) | **Anfrage nicht angenommen** — Der Server hat die Umwandlungsanfrage dieser App nicht angenommen. Aktualisiere die App oder melde den Code. | **Request not accepted** — The server didn’t accept the conversion request from this app. Update the app or report the code. | Go back |
| F85 | `remux_not_possible` (T7) | **Direkt-Stream nicht möglich** — Dieses Video lässt sich für dieses Gerät nicht umpacken. Versuche eine andere Version. | **Direct stream not possible** — This video can’t be repackaged for this device. Try another version. | Choose another version, Play with VLC, Go back |
| F86 | `no_video_stream` (T8) | **Kein Bild in der Datei** — Diese Version enthält kein Video. Wähle eine andere Version. | **No picture in this file** — This version contains no video. Choose another version. | Choose another version, Go back |
| F87 | `unknown_duration` (T8) | **Länge unbekannt** — Der Server kann die Länge dieses Videos nicht bestimmen und es deshalb nicht umwandeln. Wähle eine andere Version. | **Length unknown** — The server can’t tell how long this video is, so it can’t convert it. Choose another version. | Choose another version, Go back |
| F88 | `viewer_not_found` (T3) | **Konto nicht gefunden** — Dieses Konto gibt es auf dem Server nicht mehr. Melde dich erneut an. | **Account not found** — This account no longer exists on the server. Sign in again. | Sign in again, Go back |

### Reason line (server `params.reason`)

| Reason | de | en |
|---|---|---|
| `transcoding_disabled` | Das Umwandeln von Videos ist auf diesem Server ausgeschaltet. | Converting videos is turned off on this server. |
| `ffmpeg_unavailable` | Der Videoumwandler des Servers ist nicht installiert. | The server’s video converter isn’t installed. |
| `no_local_listener` | Auf dem Server läuft kein lokaler Umwandler. | The server has no local converter running. |
| `too_many_sessions` | Der Server wandelt bereits so viele Videos um, wie er gleichzeitig kann. | The server converts as many videos as it can at once. |
| `insufficient_disk` | Der Speicher des Servers ist voll. | The server's disk is full. |

Unknown reasons read “Grund: xyz” / “Reason: xyz”.

### Card actions

| Action | de | en |
|---|---|---|
| `retry` | Erneut versuchen | Try again |
| `otherVersion` | Andere Version wählen | Choose another version |
| `lowerQuality` | Niedrigere Qualität | Lower quality |
| `useVlc` | Mit VLC abspielen | Play with VLC |
| `signIn` | Erneut anmelden | Sign in again |
| `back` | Zurück | Go back |

## What was tried (W)

Heading “Was versucht wurde” / “What was tried”; one line per ladder step that ran, with the time.

| Row | State | de | en | Action | Shows when | Clears when |
|---|---|---|---|---|---|---|
| W01 | Ladder step W in the card’s list | Gewartet | Waited | — | failure card after the ladder ran | with the card |
| W02 | Ladder step R in the card’s list | Neu geladen bei 42:10 | Reloaded at 42:10 | — | failure card after the ladder ran | with the card |
| W03 | Ladder step N in the card’s list | Neu gestartet bei 42:10 | Restarted at 42:10 | — | failure card after the ladder ran | with the card |
| W04 | Ladder step Q in the card’s list | Niedrigere Qualität | Lower quality | — | failure card after the ladder ran | with the card |
| W05 | Ladder step S in the card’s list | Andere Wiedergabeart | Another way to play | — | failure card after the ladder ran | with the card |
| W06 | Ladder step V in the card’s list | Andere Version | Another version | — | failure card after the ladder ran | with the card |
| W07 | Ladder step A in the card’s list | Ton umgewandelt | Converted the audio | — | failure card after the ladder ran | with the card |
| W08 | Ladder step G in the card’s list | Nicht weiter versucht | Stopped trying | — | failure card after the ladder ran | with the card |

## Texts shared on purpose

| Text (en) | Why it is the same |
|---|---|
| Server is busy | transcode/remux/stream capacity and too_many_sessions: all wait and retry |
| Video not ready yet | init_unavailable and segment_unavailable: both retry or lower quality |
| Stream ended on the server | unknown_transcode and session_closed: both start again |
| Signed out | T3 and session_ended: both sign in again |

| Card messages | Why they are the same |
|---|---|
| video_stalled = picture_frozen | the engine (video_stalled) and the watchdog (picture_frozen) report the same frozen picture; titles differ, the advice is the same |
