# KI-Generierungslogik im Admin-Portal — Bot Tantsiura

Dieses Dokument beschreibt, wie die KI-Buttons im FAQ-Artikel-Editor funktionieren.
Stand: Mai 2026.

---

## Grundprinzip

Jeder Button generiert **genau ein Feld** und überschreibt nur dieses Feld.
Alle Buttons nutzen **alles, was bereits ausgefüllt ist**, als Kontext — je mehr ausgefüllt ist, desto besser das Ergebnis.

Das Minimum für jeden Button ist immer: **Тема (Überschrift)** muss ausgefüllt sein.

---

## Die drei generierbaren Felder

### 1. Варианты вопросов — Fragevarianten

**Was ist das?**
Realistische Formulierungen, wie Kunden dieselbe Frage stellen könnten.
Dieses Feld wird dem Kunden **nie angezeigt** — es dient ausschließlich der internen Suche.

**Button:** `✨ Сгенерировать варианты`

**Input (alles Verfügbare):**
- Тема *(Pflicht)*
- Ключевые слова *(falls vorhanden)*
- Ответ *(falls vorhanden)*

**Output:** mehrzeiliger Text, jede Zeile = eine Frageformulierung

**Wann drücken?**
- Direkt nach dem Ausfüllen der Тема — als ersten Schritt
- Oder nach dem Schreiben des Ответ, wenn man sich Inspirationen für Varianten holen möchte

**Beispiel:**
```
Тема: Кому autónomo выставляет фактуру при оплате через Stripe, PayPal или Deel?

→ generiert z.B.:
Можно ли выставить фактуру на платёжную систему?
Нужно ли делать фактуру на Stripe?
PayPal считается моим клиентом?
Если деньги пришли через Stripe, кому выставлять invoice?
Deel — это клиент или посредник?
Кому делать счёт: клиенту или платёжной системе?
```

---

### 2. Ключевые слова — Schlüsselwörter

**Was ist das?**
Kurze Such-Begriffe (1–2 Wörter), die helfen, den Artikel zu finden.
Sowohl auf Russisch als auch auf Spanisch.

**Button:** `✨ Сгенерировать ключевые слова`

**Input (alles Verfügbare):**
- Тема *(Pflicht)*
- Варианты вопросов *(falls vorhanden — beste Quelle für echte Nutzersprache)*
- Ответ *(falls vorhanden)*

**Output:** Tags (ersetzt bestehende Tags komplett)

**Regeln für die Generierung:**
- 8–15 Schlüsselwörter
- Max. 2 Wörter pro Begriff (z.B. `modelo 303` ✓, `налог на роскошь` ✗)
- Keine Präpositionen oder langen Phrasen
- Immer beide Sprachen: Russisch + Spanisch
- Abkürzungen, Formularnummern, Synonyme einbeziehen

**Wann drücken?**
- Nachdem Тема und Варианты вопросов ausgefüllt sind — dann hat die KI die beste Grundlage
- Oder direkt nach dem Schreiben eines Ответ (Тема + Ответ reichen auch)

**Beispiel:**
```
Тема: Кому autónomo выставляет фактуру при оплате через Stripe, PayPal или Deel?
Варианты: [wie oben]

→ generiert z.B.:
stripe, paypal, deel, factura, invoice, платёжная система,
посредник, клиент, заказчик, autónomo
```

---

### 3. Ответ — Antworttext

**Was ist das?**
Der formatierte HTML-Antworttext, der dem Kunden angezeigt wird.

**Button:** `✨ Сгенерировать ответ` / `✨ Улучшить и форматировать`

Der **Button-Text ändert sich automatisch** je nachdem ob der Editor leer ist:

| Zustand des Editors | Button-Text | Was passiert |
|---|---|---|
| **Leer** | `✨ Сгенерировать ответ` | KI schreibt Antwort von Grund auf |
| **Hat Text** | `✨ Улучшить и форматировать` | KI verbessert und formatiert den vorhandenen Text |

#### Modus A: Generieren (Editor leer)

**Input:**
- Тема *(Pflicht)*
- Варианты вопросов *(falls vorhanden — hilft der KI den Kontext zu verstehen)*
- Ключевые слова *(falls vorhanden)*

**Output:** vollständiger HTML-Antworttext

**Wann nutzen?**
- Wenn man noch keinen Text hat und die KI einen ersten Entwurf schreiben soll
- Idealerweise nachdem Тема + Варианты + Keywords schon ausgefüllt sind

#### Modus B: Verbessern (Editor hat Text)

**Was macht "Verbessern" konkret?**
- Behält den **Inhalt und die Fakten** des vorhandenen Textes
- Verbessert **Formulierungen** (klarer, präziser, weniger juristisch-formal)
- Wandelt in das **korrekte HTML-Format** um:
  - Fachbegriffe/Formularnummern → `<span class="term">Begriff</span>`
  - Listen → `🔹 Punkt 1<br>🔹 Punkt 2`
  - Absätze → durch `<br><br>` getrennt
  - Wichtiger Hinweis am Ende → `<strong>Совет...</strong>`
  - Kein `<ul>`, `<li>`, kein Markdown

**Input:**
- Vorhandener Text im Editor *(Pflicht — sonst wäre es "Generieren")*
- Тема *(immer als Kontext)*
- Варианты вопросов *(falls vorhanden)*
- Ключевые слова *(falls vorhanden)*

**Typischer Anwendungsfall:**
```
Admin kopiert einen Text aus einem anderen Dokument oder schreibt schnell
einen Rohtext → drückt "Улучшить и форматировать" → KI formatiert korrekt
und verbessert den Stil, ohne Fakten zu ändern
```

---

## Empfohlener Workflow: Von leer zum fertigen Artikel

```
1. Тема eingeben
       ↓
2. ✨ Варианты вопросов generieren → prüfen, ggf. bearbeiten
       ↓
3. ✨ Ключевые слова generieren → prüfen, ggf. ergänzen
       ↓
4. ✨ Ответ сгенерировать → prüfen, ggf. manuell korrigieren
       ↓
5. ✨ Улучшить и форматировать (optional, wenn man den Text überarbeitet hat)
       ↓
6. ☑ Проверено Александром setzen
       ↓
7. Speichern
```

---

## Alternativer Workflow: Vorhandener Text

```
1. Тема eingeben
2. Text in Ответ einfügen (aus Dokument, Notiz, o.ä.)
3. ✨ Улучшить и форматировать → formatiert und verbessert
4. ✨ Ключевые слова generieren → aus Тема + Ответ
5. ✨ Варианты вопросов generieren → aus allem
6. ☑ Проверено Александром setzen
7. Speichern
```

---

## Was Keywords NICHT generiert (wichtig!)

Der Antwort-Button (`aiFormat`) generiert **keine Keywords mehr als Nebeneffekt**.
Keywords werden nur durch den dafür vorgesehenen Button aktualisiert.

Früher (bis Mai 2026) hat `✨ Генерировать с ИИ` gleichzeitig Antwort UND Keywords
generiert — mit anderem Regelwerk als der Keywords-Button. Das führte zu inkonsistenten
Ergebnissen. Jetzt ist beides sauber getrennt.

---

## Suchgewichtung (wie der Bot die FAQ findet)

Wenn ein Kunde eine Frage stellt, durchsucht der Bot die FAQ nach diesen Gewichten:

| Feld | Gewicht | Warum |
|---|---|---|
| Варианты вопросов | 5 (höchster) | Echte Kundenformulierungen |
| Тема | 4 (hoch) | Semantischer Kern des Artikels |
| Ключевые слова | 2 (mittel) | Kurze Begriffe und Fachsprache |
| Пункты меню | 1 (niedrig) | Navigationshilfe |

Der Antworttext selbst fließt **nicht** in die Suche ein, damit der Bot sich nicht an
zufälligen Wörtern aus langen Texten festbeißt.

---

## Feldübersicht im Formular

```
Тема                          ← Titel / Überschrift (Pflicht)
Ключевые слова  [✨ Gen.]     ← Such-Tags (1–2 Wörter, ru + es)
Варианты вопросов [✨ Gen.]   ← Kundenformulierungen (nur intern, nie sichtbar)
Пункты меню                   ← Navigation in der Mini App
Ответ           [✨ Gen./Verb.]← Antworttext (HTML-formatiert)
☑ Проверено Александром       ← Freigabe-Häkchen
```

---

## Für Alexander: Was er beim Befüllen beachten sollte

1. **Тема** — so formulieren, wie die kanonische Antwort-Überschrift klingt.
   Vollständig, nicht zu kurz.

2. **Варианты вопросов** — KI generiert, aber Alexander kann und soll ergänzen.
   Besonders Formulierungen aus echten Kundengesprächen sind Gold wert.

3. **Ключевые слова** — KI generiert, Alexander prüft ob spanische Begriffe stimmen.

4. **Ответ** — Entweder von KI generieren lassen, oder eigenen Text schreiben und
   dann "Улучшить" drücken. Alexander sollte den Text immer fachlich prüfen.

5. **Häkchen "Проверено"** — erst setzen, wenn Alexander den Inhalt fachlich
   freigegeben hat. Nur dann erscheint `✅ Проверено Александром` im Bot.
