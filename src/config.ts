import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',

  dataDir: process.env.DATA_DIR ?? path.join(repoRoot, 'data'),
  defaultHotelId: 'lumen-sg',

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5',
    maxTokens: 2048,
  },

  shift: {
    startHour: 23,
    endHour: 7,
    timezone: '+08:00',
  },

  llm: {
    enabled: process.env.LLM_ENABLED !== 'false',
  },
};
