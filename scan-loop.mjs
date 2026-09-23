import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { tick } from './src/index.js';

const seenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seen.json');
const runMs = Number(process.env.RUN_MS || 330 * 60 * 1000);
let state = null;
if (fs.existsSync(seenPath)) state = JSON.parse(fs.readFileSync(seenPath, 'utf8'));

const env = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  CHANNEL_IDS: process.env.CHANNEL_IDS || '1551595288777596931,1551607291378143314',
  SEEN: {
    async get() {
      return state;
    },
    async put(_key, value) {
      state = JSON.parse(value);
      fs.writeFileSync(seenPath, value);
    },
  },
};

const end = Date.now() + runMs;
let pause = 1000;
while (Date.now() < end) {
  const started = Date.now();
  try {
    const result = await tick(env);
    if (result.posted?.length) console.log(new Date().toISOString(), JSON.stringify(result));
    pause = 1000;
  } catch (e) {
    console.warn(new Date().toISOString(), e.message || e);
    pause = Math.min(pause * 2, 10000);
  }
  const wait = pause - (Date.now() - started);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
console.log('loop finished');
