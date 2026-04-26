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

### 1. Lokal ändern und committen
```bash
# Datei bearbeiten, dann:
git add .
git commit -m "Beschreibung der Änderung"
git push
```

### 2. Auf den Server hochladen
```bash
scp bot-tantsiura-ru.html root@93.90.200.194:/var/www/nalog/index.html
```

> Alternativ (wenn Git auf dem Server eingerichtet ist):
> ```bash
> ssh root@93.90.200.194 "cd /var/www/nalog && git pull && pm2 restart bot-nalog"
> ```

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
