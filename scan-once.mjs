import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { tick } from './src/index.js';

const seenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seen.json');

const env = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  CHANNEL_IDS: process.env.CHANNEL_IDS || '1551595288777596931,1551607291378143314',
  SEEN: {
    async get() {
      if (!fs.existsSync(seenPath)) return null;
      return JSON.parse(fs.readFileSync(seenPath, 'utf8'));
    },
    async put(_key, value) {
      fs.writeFileSync(seenPath, value);
    },
  },
};

const result = await tick(env);
console.log(JSON.stringify(result));
