# Bot Tantsiura — Chat-Bot für nalog.goeloria.com

Virtueller Assistent für Alexander Tantsiura (Buchhalter, Alicante 🇪🇸).  
Beantwortet Fragen zu Steuern und Buchhaltung in Spanien auf Russisch und Spanisch.

---

## Architektur

```
Browser / Telegram
        ↓
   nginx (Port 443, SSL via Let's Encrypt)
        ↓                    ↓
  /           →   /var/www/nalog/index.html    (Mini App)
  /admin.html →   /var/www/nalog/admin.html    (Admin-Portal)
  /api/*      →   localhost:3000               (Node.js Server)
  /webhook    →   localhost:3000               (Telegram Webhook)
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
| `index.html` | Telegram Mini App — Chat-Interface |
| `admin.html` | Admin-Portal — FAQ, Konfiguration, Statistik |
| `server.js` | Node.js Server — Telegram Webhook, Claude API, Admin-API |
| `Logo_Bot.png` | AT-Logo für Mini App (auf Server als `/at-logo.png` gespeichert) |
| `logo_portal.png` | Logo für Admin-Portal |
| `ecosystem.config.js` | PM2-Konfiguration mit API-Keys (nur auf dem Server, nicht im Git!) |
| `.gitignore` | Schützt `ecosystem.config.js`, `.env`, `stats.json` vor Git |

---

## Telegram Bot

- **Bot:** @TantsiuraTax_Bot  
- **Token:** in `ecosystem.config.js` als `TELEGRAM_BOT_TOKEN`  
- **Webhook:** `https://nalog.goeloria.com/webhook`  
- **Mini App:** `https://nalog.goeloria.com`  
- Begrüßung bei `/start`: 3 tippbare Beispielfragen + Button zum Öffnen der Mini App  
- FAQ-Antworten tragen Badge: `✅ Проверено Александром`  
- KI-Antworten tragen Badge: `💬 Авто-ответ`

---

## Admin-Portal

**URL:** https://nalog.goeloria.com/admin.html  
**Passwort:** in `ecosystem.config.js` als `ADMIN_PASSWORD`

Funktionen:
- **FAQ-Artikel** — erstellen, bearbeiten, löschen; KI-Generierung von Antworten
- **Настройки** — Begrüßungstext, Kontakte, Schnellbuttons, Kategorien, API-Keys
- **Statistik** — Anfragen gesamt, FAQ vs. KI, Token-Verbrauch

> Der Begrüßungstext der Mini App kommt vollständig aus dem Admin-Portal (Настройки → Приветствие).

---

## Zugang

### Server (SSH)
```bash
ssh root@93.90.200.194
```

### GitHub
Repository: https://github.com/irynchen/bot-tansiura  
Account: `irynchen`

### Anthropic API
Console: https://console.anthropic.com  
API-Key: liegt nur in `/var/www/nalog/ecosystem.config.js` auf dem Server

---

## Bot-Prozess verwalten

```bash
ssh root@93.90.200.194

pm2 status              # Status prüfen
pm2 logs bot-nalog      # Logs anschauen
pm2 restart bot-nalog   # Neu starten

# WICHTIG: Bei Änderungen an ecosystem.config.js (Token, Passwort):
pm2 delete bot-nalog && pm2 start /var/www/nalog/ecosystem.config.js
```

---

## Änderungen deployen

```bash
# 1. Lokal bearbeiten, dann:
git add .
git commit -m "Was geändert wurde"

# 2. Push + Deploy in einem Befehl:
git push && ssh root@93.90.200.194 "cd /var/www/nalog && git pull && pm2 restart bot-nalog"
```

---

## API-Key erneuern

```bash
ssh root@93.90.200.194
nano /var/www/nalog/ecosystem.config.js
# ANTHROPIC_API_KEY ersetzen → Ctrl+O → Enter → Ctrl+X
pm2 delete bot-nalog && pm2 start /var/www/nalog/ecosystem.config.js
```

---

## nginx-Konfiguration

```
/etc/nginx/sites-enabled/nalog
```

SSL-Zertifikate:
```
/etc/letsencrypt/live/nalog.goeloria.com/fullchain.pem
/etc/letsencrypt/live/nalog.goeloria.com/privkey.pem
```
