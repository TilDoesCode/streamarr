// German narrative of detail-concept.html; F holds the rendered frames.
export function DOC(F) {
  const shot = (img, cap) => `<figure class="shot"><img src="data:image/jpeg;base64,${img}" alt=""><figcaption>${cap}</figcaption></figure>`;
  return `<main class="doc">
<header>
<div class="kicker">Streamarr · D2 · Konzept · 2. Oktober 2026</div>
<h1>Inhalt zuerst.<br>Technik auf Abruf.</h1>
<p class="lead">Ein neues Konzept für die Detailseite auf großen Bildschirmen: Fernseher (Android TV, Apple TV), iPad und Tablets, Web am Desktop. Gleiches Layout überall, nur die Eingabe unterscheidet sich. Aurora bleibt die Bildsprache, die Signal-Spec-Labels bleiben, nichts davon braucht neue Server-Endpunkte.</p>
<div class="quote"><q>Mir gefällt es nicht, dass auf großen displays die versionen immer direkt so sichtbar sind. Der Platz sollte lieber content genutzt werden. Versionen sind im optimal fall ein technisches Detail wo man nicht so oft ran muss. Bei Serien sollten die Episoden nebeneinander unten am screen sein. Eine auszuwählen führt dann dazu, dass sich die Beschreibung und die buttons oben daran anpassen und die Episode unten markiert wird. Dort kann dann (über ein sheet) die Version wählen oder einfach auf Play drücken. Infos zu der serie werden dort auch angezeigt, aber kleiner (eventuell im Space rechts)</q>
<p>Deine Anfrage nach dem F4-Review. Dieses Dokument ist nur Konzept, gebaut wird in F7, nachdem du eine Variante gewählt hast.</p></div>
<nav class="toc">
<a href="#ausgang"><b>1 · Ausgangslage</b>Was heute stört</a>
<a href="#varianten"><b>2 · Drei Varianten</b>und die Empfehlung</a>
<a href="#film"><b>3 · Film</b>alle Zustände</a>
<a href="#sheet"><b>4 · Versions-Sheet</b>TV, iPad, Web</a>
<a href="#serie"><b>5 · Serie</b>Folgen-Streifen</a>
<a href="#fokus"><b>6 · TV-Fokus</b>Wege und Menu-Kette</a>
<a href="#formate"><b>7 · iPad, Web, Tablet</b>Fenstergrößen</a>
<a href="#zustaende"><b>8 · Laden, Fehler, Telefon</b></a>
<a href="#f7"><b>9 · Umsetzung F7</b>Komponenten, Daten, Slices</a>
<a href="#fragen"><b>10 · Offene Fragen</b>für dich</a>
</nav>
</header>

<section class="sec" id="ausgang"><span class="sl-num">1 · Ausgangslage</span><h2>Heute gehört ein Drittel des Bildschirms der Technik</h2>
<div class="grid4">
${shot(F.__cur.ipadSeries, 'iPad Pro 13, Sherlock: Folgen als lange Liste unter dem Text, rechts dauerhaft „Versionen“.')}
${shot(F.__cur.atvVersions, 'Apple TV 1080p: das Panel ist 760 pt breit und fängt die Hälfte der Fokuswege ein.')}
${shot(F.__cur.gtvSintel, 'Google TV: drei Versionskarten mit Release-Namen, Gründen und Health, ohne dass man sie braucht.')}
${shot(F.__cur.atvNoVersion, 'Apple TV ohne Version: ein großes leeres Panel als Platzhalter.')}
</div>
<div class="grid2">
<div class="card"><h4>Was die heutige Seite tut</h4><ul>
<li>Das <b>Versions-Panel</b> (760 pt, Glas) steht immer rechts, auch wenn es nichts zu wählen gibt. Es zeigt Release-Namen, Gründe und Health: Wissen für Ausnahmefälle.</li>
<li>Bei <b>Serien</b> stehen Staffel-Chips und Folgen als <b>vertikale Zeilen</b> unter dem Text in einer Scroll-Spalte; sichtbar sind ein bis zwei Folgen. Der Text oben beschreibt die Serie, gespielt wird aber eine Folge.</li>
<li>„Versionen“ an einer Folgenzeile schaltet das Panel auf diese Folge um; auf dem TV springt der Fokus quer über den Bildschirm.</li>
<li>Die Menu-Kette auf Apple TV kann den Fokus nicht aus dem Panel zurückholen (I3, JS kann nach Menu keinen Fokus setzen).</li>
</ul></div>
<div class="card"><h4>Ziele für das neue Konzept</h4><ul>
<li><b>Inhalt zuerst:</b> Bild, Titel, Beschreibung, Folgen. Technik nur als eine kompakte Zeile („4K · HDR10 verfügbar · spielt hier in 1080p“).</li>
<li><b>Play ist Play:</b> der Hauptbutton spielt die empfohlene Version. Versionen öffnen sich als <b>Sheet</b>, nur wenn man wählen will.</li>
<li><b>Folgen nebeneinander unten.</b> Die gewählte Folge bestimmt Titel, Text, Specs und Buttons oben und ist unten markiert.</li>
<li><b>Serieninfos klein rechts</b>, mit „Mehr“ für den ganzen Text.</li>
<li><b>Eine Seite</b> für TV, iPad und Web, nur die Eingabe unterscheidet sich; jede Fokusbewegung funktioniert auf Apple TV allein über die Geometrie.</li>
</ul></div></div>
</section>

<section class="sec" id="varianten"><span class="sl-num">2 · Varianten</span><h2>Drei Wege, die Seite zu ordnen</h2>
<p>Alle drei erfüllen deine Punkte: Versionen in einem Sheet, Folgen nebeneinander unten, Play spielt direkt. Sie unterscheiden sich darin, was die Seite beim Öffnen zeigt und wie viel sich beim Wandern durch die Folgen bewegt.</p>
${F.v1}
<div class="grid3">
<div class="card rec"><h4>1 · Bühne <span class="tag ok">Empfehlung</span></h4><ul><li>Eine Seite ohne Scrollen: Text und Buttons links, Serieninfo klein rechts, Staffeln und Folgen unten.</li><li>Der Hintergrund bleibt das Serienbild, nur der Text wechselt mit der Folge.</li><li>Alle Fokuswege sind gerade Reihen: Buttons, Staffeln, Folgen.</li><li><b>Kontra:</b> die Serienbeschreibung ist auf vier Zeilen gekürzt, der Rest liegt hinter „Mehr zur Serie“.</li></ul></div>
<div class="card"><h4>2 · Ebenen</h4><ul><li>Beim Öffnen nur Serie und Play, wie ein Kino-Plakat. Runter scrollt zu großen Folgenkarten mit Beschreibung, „Über die Serie“ und einem Technik-Abschnitt.</li><li><b>Pro:</b> sehr ruhig, Folgen mit viel Text.</li><li><b>Kontra:</b> die Folgen sind beim Öffnen nicht zu sehen (nur angedeutet), Seite scrollt auf dem TV (auf Apple TV unter der Tab-Leiste heikel), Technik wieder auf der Seite statt im Sheet.</li></ul></div>
<div class="card"><h4>3 · Spotlight</h4><ul><li>Das Standbild der gewählten Folge wird zum Hintergrund, alle Staffeln laufen in einem kleinen Streifen durch.</li><li><b>Pro:</b> jede Folge fühlt sich eigen an.</li><li><b>Kontra:</b> Bild wechselt bei jedem Schritt (unruhig, teuer auf Android-TV-GPUs), Standbilder sind oft klein oder fehlen, Serieninfo nur noch eine Zeile, Staffelgrenzen unklar.</li></ul></div>
</div>
<div class="frames2">${F.v2}${F.v3}</div>
<div class="card rec" style="margin-top:8px"><h4>Empfehlung: Variante 1 · Bühne</h4><p>Sie setzt deine Beschreibung am direktesten um (Folgen unten nebeneinander, Text und Buttons oben folgen der Auswahl, Serieninfo klein rechts), bleibt ruhig, weil sich nur Text bewegt, und braucht keinen einzigen Fokusweg, der auf Apple TV nicht allein über die Geometrie geht. Filme bekommen dieselbe Bühne ohne Streifen: der Text sitzt unten links, das Bild hat die obere Hälfte. Die folgenden Abschnitte beschreiben nur noch diese Variante.</p></div>
</section>

<section class="sec" id="film"><span class="sl-num">3 · Empfohlen · Film</span><h2>Film: das Bild oben, alles Nötige unten links</h2>
<table class="t"><thead><tr><th>Zone</th><th>Inhalt (1920 × 1080 logische pt)</th></tr></thead><tbody>
<tr><td>Hintergrund</td><td>Backdrop rechts oben (88 % Breite), weich nach links und unten ausgeblendet, darunter das Aurora-Ambient (Unschärfe 70, Tint des Titels). Keine Fläche ist „leer“, das Bild ist der Inhalt.</td></tr>
<tr><td>Text (links, x = 168, unten bündig 96 über dem Rand)</td><td>Typ-Pille „Film“, Logo (sonst Titel 92 pt Outfit), Fakten · FSK-Box · Spec-Labels (Signal, JetBrains Mono), <b>eine</b> Technikzeile wenn bestes Bild und Wiedergabe hier auseinanderliegen, Beschreibung 3 Zeilen, Fortschritt, Buttons.</td></tr>
<tr><td>Buttons</td><td><b>Abspielen</b> / <b>Fortsetzen</b> / <b>Erneut ansehen</b> (weiß) · <b>Von vorne</b> (nur mit Fortschritt) · <b>Versionen · N</b> (ab 2 Versionen; bei einer: <b>Details</b>; bei keiner: entfällt) · Gesehen-Haken. Abstand 28 pt (F6-Fokusabstand).</td></tr>
<tr><td>Details (rechts, 460 breit, unten bündig mit den Buttons)</td><td>Glas mit Rauch-Unterlage nach der TV-Glasregel (Text ≥ 4,5:1, groß ≥ 3:1 über dem hellsten Bildteil): Originaltitel, Regie/Drehbuch/Besetzung (aus <code>people</code>), TMDB-Bewertung. „Mehr“ öffnet die volle Beschreibung und Besetzung im selben Sheet-Muster.</td></tr>
<tr><td>Technikzeile</td><td>Regel aus deiner Entscheidung: Karten zeigen die Specs der besten Version; die Detailseite nennt beides, wenn es sich unterscheidet: „4K · HDR10 verfügbar · spielt hier in 1080p“. Ein Methoden-Hinweis („Transkodierung“, „Wiedergabe mit VLC“) erscheint <b>nur</b>, wenn die empfohlene Version nicht direkt oder per Direkt-Stream läuft.</td></tr>
</tbody></table>
${F.mDefault}
<div class="frames2">${F.mResume}${F.mStates}</div>
</section>

<section class="sec" id="sheet"><span class="sl-num">4 · Versions-Sheet</span><h2>Versionen: ein Sheet, nur wenn man wählen will</h2>
<p>Das Sheet enthält, was heute im Panel steht: alle Versionen nach Rang, Badges (Empfohlen, Zuletzt gespielt, Wird gespielt), Titel „1080p · BluRay“, Spec-Labels, Größe · Bitrate · Alter, Health als Signal-Balken mit Wort, lokaler Zustand (Sofort / Wird vorbereitet), die erwartete Methode als Pille mit höchstens zwei Gründen in Klartext (auch VLC: „Der eingebaute Player kann AV1 nicht abspielen“) und den Release-Namen in Mono. Neu oben: die beiden Specs nebeneinander („Bestes Bild 4K · HDR10 · Auf diesem Gerät 1080p SDR“).</p>
${F.sheetTv}
<div class="frames2">${F.sheetIpad}${F.sheetWeb}</div>
<table class="t"><thead><tr><th></th><th>TV (Android TV, Apple TV)</th><th>iPad / Tablet</th><th>Web Desktop</th></tr></thead><tbody>
<tr><td>Öffnen</td><td>„Versionen“-Button; im Folgen-Streifen <b>Select halten</b> (Versionen dieser Folge)</td><td>„Versionen“-Button; lange auf eine Folge drücken → Kontextmenü „Versionen…“</td><td>„Versionen“-Button, Taste <span class="kbd">V</span>, Rechtsklick/Kontextmenü auf eine Folge</td></tr>
<tr><td>Form</td><td>Glas-Seitenblatt rechts, 780 breit, Seite dahinter gedimmt</td><td>natives <code>formSheet</code> (Liquid Glass ab iOS 26), mittig</td><td>Schublade rechts, 740 breit, Seite gedimmt</td></tr>
<tr><td>Erster Fokus</td><td>die Version, die Play spielen würde (Empfohlen, sonst Zuletzt gespielt)</td><td>–</td><td>Schließen-Button (Tastatur), Karten per Tab/Pfeil</td></tr>
<tr><td>Auswahl</td><td>Select spielt diese Version (mit Fortsetzen-Punkt) und schließt</td><td>Tippen spielt</td><td>Klick oder Enter spielt</td></tr>
<tr><td>Schließen</td><td>Menu/Zurück, nativ (eigene Route) → Fokus zurück auf den Öffner</td><td>✕, nach unten wischen</td><td><span class="kbd">Esc</span>, ✕, Klick daneben; Fokus zurück auf den Öffner</td></tr>
<tr><td>Fokusfalle</td><td>ja: Hoch/Runter zwischen Karten, Links/Rechts gesperrt; Liste mit fester Höhe (tvOS-Regel)</td><td>modal</td><td><code>aria-modal</code>, Tab bleibt drin</td></tr>
<tr><td>Route</td><td colspan="3">die bestehende <code>versions/[workId]</code> (heute iPhone-formSheet) wird auf allen Geräten das Sheet; Präsentation pro Plattform: <code>transparentModal</code> auf TV und Web (eigene Glas-Fläche), <code>formSheet</code> auf iPhone und iPad.</td></tr>
</tbody></table>
</section>

<section class="sec" id="serie"><span class="sl-num">5 · Empfohlen · Serie</span><h2>Serie: die Folgen liegen unten, oben steht immer die gewählte</h2>
${F.sInit}
<div class="grid2">
<div class="card"><h4>Was oben steht</h4><ul>
<li>Serien-Logo (klein, 62 hoch) als Anker, darunter die Pille „Staffel 1 · Folge 2 · Als Nächstes“.</li>
<li>Folgentitel (56 pt Outfit), Laufzeit · Erstausstrahlung · Spec-Labels der Folge (<code>spec</code> aus der Staffel-Liste), Technikzeile nur bei Unterschied (aus den Versionen dieser Folge).</li>
<li>Beschreibung der Folge (3 Zeilen), Fortschritt, Buttons für <b>diese</b> Folge: Fortsetzen/Abspielen, Von vorne, Versionen · N, Gesehen.</li>
<li>Rechts „Über die Serie“: Beschreibung 4 Zeilen, 2010 – 2014 · 3 Staffeln · 9 Folgen, Genres, Bewertung · FSK · Sender, Fortschritt „1 von 9 gesehen“, „Mehr zur Serie“.</li></ul></div>
<div class="card"><h4>Was unten steht</h4><ul>
<li>Staffel-Chips „Staffel 1 · 1/3“ (aktive weiß), Specials als letzter Chip, rechts „Folge 2 von 3“.</li>
<li>Folgenkarten 352 × 198 mit Standbild, Nummer + Titel, Laufzeit / „Noch 34 Min.“ / „Gesehen“. Badges: „Als Nächstes“, Haken, Fortschrittsbalken, „Keine Version“.</li>
<li><b>Markiert</b> (die Folge, die oben steht): heller Rand und ein weißer Strich unter dem Titel. <b>Fokus</b>: Skalierung 1,1, 4-pt-Ring, Tint-Glühen. Beides ist unterscheidbar, auch wenn der Fokus oben bei den Buttons ist.</li>
<li>Beim Öffnen ist die nächste Folge (<code>watch.nextEpisode</code>) markiert und der Streifen so gescrollt, dass sie links an der Kante steht.</li></ul></div></div>
${F.sStrip}
<div class="card"><h4>Entscheidung: Fokus wählt aus, Select spielt</h4>
<p>Auf dem TV <b>markiert der Fokus</b> eine Folge: oben wechseln Titel, Text, Specs und Buttons nach 150 ms Ruhe (dieselbe Verzögerung wie der Hero auf Start). <b>Select spielt</b> die fokussierte Folge (mit Fortsetzen-Punkt, empfohlene Version), <b>Select halten</b> öffnet ihr Versions-Sheet, <b>Hoch</b> führt über die Staffeln zu den Buttons, die dann für die markierte Folge gelten.</p>
<p><b>Warum nicht „Select wählt aus und springt zu Play“?</b> Auf Apple TV kann JS den Fokus nicht versetzen (I3: <code>requestTVFocus</code>, <code>destinations</code> und <code>nextFocus*</code> wirken unter der nativen Tab-Leiste nicht). Ein Select, das nur markiert, würde den Fokus im Streifen lassen und wäre ein Klick ohne sichtbare Wirkung. Fokus-Vorschau kennt man schon vom Start-Hero, und der kürzeste Weg zum Abspielen bleibt ein Klick.</p>
<p><b>iPad und Web</b> haben keinen Fokus, der „vorbeiwandert“: dort wählt <b>Tippen/Klicken</b> eine Folge aus (markiert, oben aktualisiert), und die markierte Karte zeigt einen ▶-Knopf, der sie spielt. Am Web erscheint ▶ zusätzlich bei Hover, Doppelklick spielt ebenfalls, Enter spielt die Karte mit Tastaturfokus.</p></div>
${F.sS3}
<table class="t"><thead><tr><th>Fall</th><th>Verhalten</th></tr></thead><tbody>
<tr><td>Viele Folgen (z. B. 24)</td><td>Der Streifen scrollt horizontal; auf dem TV bleibt die fokussierte Karte ab der zweiten an der zweiten Position (x = 552), damit links immer eine Folge Kontext gibt. Rechts „Folge 12 von 24“. Am Ende der Staffel eine kleine Karte „Weiter mit Staffel 2 ›“ (Select wechselt die Staffel).</td></tr>
<tr><td>Staffelwechsel</td><td>Nur mit Select/Tippen/Klick, <b>nicht</b> beim Fokussieren: sonst würde der Weg von den Folgen nach oben zu Play die Staffel umschalten. Neue Staffel: Markierung auf die erste ungesehene Folge der Staffel, sonst Folge 1.</td></tr>
<tr><td>Specials (Staffel 0)</td><td>als letzter Chip „Specials“, nie vorausgewählt.</td></tr>
<tr><td>Noch nicht ausgestrahlt</td><td>Karte ohne Standbild-Glanz, Unterzeile „Ab 12. Jan. 2027“, oben statt Play ein fokussierbarer, wirkungsloser Hinweis (wie „Noch keine Version“ aus F4).</td></tr>
<tr><td>Keine Version</td><td>Karte gedimmt mit „Keine Version“ (aus <code>versionCount = 0</code>), oben die gelbe Zeile und „Noch keine Version“. Die Folge bleibt auswählbar (Beschreibung lesen).</td></tr>
<tr><td>Lange Titel</td><td>Karte: eine Zeile mit Auslassung; oben: der volle Titel, zwei Zeilen möglich, die Beschreibung kürzt sich dann auf zwei Zeilen (feste Gesamthöhe, nichts springt).</td></tr>
<tr><td>Alles gesehen</td><td>Markiert ist S1 · F1, Hauptbutton „Erneut ansehen“, Fortschritt rechts „9 von 9 gesehen“.</td></tr>
<tr><td>Fehlende Standbilder</td><td>Serien-Backdrop als Ausschnitt mit Folgennummer groß in Outfit, kein leeres Grau.</td></tr>
</tbody></table>
</section>

<section class="sec" id="fokus"><span class="sl-num">6 · TV-Fokus</span><h2>Jeder Weg ist eine gerade Linie</h2>
${F.fmap}
<div class="legend"><span><i style="background:#FFD166"></i>Pfeiltasten</span><span><i style="background:#FF9AA8"></i>Zurück / Menu</span><span>① erster Fokus</span></div>
<table class="t"><thead><tr><th>Element</th><th>Hoch</th><th>Runter</th><th>Links</th><th>Rechts</th><th>Select</th><th>Halten / Play-Taste</th></tr></thead><tbody>
<tr><td>Buttons</td><td>– (Apple TV: Tab-Leiste)</td><td>Staffel-Chips</td><td>voriger Button; am ersten: Rail (Android TV, Web)</td><td>nächster Button; am letzten: „Über die Serie“</td><td>Aktion</td><td>Play-Taste spielt die markierte Folge</td></tr>
<tr><td>Über die Serie / Details</td><td>– (Apple TV: Tab-Leiste)</td><td>die Karte direkt darunter im Streifen (Geometrie); Android TV lenkt per Guide auf die markierte Folge</td><td>letzter Button</td><td>–</td><td>öffnet „Über die Serie“ im Sheet</td><td>–</td></tr>
<tr><td>Staffel-Chips</td><td>Buttons (der zuletzt fokussierte)</td><td>Folgen-Streifen (markierte Folge)</td><td>voriger Chip</td><td>nächster Chip</td><td>Staffel wechseln</td><td>–</td></tr>
<tr><td>Folgenkarte</td><td>Staffel-Chips</td><td>–</td><td>vorige Folge (an der ersten: Rail)</td><td>nächste Folge</td><td>diese Folge spielen</td><td>Halten: Versionen dieser Folge · Play-Taste: spielen</td></tr>
<tr><td>Versions-Sheet</td><td>vorige Version</td><td>nächste Version</td><td>gesperrt</td><td>gesperrt</td><td>Version spielen</td><td>–</td></tr>
</tbody></table>
<h3>Menu / Zurück</h3>
<table class="t"><thead><tr><th>Wo</th><th>Android TV, Web-Tastatur (Esc / Backspace)</th><th>Apple TV (Menu)</th></tr></thead><tbody>
<tr><td>Sheet offen</td><td>schließt, Fokus auf dem Öffner (Versionen-Button oder Folgenkarte)</td><td>schließt (native Modal-Route), UIKit stellt den Fokus auf dem Öffner wieder her</td></tr>
<tr><td>Folgen-Streifen, Staffel-Chips</td><td>Streifen scrollt zur markierten Folge zurück, Fokus auf den Hauptbutton (JS-Fokus wirkt auf Android TV)</td><td>verlässt die Seite (Pop der Detail-Route). JS kann nach Menu keinen Fokus setzen (I3), ein abgefangenes Menu ohne Fokuswechsel würde dich einsperren.</td></tr>
<tr><td>Buttons</td><td>verlässt die Seite (zurück zur vorigen, Fokus dort auf der geöffneten Karte)</td><td>verlässt die Seite</td></tr>
</tbody></table>
<p class="muted">Option für später (natives Arbeitspaket, Rebuild): eine Menu-Stufe „Streifen → Buttons“ auch auf Apple TV über <code>preferredFocusEnvironments</code> am Tab-Screen. Das Konzept braucht sie nicht.</p>
<div class="grid2">
<div>${F.atv}</div>
<div class="card"><h4>Regeln, damit es auf Apple TV allein über Geometrie geht</h4><ul>
<li>Drei Reihen mit gemeinsamer linker Kante x = 168: Buttons, Staffel-Chips, Folgen. Runter/Hoch trifft immer etwas direkt darunter oder darüber, nie diagonal.</li>
<li>„Über die Serie“ liegt <b>unten bündig mit den Buttons</b> (gleiche Höhe), damit Rechts vom letzten Button es trifft.</li>
<li>Jede Reihe ist ein <code>FocusGuide</code> mit <code>autoFocus</code> (merkt sich das zuletzt fokussierte Kind). Beim ersten Betreten des Streifens liegt die markierte Folge an der linken Kante, also trifft auch die reine Geometrie sie.</li>
<li>Der Streifen ist eine horizontale Liste mit <b>expliziter Höhe</b> (I3: Listen in Guides brauchen sie).</li>
<li>Fokusabstand: Karten 32 pt (Skalierung 1,1 = 17,6 pt + 4-pt-Ring), Buttons 28 pt, zwischen Chips und Karten 22 pt. Das ist die F6-Regel <code>focus.clearance</code>.</li>
<li>Kein Element muss per Code fokussiert werden; der erste Fokus ist ein <code>hasTVPreferredFocus</code> auf dem Hauptbutton.</li></ul></div></div>
</section>

<section class="sec" id="formate"><span class="sl-num">7 · iPad, Web, Tablet</span><h2>Eine Seite, die nach unten hängt</h2>
<p>Alles ist von unten verankert: Folgen-Streifen 60 pt über dem Rand, darüber Staffeln, darüber Text und Buttons. Wird das Fenster höher (iPad, fast quadratische Tablets), gewinnt nur das Bild oben. Wird es schmaler, entfällt zuerst die rechte Spalte („Mehr zur Serie“ wird ein Button), unter ~500 pt übernimmt die Telefon-Shell.</p>
${F.ipadL}
<div class="portrait-row">${F.ipadP}<div>${F.ipadW}${F.square}</div></div>
${F.web1280}
${F.web1920}
<table class="t"><thead><tr><th></th><th>TV</th><th>iPad / Tablet (Touch)</th><th>Web (Zeiger + Tastatur)</th></tr></thead><tbody>
<tr><td>Folge auswählen</td><td>Fokus</td><td>Tippen</td><td>Klick; Tastatur: Pfeile im Streifen (roving tabindex)</td></tr>
<tr><td>Folge spielen</td><td>Select, Play-Taste</td><td>▶ auf der markierten Karte, oder Play oben</td><td>▶ bei Hover / auf der markierten Karte, Doppelklick, Enter</td></tr>
<tr><td>Versionen</td><td>Button, Select halten</td><td>Button, lange drücken</td><td>Button, <span class="kbd">V</span>, Rechtsklick</td></tr>
<tr><td>Zurück</td><td>Menu / Zurück</td><td>Zurück-Knopf oben links (F6), Wischen vom Rand</td><td>Zurück-Knopf, Browser-Zurück, <span class="kbd">Esc</span> schließt nur das Sheet</td></tr>
<tr><td>Streifen scrollen</td><td>folgt dem Fokus</td><td>wischen</td><td>Rad/Trackpad, ‹ › an den Enden bei Hover</td></tr>
</tbody></table>
</section>

<section class="sec" id="zustaende"><span class="sl-num">8 · Laden, Fehler, Telefon</span><h2>Nichts springt, Fehler bleiben lokal</h2>
<div class="frames2">${F.loading}${F.error}</div>
<div class="phone-row">${F.phone}<div class="card"><h4>Telefone: keine Änderung</h4><p>Das Telefon hat das Problem nicht: dort ist die Version heute schon eine einzelne, zuklappbare Zeile mit Sheet, und Folgen in einer vertikalen Liste passen zum Daumen. F7 fasst die Telefon-Seiten nicht an. Was sich trotzdem teilt: die neue Technikzeile (beide Specs) und das Sheet sind dieselben Komponenten.</p><p class="muted">Falls du es doch willst: ein waagrechter Folgen-Streifen auf dem Telefon wäre möglich, kostet aber die Beschreibung pro Folge in der Liste. Nicht empfohlen.</p></div></div>
</section>

<section class="sec" id="f7"><span class="sl-num">9 · Umsetzung F7</span><h2>Was gebaut werden muss</h2>
<h3>Komponenten</h3>
<table class="t"><thead><tr><th>Datei</th><th>Änderung</th></tr></thead><tbody>
<tr><td><code>screens/detail/large-detail.tsx</code></td><td>umbauen zur „Bühne“: von unten verankerte Zonen (Text, Info rechts, Staffeln, Streifen), Copy-Breite 880, Movie-Variante ohne Streifen; <code>DETAIL.panelWidth</code> entfällt.</td></tr>
<tr><td><code>browse/version-panel.tsx</code></td><td><code>VersionPanel</code> (dauerhaftes Panel) <b>entfernen</b>; <code>VersionPanelCard</code> bleibt und wird die Karte im Sheet. <code>usePanelEntry</code> und <code>PanelExitContext</code> entfallen.</td></tr>
<tr><td><code>screens/detail/version-sheet-screen.tsx</code></td><td>wird das Sheet für alle Geräte: TV-Glas-Seitenblatt, Web-Schublade, iPad/iPhone formSheet; neue Kopfzeile „Bestes Bild · Auf diesem Gerät“; Fokusfalle + feste Listenhöhe auf TV.</td></tr>
<tr><td><code>app/(app)/_layout.tsx</code></td><td><code>versions/[workId]</code>: Präsentation je Plattform (<code>transparentModal</code> TV/Web, <code>formSheet</code> iOS) und optional <code>about/[workId]</code> für „Mehr zur Serie“ im gleichen Muster.</td></tr>
<tr><td>neu <code>browse/episode-strip.tsx</code></td><td>horizontale Liste (FlashList horizontal mit fester Höhe), <code>EpisodeCard</code> mit Zuständen markiert/fokussiert/hover/gesehen/Fortschritt/keine Version/nicht ausgestrahlt, ▶-Overlay für Touch/Zeiger, Halten → Versionen.</td></tr>
<tr><td>neu <code>browse/season-chips.tsx</code></td><td>aus den <code>GlassChip</code>s in <code>series-screen.tsx</code>; wechselt nur per Select; Zähler rechts.</td></tr>
<tr><td>neu <code>browse/title-info.tsx</code></td><td>„Über die Serie“ / „Details“ (Glas nach der TV-Glasregel, fokussierbar, öffnet das About-Sheet).</td></tr>
<tr><td><code>browse/title-actions.tsx</code></td><td>Buttons pro markierter Folge; „Versionen · N“ / „Details“ / entfällt; Fokusabstand aus F6.</td></tr>
<tr><td><code>browse/version-summary.tsx</code></td><td>liefert die Technikzeile (beide Specs) und den Methoden-Hinweis nur bei Transkodierung/VLC.</td></tr>
<tr><td><code>screens/detail/series-screen.tsx</code></td><td>State „markierte Folge“ (Start: <code>nextEpisode</code>), Vorschau mit 150 ms Debounce, Versionen der markierten Folge laden (wie heute <code>panelEpisode</code>); <code>episode-list.tsx</code> bleibt nur für Telefone.</td></tr>
<tr><td><code>movie-screen.tsx</code>, <code>season-screen.tsx</code></td><td>Movie auf die Bühne; die Staffel-Route öffnet die Serie mit vorgewählter Staffel.</td></tr>
</tbody></table>
<h3>Daten pro Folge — alles da</h3>
<table class="t"><thead><tr><th>Brauchen wir</th><th>Quelle</th><th>Status</th></tr></thead><tbody>
<tr><td>Titel, Nummer, Beschreibung, Laufzeit, Erstausstrahlung, ausgestrahlt, Standbild, Bewertung</td><td><code>GET …/series/{id}/seasons/{n}</code> → <code>CatalogEpisodeDto</code></td><td><span class="tag ok">vorhanden</span></td></tr>
<tr><td>Fortschritt, gesehen</td><td><code>episode.watch</code> (<code>progressPercent</code>, <code>played</code>)</td><td><span class="tag ok">vorhanden</span></td></tr>
<tr><td>Spec-Labels der Folge</td><td><code>episode.spec</code> (nach einem Versions-Lookup; mit <code>availability=true</code> gefüllt)</td><td><span class="tag ok">vorhanden</span> (kann <code>null</code> sein → Labels weglassen)</td></tr>
<tr><td>„Keine Version“</td><td><code>episode.versionCount</code> mit <code>availability=true</code></td><td><span class="tag ok">vorhanden</span> (bis dahin neutral)</td></tr>
<tr><td>Als Nächstes, vorausgewählte Folge</td><td><code>series.watch.nextEpisode</code></td><td><span class="tag ok">vorhanden</span></td></tr>
<tr><td>Beide Specs, Methode, Gründe, „Versionen · N“</td><td><code>GET …/works/{workId}/versions</code> der markierten Folge (debounced, gecacht 5 min)</td><td><span class="tag ok">vorhanden</span></td></tr>
<tr><td>Jahresspanne „2010 – 2014“</td><td>aus <code>seasons[].airDate</code> (erste/letzte reguläre Staffel)</td><td><span class="tag ok">abgeleitet</span></td></tr>
<tr><td>Sender/Netzwerk („BBC One“), Status (läuft/beendet), Ersteller</td><td>nicht im DTO</td><td><span class="tag warn">Lücke</span> optional: <code>networks</code>, <code>status</code>, <code>createdBy</code> auf <code>CatalogSeriesResponse</code> (TMDB liefert sie). Ohne: Zeile entfällt.</td></tr>
<tr><td>Fortschritt pro Staffel „1/3“</td><td><code>seasons[].playedCount</code> / <code>episodeCount</code></td><td><span class="tag ok">vorhanden</span></td></tr>
<tr><td>Folgen-Specs ohne Lookup</td><td>—</td><td><span class="tag warn">Grenze</span> erst nach <code>availability=true</code> oder Warm-up; der Streifen zeigt Specs nur oben, nicht auf den Karten.</td></tr>
</tbody></table>
<h3>Fokus pro Plattform</h3>
<ul>
<li><b>Android TV:</b> drei <code>FocusGuide</code>-Reihen (remember), Zurück-Kette per <code>useBackHandler</code> (Streifen → Hauptbutton → Seite verlassen), Select-Halten per <code>onLongPress</code>.</li>
<li><b>Apple TV:</b> dieselben Reihen mit <code>autoFocus</code>-Guides, keine Tag-APIs, Sheet als Modal-Route (natives Menu schließt und stellt den Fokus wieder her), Halten über das TV-Event <code>longSelect</code>; Menu außerhalb des Sheets verlässt die Seite.</li>
<li><b>Web:</b> Tab-Reihenfolge Rail → Zurück → Buttons → Info → Chips → Streifen; im Streifen roving tabindex; Sheet als Dialog mit Fokusfalle, <span class="kbd">Esc</span>, Rückgabe des Fokus an den Öffner.</li>
<li><b>iPad:</b> Touch, Kontextmenü (lange drücken), Hardware-Tastatur wie Web (I2-Tasten).</li>
</ul>
<h3>Tests</h3>
<ul>
<li>Unit (jest/RNTL): markierte Folge (Start = nextEpisode, Wechsel bei Fokus/Klick, Staffelwechsel setzt erste ungesehene), Buttons pro Zustand (Fortsetzen/Abspielen/Erneut/keine Version/eine Version), Technikzeile nur bei Unterschied, Methoden-Hinweis nur Transkodierung/VLC, Sheet-Reihenfolge und Erstfokus-Index.</li>
<li>Geräte (Argent): Google TV und Apple TV 4K — Fokuskarte Schritt für Schritt (describe nach jedem Druck), Halten öffnet Sheet, Menu-/Zurück-Kette, Fokus nach Sheet-Schließen, Play aus dem Streifen mit Fortsetzen-Punkt; iPad Pro 13 quer/hoch + Stage-Manager-Fenster; Web 1280 und 1920 (Hover, Tastatur, Esc); Lesbarkeit der Info-Spalte über hellem Bild (BBB).</li>
<li>Regression: Telefon-Detail unverändert, Player öffnet mit derselben Version wie vorher, Deep Links <code>/series/[id]?season=</code>.</li>
</ul>
<h3>Slices</h3>
<ol class="slices">
<li><b>S1 · Sheet überall (M):</b> <code>versions/[workId]</code> als TV-/Web-/iPad-Sheet, Fokusfalle, Kopfzeile beider Specs; Panel bleibt bis S2 parallel.</li>
<li><b>S2 · Film-Bühne (M):</b> neue Large-Detail-Geometrie für Filme, Info rechts, Buttons-Regeln, Panel entfernen, Laden/Fehler.</li>
<li><b>S3 · Folgen-Streifen + Serie (L):</b> Streifen, Chips, markierte Folge, Vorschau, Buttons pro Folge, alle Kartenzustände, Specials, lange Staffeln.</li>
<li><b>S4 · Fokus und Eingaben (M):</b> Android-TV-Zurück-Kette, Apple-TV-Guides, Halten, Web-Tastatur und Hover, iPad-Kontextmenü.</li>
<li><b>S5 · Formate + Abschluss (S):</b> iPad hoch/Fenster, fast quadratisch, Web 1280, About-Sheet, Geräte-Durchlauf und Screenshots.</li>
</ol>
<h3>Risiken</h3>
<ul>
<li><b>Modal-Route auf Apple TV:</b> <code>transparentModal</code> unter NativeTabs muss den Fokus beim Schließen nativ zurückgeben; früh in S1 auf dem Simulator prüfen (Rückfall: <code>card</code>-Präsentation wie der Player).</li>
<li><b>Debounced Versions-Abfragen</b> beim schnellen Wandern durch Folgen: nur die markierte Folge, 150 ms Ruhe, Cache 5 min; Season-Fan-out (<code>availability=true</code>) ist schon gecacht.</li>
<li><b>Glas über hellem Bild</b> (Info-Spalte rechts liegt oft über Gesichtern/Himmel): TV-Glasregel per <code>highlight</code> anwenden, sonst Rauch-Unterlage.</li>
<li><b>Lange-Druck auf tvOS</b> meldet nur den Beginn (I3); reicht für „Halten öffnet Sheet“.</li>
<li><b>Web-Modal-Route:</b> Expo Router rendert Modals im Web als eigene Seite; die Schublade braucht eine eigene Präsentation (Overlay-Layout) oder einen Query-Parameter <code>?versions=</code>.</li>
</ul>
</section>

<section class="sec" id="fragen"><span class="sl-num">10 · Offene Fragen</span><h2>Was du entscheiden solltest</h2>
<ol class="slices">
<li><b>Variante:</b> 1 · Bühne (empfohlen), 2 · Ebenen oder 3 · Spotlight?</li>
<li><b>Select auf einer Folge (TV):</b> spielt sofort (empfohlen) — oder öffnet ein kleines Menü „Abspielen · Von vorne · Versionen“?</li>
<li><b>Filme ohne Streifen:</b> darf die untere Hälfte frei für das Bild bleiben, oder soll dort eine Reihe stehen (z. B. Besetzung; „Ähnliche Titel“ bräuchte einen neuen Endpunkt)?</li>
<li><b>Sender/Status</b> der Serie in der Info-Spalte: lohnt das kleine Server-Feld?</li>
</ol>
</section>
<p class="muted" style="margin-top:56px;font-size:13px">Bilder: Blender Foundation (offene Filme) und Sherlock (BBC) über TMDB, wie in der Dev World; Folgen-Standbilder und deutsche Texte aus der Dev-World-Viewer-API (2. Okt. 2026). Neu bauen: <code>node docs/client/design/src/d2/build.mjs</code>, Renders mit <code>sh docs/client/design/src/d2/render.sh</code>.</p>
</main>`;
}
