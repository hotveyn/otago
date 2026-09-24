import path from 'node:path';
import { config } from 'dotenv';

/** `server/.env`. Works from `src/` and `dist/`. */
export const ENV_FILE = path.resolve(import.meta.dirname, '../.env');

// Real environment variables win over `.env`.
config({ path: ENV_FILE, quiet: true });
