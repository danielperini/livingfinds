/**
 * backupListingToDrive
 * Salva dados de listing de um ASIN específico no Google Drive.
 * Estrutura: APP_BACKUPS_LivingFinds/listings/{ASIN}/{ASIN}_{YYYY-MM-DD_HH-MM}.json.gz
 *
 * Chamado automaticamente pela automação de entidade ListingEnhancementHistory (create).
 * Pode também ser chamado manualmente com { amazon_account_id, asin }.
 *
 * Payload de automação recebido:
 *   event.entity_id = id do ListingEnhancementHistory recém-criado
 *   data = objeto do histórico
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

async function compress(data: string): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  writer.write(new TextEncoder().encode(data));
  writer.close();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return merged;
}

async function findOrCreateFolder(name: string, parentId: string, token: string): Promise<string> {
  const q = encodeURIComponent(`name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (res.ok) {
    const d = await res.json();
    if (d.files?.length > 0) return d.files[0].id;
  }
  const create = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  });
  if (!create.ok) throw new Error(`Erro criando pasta ${name}: HTTP ${create.status}`);
  return (await create.json()).id;
}

async function uploadFile(name: string, content: Uint8Array, folderId: string, token: string): Promise<string> {
  const boundary = '-------314159265358979323846';
  const metadata = JSON.stringify({ name, parents: [folderId] });
  const metaPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`;
  const dataPart = `--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`;
  const closing = `\r\n--${boundary}--`;
  const metaBytes = new TextEncoder().encode(metaPart);
  const dataLabelBytes = new TextEncoder().encode(dataPart);
  const closingBytes = new TextEncoder().encode(closing);
  const body = new Uint8Array(metaBytes.length + dataLabelBytes.length + content.length + closingBytes.length);
  let off = 0;
  body.set(metaBytes, off); off += metaBytes.length;
  body.set(dataLabelBytes, off); off += dataLabelBytes.length;
  body.set(content, off); off += content.length;
  body.set(closingBytes, off);
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': `multipart/related; boundary="${boundary}"` },
    body,
  });
  if (!res.ok) throw new Error(`Upload ${name}: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).id;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    const body = await req.json().catch(() => ({}));

    // Suporte a chamada por automação de entidade (payload da plataforma)
    const historyRecord = body.data || null;
    const asin: string = body.asin || historyRecord?.asin || '';
    const amazon_account_id: string = body.amazon_account_id || historyRecord?.amazon_account_id || '';

    if (!asin || !amazon_account_id) {
      return Response.json({ ok: false, error: 'asin e amazon_account_id são obrigatórios' }, { status: 400 });
    }

    // Obter token do Google Drive
    const { accessToken: driveToken } = await base44.asServiceRole.connectors.getConnection('googledrive');
    if (!driveToken) return Response.json({ ok: false, error: 'Google Drive não conectado' }, { status: 400 });

    // Buscar dados do listing para este ASIN
    const [snapshots, proposals, history] = await Promise.all([
      base44.asServiceRole.entities.ListingSnapshot.filter({ amazon_account_id, asin }, '-synced_at', 5).catch(() => []),
      base44.asServiceRole.entities.ListingEnhancementProposal.filter({ amazon_account_id, asin }, '-created_at', 100).catch(() => []),
      base44.asServiceRole.entities.ListingEnhancementHistory.filter({ amazon_account_id, asin }, '-submitted_at', 100).catch(() => []),
    ]);

    const now = new Date();
    // Timestamp no formato YYYY-MM-DD_HH-MM (horário de Brasília)
    const brtOffset = -3 * 60;
    const brt = new Date(now.getTime() + brtOffset * 60000);
    const dateStr = brt.toISOString().slice(0, 10);
    const timeStr = brt.toISOString().slice(11, 16).replace(':', '-');
    const timestamp = `${dateStr}_${timeStr}`;

    const payload = {
      asin,
      amazon_account_id,
      exported_at: now.toISOString(),
      trigger: historyRecord ? 'entity_create' : 'manual',
      triggering_history_id: historyRecord?.id || null,
      field_changed: historyRecord?.field_name || null,
      value_before: historyRecord?.value_before || null,
      value_after: historyRecord?.value_after || null,
      snapshot: snapshots[0] || null,
      proposals,
      history,
    };

    const compressed = await compress(JSON.stringify(payload));

    // Estrutura de pastas: APP_BACKUPS_LivingFinds/listings/{ASIN}/
    const rootId = await findOrCreateFolder('APP_BACKUPS_LivingFinds', 'root', driveToken);
    const listingsId = await findOrCreateFolder('listings', rootId, driveToken);
    const asinFolderId = await findOrCreateFolder(asin, listingsId, driveToken);

    const fileName = `${asin}_${timestamp}.json.gz`;
    const fileId = await uploadFile(fileName, compressed, asinFolderId, driveToken);

    console.log(`[backupListingToDrive] ASIN=${asin} | Arquivo=${fileName} | DriveId=${fileId}`);

    return Response.json({
      ok: true,
      asin,
      file_name: fileName,
      drive_file_id: fileId,
      snapshot_included: !!snapshots[0],
      proposals_count: proposals.length,
      history_count: history.length,
      exported_at: now.toISOString(),
    });

  } catch (err: any) {
    console.error('[backupListingToDrive]', err.message);
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});