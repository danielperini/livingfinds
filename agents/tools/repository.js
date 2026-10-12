import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tool } from '@openai/agents';
import { z } from 'zod';
import { guardAgentAction } from '../guardrails/production.js';

const DEFAULT_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const MAX_FILE_BYTES = 64 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.jsonc', '.md', '.yml', '.yaml', '.sql', '.toml']);

export function resolveRepositoryFile(requestedPath, root = process.env.LIVINGFINDS_REPO_PATH || DEFAULT_ROOT) {
  const allowed = guardAgentAction('read_repository_file');
  if (!allowed.allowed) return { ok: false, ...allowed };
  const repoRoot = path.resolve(root);
  const normalized = String(requestedPath || '').replaceAll('\\', '/').trim();
  const absolute = path.resolve(repoRoot, normalized);
  const relative = path.relative(repoRoot, absolute);
  if (!normalized || path.isAbsolute(normalized) || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { ok: false, status: 'blocked', reason: 'Caminho fora do repositório.' };
  }
  const lower = relative.toLowerCase().replaceAll('\\', '/');
  if (/(^|\/)(\.env($|\.)|secrets?($|\/)|credentials?($|\/)|private|node_modules|\.git)(\/|$)/i.test(lower) ||
      /\.(pem|key|p12|pfx|keystore)$/i.test(lower) ||
      /secret|credential|token/i.test(path.basename(lower))) {
    return { ok: false, status: 'blocked', reason: 'Arquivo ou diretório sensível bloqueado.' };
  }
  if (!ALLOWED_EXTENSIONS.has(path.extname(lower))) {
    return { ok: false, status: 'blocked', reason: 'Extensão fora da lista de leitura permitida.' };
  }
  return { ok: true, absolute, relative };
}

export async function readRepositoryFile(requestedPath, root) {
  const resolved = resolveRepositoryFile(requestedPath, root);
  if (!resolved.ok) return resolved;
  try {
    const actualPath = await realpath(resolved.absolute);\n    const repoRoot = await realpath(process.env.LIVINGFINDS_REPO_PATH || DEFAULT_ROOT);\n    const actualRelative = path.relative(repoRoot, actualPath);\n    if (actualRelative === '..' || actualRelative.startsWith(`..${path.sep}`) || path.isAbsolute(actualRelative)) {\n      return { ok: false, status: 'blocked', reason: 'O caminho resolvido por symlink sai do repositório.' };\n    }\n    const actualLower = actualRelative.toLowerCase().replaceAll('\\\\', '/');\n    if (/(^|\\/)(\\.env($|\\.)|secrets?($|\\/)|credentials?($|\\/)|private|node_modules|\\.git)(\\/|$)/i.test(actualLower) ||\n        /\\.(pem|key|p12|pfx|keystore)$/i.test(actualLower) || /secret|credential|token/i.test(path.basename(actualLower)) ||\n        !ALLOWED_EXTENSIONS.has(path.extname(actualLower))) {\n      return { ok: false, status: 'blocked', reason: 'O destino real do arquivo é sensível ou não permitido.' };\n    }\n    const metadata = await stat(actualPath);
    if (!metadata.isFile()) return { ok: false, status: 'blocked', reason: 'O caminho não é um arquivo.' };
    if (metadata.size > MAX_FILE_BYTES) return { ok: false, status: 'not_read', reason: 'Arquivo excede 64 KiB; nenhum conteúdo parcial foi devolvido.', bytes: metadata.size };
    return { ok: true, status: 'read', path: resolved.relative, bytes: metadata.size, content: await readFile(actualPath, 'utf8') };
  } catch (error) {
    return { ok: false, status: 'error', path: resolved.relative, error: String(error?.message || error) };
  }
}

export async function proposeRepositoryPatch({ path: filePath, rationale, diff }) {
  const resolved = resolveRepositoryFile(filePath);
  if (!resolved.ok) return resolved;
  if (!String(diff || '').trim()) return { ok: false, status: 'invalid', reason: 'Diff vazio.' };
  return {
    ok: true,
    status: 'proposal_only',
    path: resolved.relative,
    rationale: String(rationale || ''),
    diff: String(diff),
    written: false,
    note: 'A proposta não alterou arquivos. Aplicar mudanças exige revisão fora deste agente.',
  };
}

export const readRepositoryFileTool = tool({
  name: 'read_repository_file',
  description: 'Lê um arquivo de código/documentação permitido dentro do repositório Hostinger. Nega secrets, arquivos privados e caminhos fora do projeto; não retorna conteúdo parcial.',
  parameters: z.object({ path: z.string().min(1) }),
  async execute({ path: filePath }) {
    return await readRepositoryFile(filePath);
  },
});

export const proposePatchTool = tool({
  name: 'propose_patch',
  description: 'Prepara um diff proposto para revisão. Nunca grava nem aplica a alteração.',
  parameters: z.object({ path: z.string().min(1), rationale: z.string(), diff: z.string().min(1) }),
  async execute(input) {
    return await proposeRepositoryPatch(input);
  },
});
