# Wichtige Befehle — Bot Tantsiura

---

## Täglich: Änderung speichern und deployen

```bash
# 1. Version lokal speichern
git add .
git commit -m "Was wurde geändert"

# 2. Zu GitHub hochladen
git push

# 3. Auf dem Server aktualisieren
ssh root@93.90.200.194 "cd /var/www/nalog && git pull && pm2 restart bot-nalog"
```

**Alles in einer Zeile (Schritt 2 + 3):**
```bash
git push && ssh root@93.90.200.194 "cd /var/www/nalog && git pull && pm2 restart bot-nalog"
```

---

## Versionen verwalten

```bash
# Alle gespeicherten Versionen anzeigen
git log --oneline

# Was hat sich geändert (noch nicht committet)
git diff

# Was ist bereit zum committen
git status

# Einzelne Datei auf letzten commit-Stand zurücksetzen
git checkout -- index.html

# Komplettes Projekt auf eine alte Version zurücksetzen
git checkout abc1234        # abc1234 = ID aus git log

# Zurück zur aktuellen Version
git checkout main
```

---

## Server verwalten

```bash
# SSH-Verbindung zum Server
ssh root@93.90.200.194

# Bot-Status anzeigen
pm2 status

# Bot-Logs anschauen (live)
pm2 logs bot-nalog

# Bot neu starten
pm2 restart bot-nalog

# nginx neu laden (nach Konfigurationsänderung)
systemctl reload nginx
```

---

## Wo was liegt

| Was | Wo |
|---|---|
| Bot-Seite (live) | https://nalog.goeloria.com |
| Code auf GitHub | https://github.com/irynchen/bot-tansiura |
| Dateien auf dem Server | `/var/www/nalog/` |
| nginx-Konfiguration | `/etc/nginx/sites-enabled/nalog` |
| API-Key (geheim!) | `/var/www/nalog/ecosystem.config.js` |

---

## Datenfluss

```
Ihr PC
  │  git commit   → Version lokal gespeichert
  │  git push     → Version zu GitHub hochgeladen
  ▼
GitHub (irynchen/bot-tansiura)
  │  git pull     → Server holt sich die neue Version
  ▼
Server (93.90.200.194)
  │  pm2 restart  → Bot startet neu
  ▼
https://nalog.goeloria.com  ← live für alle sichtbar
```
