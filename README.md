# Bot Tantsiura — Chat-Bot für nalog.goeloria.com

Virtueller Assistent für Alexander Tantsiura (Buchhalter, Alicante 🇪🇸).  
Beantwortet Fragen zu Steuern und Buchhaltung in Spanien auf Russisch und Spanisch.

---

## Architektur

```
Browser → https://nalog.goeloria.com
              ↓
           nginx (Port 443, SSL via Let's Encrypt)
              ↓                    ↓
        /           →   /var/www/nalog/index.html  (Bot-UI)
        /api/chat   →   localhost:3000  (Node.js Proxy)
              ↓
        api.anthropic.com  (Claude AI)
```

**Server:** STRATO VPS Linux VC2-4, Ubuntu 22.04  
**IP:** 93.90.200.194  
**Domain:** nalog.goeloria.com  
**SSL:** Let's Encrypt (automatische Erneuerung via Certbot, läuft bis 2026-07-25)

---

## Dateien

| Datei | Beschreibung |
|---|---|
| `bot-tantsiura-ru.html` | Bot-UI (wird als `index.html` auf dem Server gespeichert) |
| `server.js` | Node.js Proxy-Server — leitet `/api/chat` an Claude API weiter |
| `ecosystem.config.js` | PM2-Konfiguration mit API-Key (nur auf dem Server, nicht im Git!) |
| `.gitignore` | Schützt `key.txt` und `ecosystem.config.js` vor Git |

---

## Zugang

### Server (SSH)
```bash
ssh root@93.90.200.194
# Passwort: STRATO Root-Passwort
```

### GitHub
Repository: https://github.com/irynchen/bot-tansiura  
Account: `irynchen` (privater Account)  
Token: in GitHub unter Settings → Developer settings → Personal access tokens  
Token-Name: `bot-tansiura-deploy`

### Anthropic API
Console: https://console.anthropic.com  
API-Key: in GitHub unter Settings → Secrets NICHT gespeichert — liegt nur in `/var/www/nalog/ecosystem.config.js` auf dem Server

---

## Bot-Prozess auf dem Server verwalten

```bash
ssh root@93.90.200.194

# Status prüfen
pm2 status

# Logs anschauen
pm2 logs bot-nalog

# Bot neu starten
pm2 restart bot-nalog

# Bot stoppen
pm2 stop bot-nalog
```

---

## Änderungen deployen

### Workflow: lokal → GitHub → Server

```
1. Datei lokal bearbeiten (index.html oder server.js)
2. git add .
3. git commit -m "Was geändert wurde"
4. git push
5. ssh root@93.90.200.194 "cd /var/www/nalog && git pull && pm2 restart bot-nalog"
```

**Kurzversion (Schritt 4+5 zusammen):**
```bash
git push && ssh root@93.90.200.194 "cd /var/www/nalog && git pull && pm2 restart bot-nalog"
```

### Warum dieser Weg?
- `git commit` → speichert eine Version lokal (Verlauf, Rückgängig machen möglich)
- `git push` → lädt die Version auf GitHub (Backup, sichtbar im Browser)
- `git pull` auf dem Server → Server holt die neue Version von GitHub
- `pm2 restart` → Bot startet neu mit den neuen Dateien

---

## API-Key erneuern

Falls der Anthropic API-Key gesperrt oder abgelaufen ist:

1. Neuen Key erstellen: https://console.anthropic.com/settings/keys
2. Auf dem Server eintragen:
```bash
ssh root@93.90.200.194
nano /var/www/nalog/ecosystem.config.js
# ANTHROPIC_API_KEY ersetzen, speichern mit Ctrl+O → Enter → Ctrl+X
pm2 restart bot-nalog
```

---

## FAQ erweitern

Die FAQ-Antworten stehen direkt in `bot-tantsiura-ru.html`:
- `FAQ_RU` — russische Antworten (ab Zeile ~408)
- `FAQ_ES` — spanische Antworten (ab Zeile ~491)

Jeder Eintrag hat:
- `keys` — Schlüsselwörter die die Frage erkennen
- `topic` — Name für die Statistik
- `answer` — HTML-Antwort

---

## nginx-Konfiguration

```
/etc/nginx/sites-enabled/nalog
```

Zertifikate:
```
/etc/letsencrypt/live/nalog.goeloria.com/fullchain.pem
/etc/letsencrypt/live/nalog.goeloria.com/privkey.pem
```
