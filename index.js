// node index.js --check
// node index.js --check --debug
// node index.js --test

require('dotenv').config();
const express = require('express');
const { Redis } = require('@upstash/redis');

const CHECK_ONLY = process.argv.includes('--check');
const DEBUG      = process.argv.includes('--debug');
const TEST_SEND  = process.argv.includes('--test');

const app = express();
const PORT = process.env.PORT || 3000;
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MINUTES || '10') * 60 * 1000;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DISCORD_API = 'https://discord.com/api/v9';
const SEEN_KEY = 'discord_quest_alert:seen';
const BLURPLE = 0x5865f2;

if (!CHECK_ONLY && !TEST_SEND) {
  // Keep-alive endpoint pinged by Uptime Robot
  app.get('/', (_req, res) => res.send('Discord Quest Alert is running.'));
  app.listen(PORT, () => console.log(`[${ts()}] Server on port ${PORT}`));
}

function ts() {
  return new Date().toISOString();
}

// Discord timestamp renders as a formatted date/time in the client
function discordTimestamp(iso) {
  const unix = Math.floor(new Date(iso).getTime() / 1000);
  return `<t:${unix}:F>`;
}

async function postAlert(quest) {
  const { id, config } = quest;
  const game    = config.messages?.game_title ?? 'Unknown Game';
  const name    = config.messages?.quest_name;
  const reward  = config.rewards_config?.rewards?.[0]?.messages?.name ?? 'Unknown Reward';
  const expiry  = config.expires_at;
  const color   = config.colors?.primary
    ? parseInt(config.colors.primary.replace('#', ''), 16)
    : BLURPLE;
  const hero    = config.assets?.hero;

  const embed = {
    ...(name && { title: name }),
    url: `https://discord.com/quests/${id}`,
    color,
    ...(hero && { image: { url: `https://cdn.discordapp.com/${hero}` } }),
    fields: [
      { name: 'Game',     value: game,                                      inline: true  },
      { name: 'Reward',   value: reward,                                    inline: true  },
      { name: 'Deadline', value: expiry ? discordTimestamp(expiry) : 'N/A', inline: false },
    ],
    footer: { text: `Quest ID: ${id}` },
    timestamp: new Date().toISOString(),
  };

  const res = await fetch(process.env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (!res.ok) throw new Error(`Webhook POST failed with status ${res.status}`);
}

async function checkQuests(dryRun = false) {
  try {
    const res = await fetch(`${DISCORD_API}/quests/@me`, {
      headers: {
        Authorization: process.env.USER_TOKEN,
        'X-Super-Properties': process.env.X_SUPER_PROPERTIES,
        'X-Discord-Locale': 'en-US',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      },
    });

    if (!res.ok) {
      console.error(`[${ts()}] Quest API returned ${res.status}`);
      return;
    }

    const body = await res.json();

    if (DEBUG) {
      console.log(`[${ts()}] Raw API response:`);
      console.log(JSON.stringify(body, null, 2));
    }

    const { quests = [] } = body;

    const now    = Date.now();
    const active = quests.filter(q => !q.config?.expires_at || new Date(q.config.expires_at).getTime() > now);

    if (dryRun) {
      if (active.length === 0) {
        console.log(`[${ts()}] No active quests found.`);
        return;
      }
      console.log(`[${ts()}] ${active.length} active quest(s) (${quests.length - active.length} expired hidden):`);
      for (const quest of active) {
        const game   = quest.config?.messages?.game_title ?? 'Unknown Game';
        const name   = quest.config?.messages?.quest_name ?? 'Unknown Quest';
        const reward = quest.config?.rewards_config?.rewards?.[0]?.messages?.name ?? 'Unknown Reward';
        const expiry = quest.config?.expires_at ?? 'N/A';
        console.log(`  • [${quest.id}] ${game} — ${name} | Reward: ${reward} | Expires: ${expiry}`);
      }
      return;
    }
    const seenIds  = new Set(await redis.smembers(SEEN_KEY));
    const newQuests = active.filter(q => !seenIds.has(q.id));

    for (const quest of newQuests) {
      await postAlert(quest);
      console.log(`[${ts()}] Alerted: ${quest.config?.messages?.game_title} (id: ${quest.id})`);
    }

    if (newQuests.length > 0) {
      await redis.sadd(SEEN_KEY, ...newQuests.map(q => q.id));
    }

    console.log(`[${ts()}] Checked — ${active.length} active (${quests.length - active.length} expired), ${newQuests.length} new`);
  } catch (err) {
    console.error(`[${ts()}] Error:`, err.message);
  }
}

async function testSend() {
  const res = await fetch(`${DISCORD_API}/quests/@me`, {
    headers: {
      Authorization: process.env.USER_TOKEN,
      'X-Super-Properties': process.env.X_SUPER_PROPERTIES,
      'X-Discord-Locale': 'en-US',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    },
  });

  if (!res.ok) { console.error(`[${ts()}] Quest API returned ${res.status}`); return; }

  const { quests = [] } = await res.json();
  const now    = Date.now();
  const active = quests.filter(q => !q.config?.expires_at || new Date(q.config.expires_at).getTime() > now);

  if (active.length === 0) { console.log(`[${ts()}] No active quests to test with.`); return; }

  const quest = active[Math.floor(Math.random() * active.length)];
  console.log(`[${ts()}] Sending test alert for: ${quest.config?.messages?.quest_name} (id: ${quest.id})`);
  await postAlert(quest);
  console.log(`[${ts()}] Test alert sent.`);
}

if (CHECK_ONLY) {
  checkQuests(true);
} else if (TEST_SEND) {
  testSend().catch(err => console.error(`[${ts()}] Error:`, err.message));
} else {
  checkQuests();
  setInterval(checkQuests, POLL_MS);
}
