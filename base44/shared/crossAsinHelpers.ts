/**
 * crossAsinHelpers — Utilitários compartilhados entre:
 *  - promoteWinningSearchTerms
 *  - runCrossAsinTransfer
 */

export function normalizeText(s: string): string {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

export function tokenize(s: string): Set<string> {
  const stop = new Set(['de','da','do','para','com','sem','uma','um','os','as','o','a','e','em','no','na','por','que','se','ao','pela','pelo','das','dos','mais']);
  return new Set(normalizeText(s).split(' ').filter(t => t.length >= 2 && !stop.has(t)));
}

export function parseBullets(raw: string): string {
  try { return JSON.parse(raw || '[]').join(' '); } catch { return raw || ''; }
}

/**
 * Heurística de relevância entre dois ASINs para uma keyword (0–100).
 */
export function calcHeuristicScore(
  kwText: string,
  srcTitle: string, srcBullets: string, srcCategory: string,
  dstTitle: string, dstBullets: string, dstCategory: string,
): { score: number; breakdown: Record<string, number> } {
  const kwT  = tokenize(kwText);
  const srcT = tokenize(srcTitle + ' ' + srcBullets + ' ' + srcCategory);
  const dstT = tokenize(dstTitle + ' ' + dstBullets + ' ' + dstCategory);

  if (kwT.size === 0 || dstT.size === 0) return { score: 0, breakdown: {} };

  const catSrcT = tokenize(srcCategory), catDstT = tokenize(dstCategory);
  const catOverlap = catSrcT.size > 0
    ? [...catSrcT].filter(t => catDstT.has(t)).length / Math.max(catSrcT.size, 1)
    : 0;
  const cat35 = Math.round(catOverlap * 35);

  let kwInDst = 0;
  for (const t of kwT) { if (dstT.has(t)) kwInDst++; }
  const use20 = Math.round((kwInDst / Math.max(kwT.size, 1)) * 20);

  const attrOverlap = [...srcT].filter(t => dstT.has(t)).length;
  const attr15 = Math.min(15, Math.round((attrOverlap / Math.max(srcT.size, 1)) * 20));

  const cat10 = normalizeText(srcCategory) === normalizeText(dstCategory) ? 10 : catOverlap >= 0.6 ? 6 : 0;

  const highRel = ['automatica','automatico','sensor','eletrico','eletrica','inox','led','recarregavel','bivolt','portatil','digital','inteligente'];
  const srcH = new Set(highRel.filter(t => srcT.has(t)));
  const dstH = new Set(highRel.filter(t => dstT.has(t)));
  const compat10 = srcH.size > 0 ? Math.round(([...srcH].filter(t => dstH.has(t)).length / srcH.size) * 10) : 5;

  const titleSrcT = tokenize(srcTitle), titleDstT = tokenize(dstTitle);
  const sem10 = Math.min(10, Math.round(([...titleSrcT].filter(t => titleDstT.has(t)).length / Math.max(titleSrcT.size, 1)) * 15));

  const total = cat35 + use20 + attr15 + cat10 + compat10 + sem10;
  return { score: Math.min(100, Math.max(0, total)), breakdown: { cat35, use20, attr15, cat10, compat10, sem10 } };
}

/**
 * Detecta hard blockers heurísticos entre dois ASINs.
 */
export function detectHardBlockers(
  kwText: string,
  srcTitle: string, dstTitle: string,
  srcBullets: string, dstBullets: string,
): { blocked: boolean; reason: string } {
  const src = normalizeText(srcTitle + ' ' + srcBullets);
  const dst = normalizeText(dstTitle + ' ' + dstBullets);

  const voltages = ['110v','220v','bivolt'];
  const sv = voltages.find(v => src.includes(v)), dv = voltages.find(v => dst.includes(v));
  if (sv && dv && sv !== dv && sv !== 'bivolt' && dv !== 'bivolt')
    return { blocked: true, reason: `Voltagem incompatível: ${sv} vs ${dv}` };

  const masc = ['masculino','men','homem'], fem = ['feminino','women','mulher'];
  if ((masc.some(t => src.includes(t)) && fem.some(t => dst.includes(t))) ||
      (fem.some(t => src.includes(t)) && masc.some(t => dst.includes(t))))
    return { blocked: true, reason: 'Gênero incompatível' };

  const electronics = ['impressora','computador','notebook','celular','smartphone','tablet','monitor'];
  const kitchen     = ['panela','frigideira','liquidificador','batedeira'];
  if ((electronics.some(t => src.includes(t)) && kitchen.some(t => dst.includes(t))) ||
      (kitchen.some(t => src.includes(t)) && electronics.some(t => dst.includes(t))))
    return { blocked: true, reason: 'Categorias funcionalmente incompatíveis' };

  return { blocked: false, reason: '' };
}

/**
 * CPC sustentável para um destino.
 */
export function destSustainableCpc(destAov: number, expectedCvr: number, targetAcos: number): number {
  if (destAov <= 0 || targetAcos <= 0) return 0;
  const cvr = expectedCvr > 0 ? expectedCvr : 0.05;
  return parseFloat((destAov * cvr * (targetAcos / 100)).toFixed(2));
}