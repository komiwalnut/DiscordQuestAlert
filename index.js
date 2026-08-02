require('dotenv').config();
const express = require('express');
const { Redis } = require('@upstash/redis');

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

// Keep-alive endpoint pinged by Uptime Robot
app.get('/', (_req, res) => res.send('Discord Quest Alert is running.'));
app.listen(PORT, () => console.log(`[${ts()}] Server on port ${PORT}`));

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

  const embed = {
    title: '🎮 New Discord Quest Available!',
    ...(name && { description: `**${name}**` }),
    url: `https://discord.com/quests/${id}`,
    color: BLURPLE,
    fields: [
      { name: 'Game',     value: game,                                      inline: true  },
      { name: 'Reward',   value: reward,                                    inline: true  },
      { name: 'Deadline', value: expiry ? discordTimestamp(expiry) : 'N/A', inline: false },
    ],
    footer: { text: 'Discord Quest Alert' },
    timestamp: new Date().toISOString(),
  };

  const res = await fetch(process.env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (!res.ok) throw new Error(`Webhook POST failed with status ${res.status}`);
}

async function checkQuests() {
  try {
    const res = await fetch(`${DISCORD_API}/quests/@me`, {
      headers: { Authorization: process.env.USER_TOKEN },
    });

    if (!res.ok) {
      console.error(`[${ts()}] Quest API returned ${res.status}`);
      return;
    }

    const { quests = [] } = await res.json();

    const seenIds  = new Set(await redis.smembers(SEEN_KEY));
    const newQuests = quests.filter(q => !seenIds.has(q.id));

    for (const quest of newQuests) {
      await postAlert(quest);
      console.log(`[${ts()}] Alerted: ${quest.config?.messages?.game_title} (id: ${quest.id})`);
    }

    if (newQuests.length > 0) {
      await redis.sadd(SEEN_KEY, ...newQuests.map(q => q.id));
    }

    console.log(`[${ts()}] Checked — ${quests.length} active, ${newQuests.length} new`);
  } catch (err) {
    console.error(`[${ts()}] Error:`, err.message);
  }
}

checkQuests();
setInterval(checkQuests, POLL_MS);
