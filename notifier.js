import './env.js';

export async function sendTelegramNotification(message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;

    if (!botToken || !chatId) {
    console.error('[TELEGRAM] Відсутній TELEGRAM_BOT_TOKEN або TELEGRAM_CHAT_ID. ' +
      'Перевірте файл .env поруч з notifier.js або системні змінні середовища.');
    return;
  }

const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true }
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP error! status: ${response.status} | ${body}`);
  }
}