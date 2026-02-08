/**
 * Telegram Bot Authentication Script
 *
 * Verifies the bot token works by calling getMe().
 * Set TELEGRAM_BOT_TOKEN as an environment variable.
 *
 * Usage: TELEGRAM_BOT_TOKEN=your-token npx tsx src/telegram-auth.ts
 */
import { Bot } from 'grammy';

async function authenticate(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error(
      '✗ TELEGRAM_BOT_TOKEN not set.\n\n' +
        '  1. Message @BotFather on Telegram\n' +
        '  2. Send /newbot and follow the prompts\n' +
        '  3. Copy the token and add to .env:\n' +
        '     TELEGRAM_BOT_TOKEN=your-token-here\n',
    );
    process.exit(1);
  }

  const bot = new Bot(token);
  const me = await bot.api.getMe();

  console.log(`\n✓ Telegram bot authenticated!`);
  console.log(`  Bot: @${me.username} (${me.first_name})`);
  console.log(`  ID: ${me.id}\n`);
  console.log(`  You can now start NanoClaw with: npm run dev\n`);
}

authenticate().catch((err) => {
  console.error('Authentication failed:', err.message);
  process.exit(1);
});
