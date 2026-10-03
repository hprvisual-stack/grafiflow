import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'build');

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
cpSync(join(root, 'dist'), output, { recursive: true });

const config = {
  supabaseUrl: process.env.GRAFIFLOW_SUPABASE_URL || '',
  supabaseAnonKey: process.env.GRAFIFLOW_SUPABASE_ANON_KEY || '',
};
writeFileSync(join(output, 'config.js'), `window.GRAFIFLOW_CONFIG = Object.freeze(${JSON.stringify(config)});\n`);

if (Boolean(config.supabaseUrl) !== Boolean(config.supabaseAnonKey)) {
  throw new Error('Configure as duas variáveis GRAFIFLOW_SUPABASE_URL e GRAFIFLOW_SUPABASE_ANON_KEY.');
}
