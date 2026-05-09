// Einmaliges Script: Варианты вопросов für alle FAQ-Einträge ohne Varianten generieren
// Läuft auf dem Server: node scripts/gen_variants.js
// Benötigt ANTHROPIC_API_KEY in der Umgebung

const https  = require('https');
const fs     = require('fs');
const path   = require('path');

const API_KEY  = process.env.ANTHROPIC_API_KEY || '';
const FAQ_PATH = path.join(__dirname, '..', 'faq.json');

if (!API_KEY) { console.error('ANTHROPIC_API_KEY fehlt'); process.exit(1); }

const SYS = `Ты помощник налогового консультанта в Испании. Твоя задача — сгенерировать варианты вопросов, которые русскоязычные клиенты могут задать боту по данной теме.

ПРАВИЛА:
1. Пиши живым разговорным языком — так, как реально пишут клиенты, не официально.
2. Разные формулировки одного и того же вопроса: короткие, длинные, с испанскими терминами, без них.
3. Включай русские и испанские слова вперемешку — клиенты часто так пишут.
4. 6–14 вариантов. Каждый на отдельной строке. Без нумерации, без тире в начале.
5. Возвращай только список вариантов, без лишнего текста.`;

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: SYS,
      messages: [{ role: 'user', content: prompt }]
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          resolve(parsed.content?.[0]?.text?.trim() || '');
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const faq = JSON.parse(fs.readFileSync(FAQ_PATH, 'utf8'));
  const entries = faq.ru || [];

  const empty = entries.filter(e => !e.questionVariants || !e.questionVariants.trim());
  console.log(`Всего статей: ${entries.length} | Без вариантов вопросов: ${empty.length}`);
  if (!empty.length) { console.log('Все уже заполнены.'); return; }

  let done = 0;
  for (const entry of empty) {
    const topic = entry.topic || '—';
    const keys  = (entry.keys || []).join(', ');
    const answerText = (entry.answer || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800);

    let prompt = `Тема: ${topic}`;
    if (keys)       prompt += `\nКлючевые слова: ${keys}`;
    if (answerText) prompt += `\n\nКраткое содержание ответа:\n${answerText}`;

    process.stdout.write(`[${done + 1}/${empty.length}] ${topic.slice(0, 60)}… `);
    try {
      const raw = await callClaude(prompt);
      if (raw) {
        entry.questionVariants = raw;
        console.log(`✓ (${raw.split('\n').filter(Boolean).length} вариантов)`);
      } else {
        console.log('⚠ пустой ответ');
      }
    } catch(e) {
      console.log(`✗ ошибка: ${e.message}`);
    }
    done++;
    if (done < empty.length) await sleep(500);
  }

  fs.writeFileSync(FAQ_PATH, JSON.stringify(faq, null, 2), 'utf8');
  console.log(`\nГотово. faq.json обновлён (${done} статей обработано).`);
}

main().catch(e => { console.error(e); process.exit(1); });
