import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

function Section({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-surface-2 rounded-xl overflow-hidden">
      <button onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-xs font-semibold text-slate-300 hover:text-white transition-colors">
        {title}
        {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

function parseJsonSafe(str, fallback) {
  try { return JSON.parse(str || ''); } catch { return fallback; }
}

export default function ListingSnapshotPanel({ snapshot }) {
  if (!snapshot) {
    return (
      <div className="text-center py-10 text-slate-500 text-sm">
        Listing não sincronizado. Execute a sincronização para ver o conteúdo atual da Amazon.
      </div>
    );
  }

  const bullets = parseJsonSafe(snapshot.bullets, []);
  const organicTerms = parseJsonSafe(snapshot.organic_terms, []);
  const images = parseJsonSafe(snapshot.images, []);
  const attributes = parseJsonSafe(snapshot.attributes, {});
  const schemaFields = parseJsonSafe(snapshot.schema_fields, {});
  const requiredFields = parseJsonSafe(snapshot.required_fields, []);
  const missingFields = parseJsonSafe(snapshot.missing_fields, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-[10px] text-slate-500 pb-1">
        <span>Product Type: <span className="text-slate-300 font-mono">{snapshot.product_type || '—'}</span></span>
        <span>·</span>
        <span>Sync: {snapshot.synced_at ? new Date(snapshot.synced_at).toLocaleString('pt-BR') : '—'}</span>
        <span>·</span>
        <span className={`${snapshot.sync_status === 'success' ? 'text-emerald-400' : 'text-amber-400'}`}>{snapshot.sync_status}</span>
      </div>

      <Section title="Título" defaultOpen>
        {snapshot.title
          ? <p className="text-sm text-slate-200 leading-relaxed">{snapshot.title}</p>
          : <p className="text-xs text-amber-400">Título ausente no listing.</p>}
      </Section>

      <Section title={`Bullet Points (${bullets.length})`} defaultOpen>
        {bullets.length > 0
          ? <ul className="space-y-1">{bullets.map((b, i) => <li key={i} className="text-xs text-slate-300 flex gap-2"><span className="text-slate-600">•</span>{b}</li>)}</ul>
          : <p className="text-xs text-amber-400">Nenhum bullet point encontrado.</p>}
      </Section>

      <Section title="Descrição">
        {snapshot.description
          ? <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">{snapshot.description}</p>
          : <p className="text-xs text-amber-400">Descrição ausente.</p>}
      </Section>

      <Section title={`Termos Orgânicos (${organicTerms.length})`}>
        {organicTerms.length > 0
          ? <div className="flex flex-wrap gap-1.5">{organicTerms.map((t, i) => <span key={i} className="px-2 py-0.5 bg-surface-3 rounded text-[10px] text-slate-300">{t}</span>)}</div>
          : <p className="text-xs text-amber-400">Sem termos orgânicos preenchidos.</p>}
      </Section>

      <Section title={`Imagens (${images.length})`}>
        {images.length > 0
          ? (
            <div className="space-y-1">
              {images.map((img, i) => (
                <div key={i} className="flex items-center gap-2 text-[10px]">
                  <span className="text-slate-500">{i + 1}.</span>
                  <a href={img?.value || img?.link || img} target="_blank" rel="noopener noreferrer"
                    className="text-cyan hover:underline truncate">
                    {img?.value || img?.link || String(img).slice(0, 60)}
                  </a>
                </div>
              ))}
            </div>
          )
          : <p className="text-xs text-amber-400">Nenhuma imagem encontrada via API.</p>}
      </Section>

      <Section title={`Product Type Definition — Campos (${schemaFields?.editable?.length || 0} editáveis, ${requiredFields.length} obrigatórios)`}>
        <div className="space-y-2">
          {requiredFields.length > 0 && (
            <div>
              <p className="text-[10px] text-slate-400 font-semibold mb-1">Obrigatórios:</p>
              <div className="flex flex-wrap gap-1.5">
                {requiredFields.map((f, i) => (
                  <span key={i} className={`px-2 py-0.5 rounded text-[10px] font-mono border ${missingFields.includes(f) ? 'bg-red-500/10 border-red-500/20 text-red-400' : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'}`}>
                    {f} {missingFields.includes(f) ? '⚠' : '✓'}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </Section>

      <Section title="Atributos Completos (Raw)">
        <pre className="text-[10px] text-slate-400 overflow-auto max-h-48 whitespace-pre-wrap">
          {JSON.stringify(attributes, null, 2).slice(0, 3000)}
        </pre>
      </Section>
    </div>
  );
}