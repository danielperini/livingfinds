/**
 * Auditoria visual autenticada. Exemplo:
 * PLAYWRIGHT_STORAGE_STATE=artifacts/auth.json node scripts/capture-all-routes.mjs
 *
 * O estado de autenticação é deliberadamente externo ao repositório.
 */
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseURL = process.env.UI_AUDIT_BASE_URL || 'http://127.0.0.1:5173';
const storageState = process.env.PLAYWRIGHT_STORAGE_STATE;
const outputDir = resolve('artifacts/ui-audit');
const routes = [
  '/', '/products', '/inventory', '/ads', '/search-terms', '/analytics', '/repricing',
  '/sala-de-comando', '/autopilot', '/campaign-factory', '/keyword-management',
  '/daypart-crossasin', '/saude-do-sistema', '/logs', '/report', '/settings', '/users',
  '/sp-api-setup', '/integracoes/amazon', '/configuracao-de-campanhas', '/manual',
  '/optimizer', '/currency-audit', '/keyword-ml', '/kickoff-monitor',
];

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  throw new Error('Playwright não está instalado. Instale-o no ambiente de auditoria antes de executar este script.');
}

if (!storageState) throw new Error('Defina PLAYWRIGHT_STORAGE_STATE com uma sessão autenticada de auditoria.');
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState, viewport: { width: 1440, height: 900 } });
const failures = [];

for (const route of routes) {
  const page = await context.newPage();
  await page.goto(new URL(route, baseURL).toString(), { waitUntil: 'networkidle' });
  await page.waitForSelector('.lf-app-shell', { timeout: 12_000 });
  const whiteSurfaces = await page.locator('.lf-app-shell *').evaluateAll((nodes) => nodes
    .filter((node) => {
      const style = getComputedStyle(node);
      const color = style.backgroundColor.replace(/\s/g, '');
      const box = node.getBoundingClientRect();
      return box.width * box.height > 900 && (color === 'rgb(255,255,255)' || color === 'rgba(255,255,255,1)');
    })
    .map((node) => `${node.tagName.toLowerCase()}.${node.className}`)
    .slice(0, 10));
  if (whiteSurfaces.length) failures.push({ route, whiteSurfaces });
  await page.screenshot({ path: resolve(outputDir, `${route === '/' ? 'dashboard' : route.slice(1).replaceAll('/', '__')}.png`), fullPage: true });
  await page.close();
}

await browser.close();
if (failures.length) throw new Error(`Superfícies brancas relevantes encontradas:\n${JSON.stringify(failures, null, 2)}`);
console.log(`Auditoria aprovada: ${routes.length} rotas capturadas em ${outputDir}`);
