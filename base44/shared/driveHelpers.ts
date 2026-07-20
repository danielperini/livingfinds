/**
 * driveHelpers — Utilitários compartilhados para upload no Google Drive
 */

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export async function compress(data: string): Promise<Uint8Array> {
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

export async function findOrCreateFolder(name: string, parentId: string, token: string): Promise<string> {
  const q = encodeURIComponent(`name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.ok) {
    const data = await res.json();
    if (data.files?.length > 0) return data.files[0].id;
  }
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  });
  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`Erro criando pasta ${name}: HTTP ${createRes.status} — ${err.slice(0, 200)}`);
  }
  return (await createRes.json()).id;
}

export async function upsertFileToDrive(name: string, content: Uint8Array, folderId: string, token: string): Promise<string> {
  const q = encodeURIComponent(`name='${name}' and '${folderId}' in parents and trashed=false`);
  const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (searchRes.ok) {
    const existing = await searchRes.json();
    if (existing.files?.length > 0) {
      const fileId = existing.files[0].id;
      const upd = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/gzip' },
        body: content,
      });
      if (!upd.ok) throw new Error(`Erro atualizando ${name}: HTTP ${upd.status}`);
      return fileId;
    }
  }
  // Novo arquivo via multipart
  const boundary = '-------314159265358979323846';
  const meta = JSON.stringify({ name, parents: [folderId] });
  const metaPart = new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`);
  const dataLabel = new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`);
  const closing = new TextEncoder().encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(metaPart.length + dataLabel.length + content.length + closing.length);
  let off = 0;
  body.set(metaPart, off); off += metaPart.length;
  body.set(dataLabel, off); off += dataLabel.length;
  body.set(content, off); off += content.length;
  body.set(closing, off);
  const up = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary="${boundary}"` },
    body,
  });
  if (!up.ok) throw new Error(`Erro fazendo upload de ${name}: HTTP ${up.status} — ${(await up.text()).slice(0, 200)}`);
  return (await up.json()).id;
}