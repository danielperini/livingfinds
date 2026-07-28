import { join } from 'jsr:@std/path@1';

const root = join(import.meta.dirname!, '..', '..');
const production = Deno.env.get('DEPLOY_ENV') === 'production';
const errors: string[] = [];
const warnings: string[] = [];

async function countDirectories(path: string): Promise<number> {
  let count = 0;
  for await (const entry of Deno.readDir(path)) if (entry.isDirectory) count++;
  return count;
}

if (production) {
  for (const name of ['DATABASE_URL', 'ADMIN_PASSWORD', 'API_TOKEN', 'APP_BASE_URL']) {
    const value = Deno.env.get(name)?.trim();
    if (!value || value === 'CHANGE_ME') errors.push(`${name} não está configurada`);
  }
  if (Deno.env.get('ADMIN_PASSWORD') === Deno.env.get('API_TOKEN')) {
    errors.push('ADMIN_PASSWORD e API_TOKEN devem ser segredos diferentes');
  }
}

const functionsPath = join(root, 'base44', 'functions');
const entitiesPath = join(root, 'base44', 'entities');
const functions = await countDirectories(functionsPath);
const entities = await countDirectories(entitiesPath);
const denoConfig = await Deno.readTextFile(join(root, 'server', 'deno.json'));
const versions = new Set<string>();

for await (const fn of Deno.readDir(functionsPath)) {
  if (!fn.isDirectory) continue;
  try {
    const source = await Deno.readTextFile(join(functionsPath, fn.name, 'entry.ts'));
    for (const match of source.matchAll(/npm:@base44\/sdk@([\d.]+)/g)) versions.add(match[1]);
  } catch {
    warnings.push(`função sem entry.ts legível: ${fn.name}`);
  }
}

for (const version of versions) {
  if (!denoConfig.includes(`npm:@base44/sdk@${version}`)) {
    errors.push(`SDK Base44 ${version} é usado, mas não está mapeado para o shim`);
  }
}

console.log(JSON.stringify({
  ok: errors.length === 0,
  environment: production ? 'production' : 'development',
  functions,
  entities,
  sdkVersions: [...versions].sort(),
  warnings,
  errors,
}, null, 2));

if (errors.length) Deno.exit(1);
