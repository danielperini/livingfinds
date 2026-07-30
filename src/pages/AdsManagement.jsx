import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { loadAllCampaigns, classifyCampaigns, campaignState } from '@/lib/campaignUtils';
import {
  Search, Save, Loader2, CheckCircle, AlertCircle, Megaphone, Brain,
  RefreshCw, TrendingUp, TrendingDown, X, Plus, ListFilter, Clock,
  Settings, Package, History, Zap, Bot, Sparkles, ChevronDown, ChevronUp,
  Pause, Trash2, Rocket, Wifi, WifiOff, Shield, Play, PlayCircle, DollarSign,
  Archive } from
'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import CampaignConfigPanel from '@/components/ads/CampaignConfigPanel';
import CampaignHistoryTab from '@/components/ads/CampaignHistoryTab';
import ReconciliationPanel from '@/components/ads/ReconciliationPanel';
import KickoffModal from '@/components/products/KickoffModal';
import CreateCampaignWizard from '@/components/ads/CreateCampaignWizard';
import CampaignHealthPanel from '@/components/ads/CampaignHealthPanel';
import ManualCampaignProposalModal from '@/components/ads/ManualCampaignProposalModal';
import ExportPerformanceButton from '@/components/ads/ExportPerformanceButton';
import StaleInventoryWarningPanel from '@/components/ads/StaleInventoryWarningPanel';
import ReactivateWithBudgetModal from '@/components/ads/ReactivateWithBudgetModal';

const NOW_MS = Date.now();
const H24 = 24 * 60 * 60 * 1000;
const CAMPAIGN_REFRESH_MS = 10 * 60 * 1000;
const AMAZON_SYNC_THROTTLE_MS = 30 * 60 * 1000;

function campaignTargetingType(campaign) {
  if (campaign._hasManualKeywords === true) return 'MANUAL';
  const name = String(campaign.name || campaign.campaign_name || '');
  if (/MANUAL|EXACT|PHRASE|BROAD/i.test(name)) return 'MANUAL';
  if (/\bAUTO(?:MATIC[AO]?)?\b/i.test(name)) return 'AUTO';

  const explicit = String(campaign.targeting_type || campaign.targetingType || '').toUpperCase();
  return explicit === 'MANUAL' ? 'MANUAL' : 'AUTO';
}

function isNew24h(campaign) {
  const ts =
  campaign.created_at ||
  campaign.start_date ||
  campaign.synced_at ||
  campaign.last_sync_at;
  if (!ts) return false;
  return NOW_MS - new Date(ts).getTime() < H24;
}

function isAiManaged(campaign) {
  return campaign.created_by_app === true || campaign.learning_eligible !== false;
}

// Extrai ASIN do nome da campanha (ex: "AUTO | B0FCYPPG2M | ...")
function extractAsinFromName(name) {
  if (!name) return null;
  const m = name.match(/\b(B0[A-Z0-9]{8})\b/);
  return m ? m[1] : null;
}

// Retorna o ASIN canÃ´nico da campanha (campo ou extraÃ­do do nome)
function getCampaignAsin(c) {
  return c.asin || extractAsinFromName(c.name || c.campaign_name) || null;
}

/** Detecta campanha manual com mÃºltiplas keywords (precisa migraÃ§Ã£o) */
function needsMigration(campaign, keywords) {
  if ((campaign.targeting_type || '').toUpperCase() !== 'MANUAL') return false;
  // Campanhas no formato canÃ´nico nunca precisam de migraÃ§Ã£o
  if (/^SP\s*\|\s*MANUAL\s*\|\s*EXACT\s*\|/i.test(String(campaign.name || campaign.campaign_name || ''))) return false;
  // PadrÃ£o +N no nome
  if (/\+\d+\s*$/i.test(String(campaign.name || campaign.campaign_name || ''))) return true;
  // keyword_count > 1 no campo
  if ((campaign.keyword_count || 0) > 1) return true;
  // Mais de 1 keyword ativa no banco
  const activeExact = keywords.filter((k) => {
    const st = (k.state || k.status || '').toLowerCase();
    return st !== 'archived' && (k.match_type || '').toLowerCase() === 'exact';
  });
  return activeExact.length > 1;
}

const STATE_FILTERS = [
{ key: 'all', label: 'Todas' },
{ key: 'enabled', label: 'Ativas' },
{ key: 'paused', label: 'Pausadas' }];


const PAGE_SIZE = 50;

function CampaignColumn({ title, icon: Icon, color, campaigns, products, selectedId, onSelect, loading, stateFilter, onStateFilter, extraAction, onQuickPause, onQuickResume, onReactivateBudget, onQuickArchive }) {
  const [page, setPage] = useState(1);
  const [itemLoading, setItemLoading] = useState({});

  // Reset pagination when campaigns list changes (filter/search)
  useEffect(() => {setPage(1);}, [campaigns.length, stateFilter]);

  const visible = campaigns.slice(0, page * PAGE_SIZE);
  const hasMore = visible.length < campaigns.length;

  const handleQuickPause = async (e, c) => {
    e.stopPropagation();
    if (itemLoading[c.id]) return;
    setItemLoading((prev) => ({ ...prev, [c.id]: true }));
    try {
      await onQuickPause(c);
    } finally {
      setItemLoading((prev) => ({ ...prev, [c.id]: false }));
    }
  };

  const handleQuickResume = async (e, c) => {
    e.stopPropagation();
    if (itemLoading[c.id]) return;
    setItemLoading((prev) => ({ ...prev, [c.id]: true }));
    try {
      await onQuickResume(c);
    } finally {
      setItemLoading((prev) => ({ ...prev, [c.id]: false }));
    }
  };

  const handleQuickArchive = async (e, c) => {
    e.stopPropagation();
    if (itemLoading[c.id]) return;
    const name = c.name || c.campaign_name || 'esta campanha';
    if (!window.confirm(`Arquivar "${name}" na Amazon Ads? Ela serÃ¡ removida do painel e arquivada permanentemente. Esta aÃ§Ã£o Ã© irreversÃ­vel.`)) return;
    setItemLoading((prev) => ({ ...prev, [c.id]: true }));
    try {
      await onQuickArchive(c);
    } finally {
      setItemLoading((prev) => ({ ...prev, [c.id]: false }));
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 border-r border-surface-2 last:border-r-0">
      {/* Column header */}
      <div className={`px-3 py-2 border-b border-surface-2 flex items-center gap-2`}>
        <Icon className={`w-3.5 h-3.5 ${color}`} />
        <span className={`text-xs font-bold uppercase tracking-wider ${color}`}>{title}</span>
        <span className="ml-auto text-xs text-slate-600 font-mono">{campaigns.length}</span>
      </div>
      {/* Extra action row */}
      {extraAction &&
      <div className="px-2 py-1.5 border-b border-surface-2">
          {extraAction}
        </div>
      }

      {/* State filter per column */}
      <div className="px-2 py-1.5 border-b border-surface-2 flex gap-1">
        {STATE_FILTERS.map((f) =>
        <button key={f.key} onClick={() => onStateFilter(f.key)}
        className={`px-1.5 py-0.5 text-[9px] rounded transition-colors font-medium ${stateFilter === f.key ? `bg-cyan/20 text-cyan border border-cyan/30` : 'text-slate-600 hover:text-slate-300'}`}>
            {f.label}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {loading ?
        <div className="flex items-center justify-center py-8">
            <Loader2 className="w-4 h-4 text-cyan animate-spin" />
          </div> :
        campaigns.length === 0 ?
        <p className="text-[10px] text-slate-600 text-center py-6 px-2">Nenhuma campanha</p> :
        <>
        {visible.map((c, i) => {
            const isSelected = selectedId === c.id;
            const isNew = isNew24h(c);
            const aiManaged = isAiManaged(c);
            const acosColor = (c.acos || 0) > 40 ? 'text-red-400' : (c.acos || 0) > 25 ? 'text-amber-400' : 'text-emerald-400';
            const prod = c.asin ? products.find((p) => p.asin === c.asin) : null;
            const state = campaignState(c);
            const isItemLoading = !!itemLoading[c.id];

            return (
              <div
                key={c.id || i}
                onClick={() => onSelect(c)}
                className={`group w-full text-left px-3 py-2.5 border-b border-surface-2/40 transition-all cursor-pointer ${
                isSelected ?
                'bg-surface-2 border-l-2 border-l-cyan' :
                'hover:bg-surface-1/60 border-l-2 border-l-transparent'}`
                }>
                {/* Name + badges */}
                <div className="flex items-start gap-1.5 mb-1">
                  <p className="text-[11px] font-medium text-white truncate flex-1 leading-tight">
                    {c._asin_resolved ? `AUTO | ${c._asin_resolved}` : c.name || c.campaign_name}
                  </p>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {/* Quick pause/resume button â€” visible on hover */}
                    {(onQuickPause || onQuickResume) && (state === 'enabled' || state === 'paused') ?
                    <button
                      onClick={(e) => state === 'enabled' ? handleQuickPause(e, c) : handleQuickResume(e, c)}
                      title={state === 'enabled' ? 'Pausar campanha' : 'Reativar campanha'}
                      className={`opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded ${
                      state === 'enabled' ?
                      'text-amber-400 bg-amber-500/10 hover:bg-amber-500/25' :
                      'text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/25'}`
                      }>
                        {isItemLoading ?
                      <Loader2 className="w-3 h-3 animate-spin" /> :
                      state === 'enabled' ?
                      <Pause className="w-3 h-3" /> :
                      <Play className="w-3 h-3" />}
                      </button> :
                    null}
                    {/* Quick archive button â€” visible on hover, destructive */}
                    {onQuickArchive && state !== 'archived' ?
                    <button
                      onClick={(e) => handleQuickArchive(e, c)}
                      title="Arquivar na Amazon (irreversÃ­vel)"
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-rose-500 bg-rose-500/10 hover:bg-rose-500/25">
                        {isItemLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Archive className="w-3 h-3" />}
                      </button> :
                    null}
                    {/* Reativar + Ajustar Budget â€” apenas para pausadas */}
                    {state === 'paused' && onReactivateBudget ?
                    <button
                      onClick={(e) => { e.stopPropagation(); onReactivateBudget(c); }}
                      title="Reativar + Ajustar Budget"
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-cyan bg-cyan/10 hover:bg-cyan/25"
                    >
                      <DollarSign className="w-3 h-3" />
                    </button> :
                    null}
                    {c._group_count > 1 ?
                    <span title={`${c._group_count} campanhas para este ASIN`} className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-300 border border-orange-500/30 leading-none">
                        Ã—{c._group_count}
                      </span> :
                    null}
                    {isNew ?
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-400/20 text-amber-300 border border-amber-400/30 leading-none">
                        NEW
                      </span> :
                    null}
                    {aiManaged ?
                    <span title="Gerido pela IA" className="text-[9px] font-bold px-1 py-0.5 rounded bg-cyan/15 text-cyan border border-cyan/25 leading-none flex items-center gap-0.5">
                        <Bot className="w-2.5 h-2.5" />
                      </span> :
                    null}
                    {(c.targeting_type || '').toUpperCase() === 'MANUAL' &&
                    !/^SP\s*\|\s*MANUAL\s*\|\s*EXACT\s*\|/i.test(String(c.name || c.campaign_name || '')) && (
                    (c.keyword_count || 0) > 1 || /\+\d+\s*$/i.test(String(c.name || c.campaign_name || ''))) ?
                    <span title="Esta campanha tem mÃºltiplas keywords e precisa ser migrada para o formato canÃ´nico (1 campanha = 1 keyword)" className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/30 leading-none whitespace-nowrap">
                        MIGRAÃ‡ÃƒO PENDENTE
                      </span> :
                    null}
                  </div>
                </div>

                {/* ASIN/SKU */}
                {prod ?
                <p className="text-[9px] text-slate-500 truncate mb-1">
                    <span className="text-cyan font-mono">{prod.asin}</span>
                    {prod.sku ? <span className="ml-1">Â· {prod.sku}</span> : null}
                  </p> :
                c.asin || c._asin_resolved ?
                <p className="text-[9px] font-mono text-slate-500 mb-1">{c.asin || c._asin_resolved}</p> :
                null}

                {/* Metrics row */}
                <div className="flex items-center gap-2 flex-wrap">
                  <StatusBadge status={state || 'enabled'} size="xs" />
                  {(c.daily_budget || 0) > 0 && (
                    <span className="text-[10px] text-slate-500" title="OrÃ§amento diÃ¡rio">R${Number(c.daily_budget).toFixed(2)}/d</span>
                  )}
                  <span className="text-[10px] text-slate-500">R${(c.spend || 0).toFixed(0)}</span>
                  {(c.acos || 0) > 0 ?
                  <span className={`text-[10px] font-semibold ${acosColor}`}>{(c.acos || 0).toFixed(0)}%</span> :
                  null}
                  {c.targeting_type === 'MANUAL' && c.bidding_strategy ?
                  <span className={`text-[9px] font-medium px-1 py-0.5 rounded leading-none ${
                  c.bidding_strategy === 'autoForSales' ? 'text-emerald-400 bg-emerald-500/10' :
                  c.bidding_strategy === 'legacyForSales' ? 'text-amber-400 bg-amber-500/10' :
                  'text-slate-400 bg-slate-500/10'}`}>
                    {c.bidding_strategy === 'autoForSales' ? 'â†• U&D' : c.bidding_strategy === 'legacyForSales' ? 'â†“ Down' : 'Fixed'}
                  </span> :
                  null}
                </div>
              </div>);
          })}
        {hasMore &&
          <button
            onClick={() => setPage((p) => p + 1)}
            className="w-full py-2 text-[10px] text-slate-500 hover:text-cyan transition-colors border-t border-surface-2/40">
            
            Carregar mais ({campaigns.length - visible.length} restantes)
          </button>
          }
        </>
        }
      </div>
    </div>);
}

export default function AdsManagement() {
  const [account, setAccount] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [selectedCampaign, setSelectedCampaign] = useState(null);
  const [keywords, setKeywords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [kwLoading, setKwLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [pendingBids, setPendingBids] = useStatÛMıîÚ$z{-®éÜj×FV×2Ö6VçFW"vÓ"‚ÓB’Ó"&rÖ7–âó&÷&FW"&÷&FW"Ö7–âó#FW‡BÖ7–â†÷fW#¦&rÖ7–âó#FW‡B×‡2föçB×6VÖ–&öÆB&÷VæFVBÖÆrG&ç6—F–öâÖ6öÆ÷'2#àĞ¢ Ğ¢Å&Vg&W6„7r6Æ74æÖSÒ'rÓ2ãR‚Ó2ãR"óâ7–æ2¶W—v÷&G0Ğ¢Âö'WGFöãàĞ¢Æ'WGFöàĞ¢öä6Æ–6³×²‚’ÓâÆöD¶W—v÷&G4f÷$6×–vâ‡6VÆV7FVD6×–vâ—ĞĞ¢6Æ74æÖSÒ&fÆW‚—FV×2Ö6VçFW"vÓ"‚ÓB’Ó"&r×7W&f6RÓ"&÷&FW"&÷&FW"×7W&f6RÓ2FW‡B×6ÆFRÓ3†÷fW#§FW‡B×v†—FRFW‡B×‡2föçB×6VÖ–&öÆB&÷VæFVBÖÆrG&ç6—F–öâÖ6öÆ÷'2#àĞ¢ Ğ¢Å&Vg&W6„7r6Æ74æÖSÒ'rÓ2ãR‚Ó2ãR"óâ&V6'&Vv Ğ¢Âö'WGFöãàĞ¢ÂöF—càĞ¢ÂöF—câ Ğ Ğ¢ÇF&ÆR6Æ74æÖSÒ'rÖgVÆÂFW‡B×6Ò#àĞ¢ÇF†VB6Æ74æÖSÒ'7F–6·’F÷Ó&rÕ²3CcEÒ¢Ó#àĞ¢ÇG"6Æ74æÖSÒ&&÷&FW"Ö"&÷&FW"×7W&f6RÓ"#àĞ¢µ²u&öGWFòò4µRrÂt¶W—v÷&BrÂtÖF6‚rÂtW7FFòrÂtÖVÆ†÷"†÷,:&–òrÂt&–BGVÂrÂtæ÷fò&–BrÂt6õ2rÂt6Æ—VW2rÂu7VæBrÂufVæF2uÒæÖ‚†‚’ÓàĞ¢ÇF‚¶W“×¶‡Ò6Æ74æÖSÒ'‚ÓB’Ó2FW‡BÖÆVgBFW‡B×‡2föçB×6VÖ–&öÆBFW‡B×6ÆFRÓSWW&66RG&6¶–ær×v–FW"v†—FW76RÖæ÷w&#ç¶‡ÓÂ÷FƒàĞ¢—ĞĞ¢Â÷G#àĞ¢Â÷F†VCàĞ¢ÇF&öG“àĞ¢¶¶W—v÷&G2æÖ‚†·rÂ’’Óâ°Ğ¢6öç7B6†ævVBÒ·ræ–B–âVæF–æt&–G3°Ğ¢6öç7B·u&öGV7BÒ·ræ6–âğĞ¢&öGV7G2æf–æB‚‡’Óâæ6–âÓÓÒ·ræ6–â’ÇÂ&öGV7G2æf–æB‚‡’Óâæ6–âÓÓÒ6VÆV7FVD6×–vãòæ6–â’ Ğ¢&öGV7G2æf–æB‚‡’Óâæ6–âÓÓÒ6VÆV7FVD6×–vãòæ6–â“°Ğ¢6öç7B6÷46öÆ÷"Ò†·ræ6÷2ÇÂ’âSòwFW‡B×&VBÓCr¢†·ræ6÷2ÇÂ’â3òwFW‡BÖÖ&W"ÓCr¢wFW‡BÖVÖW&ÆBÓCs°Ğ¢6öç7B&VæFW$&W7D†÷W"Ò‚’Óâ°Ğ¢–b‚·ræ†÷W&Ç•öFFöÖGW&RÇÂ·ræ&W7Eö†÷W%÷7F'BÓÒçVÆÂ’°Ğ¢&WGW&âÆF—b6Æ74æÖSÒ&fÆW‚—FV×2Ö6VçFW"vÓFW‡B×6ÆFRÓS#ãÄ6Æö6²6Æ74æÖSÒ'rÓ2‚Ó2"óãÇ7â6Æ74æÖSÒ'FW‡BÕ³…Ò#ä&VæFVæFóÂ÷7ããÂöF—cã°Ğ¢ĞĞ¢6öç7B2Ò7G&–ær†·ræ&W7Eö†÷W%÷7F'B’çE7F'Bƒ"Âsr“°Ğ¢6öç7BRÒ7G&–ær†·ræ&W7Eö†÷W%öVæB’çE7F'Bƒ"Âsr“°Ğ¢&WGW&â€Ğ¢ÆF—b6Æ74æÖSÒ'76R×’ÓãR#àĞ¢ÆF—b6Æ74æÖSÒ&fÆW‚—FV×2Ö6VçFW"vÓ#ãÄ6Æö6²6Æ74æÖSÒ'rÓ2‚Ó2FW‡BÖ7–â"óãÇ7â6Æ74æÖSÒ'FW‡B×‡2föçB×6VÖ–&öÆBFW‡B×v†—FR#ç·7Ö(	7¶WÖƒÂ÷7ããÂöF—càĞ¢¶·ræ&W7Eö†÷W%÷&ö2òÆF—b6Æ74æÖSÒ'FW‡BÕ³…ÒFW‡B×6ÆFRÓC#å$ô2¶·ræ&W7Eö†÷W%÷&ö7Ò+r¶·ræ&W7Eö†÷W%÷6ÆW7ÒfVæF3ÂöF—câ¢çVÆÇĞĞ¢ÂöF—câ“°Ğ Ğ¢Ó°Ğ¢&WGW&â€Ğ¢ÇG"¶W“×¶·ræ–BÇÂ—Ò6Æ74æÖS×¶&÷&FW"Ö"&÷&FW"×7W&f6RÓ"óSG&ç6—F–öâÖ6öÆ÷'2G¶6†ævVBòv&rÖ7–âóRr¢v†÷fW#¦&r×7W&f6RÓ"wÖÓàĞ¢ÇFB6Æ74æÖSÒ'‚ÓB’Ó"ãRÖ–â×rÕ³#…Ò#àĞ¢¶·u&öGV7BğĞ¢ÆF—b6Æ74æÖSÒ&fÆW‚—FV×2Ö6VçFW"vÓ"#àĞ¢¶·u&öGV7Bç&öGV7Eö–ÖvU÷W&ÂğĞ¢Æ–Ör7&3×¶·u&öGV7Bç&öGV7Eö–ÖvU÷W&ÇÒÇCÒ""6Æ74æÖSÒ'rÓr‚Ór&÷VæFVBö&¦V7BÖ6÷fW"&r×7W&f6RÓ2fÆW‚×6‡&–æ²Ó"óâ Ğ¢ÆF—b6Æ74æÖSÒ'rÓr‚Ór&÷VæFVB&r×7W&f6RÓ2fÆW‚—FV×2Ö6VçFW"§W7F–g’Ö6VçFW"fÆW‚×6‡&–æ²Ó#ãÅ6¶vR6Æ74æÖSÒ'rÓ2‚Ó2FW‡B×6ÆFRÓc"óãÂöF—cçĞĞ¢ÆF—b6Æ74æÖSÒ&Ö–â×rÓ#àĞ¢Ç6Æ74æÖSÒ'FW‡BÕ³…ÒföçBÖÖöæòFW‡BÖ7–âG'Væ6FR#ç¶·u&öGV7Bæ6–çÓÂ÷àĞ¢¶·u&öGV7Bç6·RbbÇ6Æ74æÖSÒ'FW‡BÕ³…ÒFW‡B×6ÆFRÓSG'Væ6FR#å4µS¢¶·u&öGV7Bç6·WÓÂ÷çĞĞ¢ÂöF—càĞ¢ÂöF—câ Ğ¢Ç7â6Æ74æÖSÒ'FW‡BÕ³…ÒFW‡B×6ÆFRÓcföçBÖÖöæò#ç¶·ræ6–âÇÂ6VÆV7FVD6×–vãòæ6–âÇÂ~(	BwÓÂ÷7ãçĞĞ¢Â÷FCàĞ¢ÇFB6Æ74æÖSÒ'‚ÓB’Ó"ãRföçBÖÖVF—VÒFW‡B×v†—FRÖ‚×rÕ³#…ÒG'Væ6FR#ç¶·ræ¶W—v÷&E÷FW‡BÇÂ~(	BwÓÂ÷FCàĞ¢ÇFB6Æ74æÖSÒ'‚ÓB’Ó"ãR#ãÇ7â6Æ74æÖSÒ'FW‡B×‡2‚Ó"’ÓãR&r×7W&f6RÓ2FW‡B×6ÆFRÓC&÷VæFVB#ç¶·ræÖF6…÷G—RÇÂ~(	BwÓÂ÷7ããÂ÷FCàĞ¢ÇFB6Æ74æÖSÒ'‚ÓB’Ó"ãR#ãÅ7FGW4&FvR7FGW3×¶·rç7FFRÇÂvVæ&ÆVBwÒ6—¦SÒ'‡2"óãÂ÷FCàĞ¢ÇFB6Æ74æÖSÒ'‚ÓB’Ó"ãR#ç·&VæFW$&W7D†÷W"‚—ÓÂ÷FCàĞ¢ÇFB6Æ74æÖSÒ'‚ÓB’Ó"ãRFW‡B×6ÆFRÓ3#å"G²†·ræ&–BÇÂ’çFôf—†VBƒ"—ÓÂ÷FCàĞ¢ÇFB6Æ74æÖSÒ'‚ÓB’Ó"ãR#àĞ¢Æ–çWBG—SÒ&çVÖ&W""7FWÒ#ã"Ö–ãÒ#ã""FVfVÇEfÇVS×²†·ræ&–BÇÂ’çFôf—†VBƒ"—ĞĞ¢öä6†ævS×²†R’Óâ6WEVæF–æt&–G2‚‡&Wb’Óâ‡²ââç&WbÂ¶·ræ–EÓ¢'6TfÆöB†RçF&vWBçfÇVR’ÇÂÒ’—ĞĞ¢6Æ74æÖSÒ'rÓ#‚Ó"’Ó&r×7W&f6RÓ2&÷&FW"&÷&FW"×7W&f6RÓ2&÷VæFVBFW‡B×‡2FW‡B×v†—FRfö7W3¦÷WFÆ–æRÖæöæRfö7W3¦&÷&FW"Ö7–âóS"óàĞ¢Â÷FCàĞ¢ÇFB6Æ74æÖSÒ'‚ÓB’Ó"ãR#ãÇ7â6Æ74æÖS×¶föçB×6VÖ–&öÆBFW‡B×‡2G¶6÷46öÆ÷'ÖÓç²†·ræ6÷2ÇÂ’çFôf—†VBƒ—ÒSÂ÷7ããÂ÷FCàĞ¢ÇFB6Æ74æÖSÒ'‚ÓB’Ó"ãRFW‡B×6ÆFRÓC#ç²†·ræ6Æ–6·2ÇÂ’çFôÆö6ÆU7G&–ær‚—ÓÂ÷FCàĞ¢ÇFB6Æ74æÖSÒ'‚ÓB’Ó"ãRFW‡B×6ÆFRÓC#å"G²†·rç7VæBÇÂ’çFôf—†VBƒ"—ÓÂ÷FCàĞ¢ÇFB6Æ74æÖSÒ'‚ÓB’Ó"ãRFW‡BÖVÖW&ÆBÓC#å"G²†·rç6ÆW2ÇÂ’çFôf—†VBƒ"—ÓÂ÷FCàĞ¢Â÷G#â“°Ğ Ğ¢Ò—ĞĞ¢Â÷F&öG“àĞ¢Â÷F&ÆSàĞ¢ĞĞ¢Âóâ¢€Ğ Ğ¢ò¢6V&6‚FW&×2F"¢ğĞ¢ÆF—b6Æ74æÖSÒ'ÓB76R×’ÓB#àĞ¢¶æVu7VvvW7F–öç2æÆVæwF‚âğĞ¢ÆF—càĞ¢Æƒ26Æ74æÖSÒ'FW‡B×‡2föçB×6VÖ–&öÆBFW‡B×&VBÓCÖ"Ó"fÆW‚—FV×2Ö6VçFW"vÓãR#àĞ¢ÅG&VæF–ætF÷vâ6Æ74æÖSÒ'rÓ2ãR‚Ó2ãR"óâ¶æVu7VvvW7F–öç2æÆVæwF‡ÒFW&Ö÷2&æVvF—f Ğ¢Âöƒ3àĞ¢ÆF—b6Æ74æÖSÒ'76R×’Ó"#àĞ¢¶æVu7VvvW7F–öç2æÖ‚†æVr’ÓàĞ¢ÆF—b¶W“×¶æVræ–GÒ6Æ74æÖSÒ&fÆW‚—FV×2Ö6VçFW"§W7F–g’Ö&WGvVVâÓ2&r×&VBÓSóR&÷&FW"&÷&FW"×&VBÓSó#&÷VæFVBÖÆr#àĞ¢ÆF—b6Æ74æÖSÒ&fÆW‚ÓÖ–â×rÓ#àĞ¢Ç6Æ74æÖSÒ'FW‡B×6ÒföçBÖÖVF—VÒFW‡B×v†—FRG'Væ6FR#ç¶æVræ¶W—v÷&E÷FW‡GÓÂ÷àĞ¢Ç6Æ74æÖSÒ'FW‡B×‡2FW‡B×6ÆFRÓC×BÓãR#àĞ¢¶æVræ6Æ–6·2ÇÂÒ6Æ–6·2+r"G²†æVrç7VæBÇÂ’çFôf—†VBƒ"—Ò+r¶æVrç6ÆW2âò"BG²†æVrç6ÆW2ÇÂ’çFôf—†VBƒ"—ÒfVæF6¢w¦W&òfVæF2wĞĞ¢Â÷àĞ¢Ç6Æ74æÖSÒ'FW‡B×‡2FW‡B×&VBÓC×BÓãR#ç¶æVrç&V6öçÓÂ÷àĞ¢ÂöF—càĞ¢Æ'WGFöâöä6Æ–6³×²‚’ÓâæVvFT¶W—v÷&B†æVr—ĞĞ¢6Æ74æÖSÒ&ÖÂÓ2‚Ó2’ÓãRFW‡B×‡2föçB×6VÖ–&öÆB&r×&VBÓSó#FW‡B×&VBÓC&÷&FW"&÷&FW"×&VBÓSó3&÷VæFVBÖÆr†÷fW#¦&r×&VBÓSó3G&ç6—F–öâÖ6öÆ÷'2fÆW‚—FV×2Ö6VçFW"vÓãR#àĞ¢Å‚6Æ74æÖSÒ'rÓ2ãR‚Ó2ãR"óâæVvF—f Ğ¢Âö'WGFöãàĞ¢ÂöF—càĞ¢—ĞĞ¢ÂöF—càĞ¢ÂöF—câ Ğ¢çVÆÇĞĞ¢ÆF—càĞ¢Æƒ26Æ74æÖSÒ'FW‡B×‡2föçB×6VÖ–&öÆBFW‡B×6ÆFRÓ3Ö"Ó"fÆW‚—FV×2Ö6VçFW"vÓãR#àĞ¢ÄÆ—7Df–ÇFW"6Æ74æÖSÒ'rÓ2ãR‚Ó2ãR"óâ·6V&6…FW&×2æÆVæwF‡Ò6V&6‚FW&×26GW&F÷0Ğ¢Âöƒ3àĞ¢·6V&6…FW&×2æÆVæwF‚ÓÓÒğĞ¢Ç6Æ74æÖSÒ'FW‡B×6ÒFW‡B×6ÆFRÓSFW‡BÖ6VçFW"’Ó‚#å6VÒ6V&6‚FW&×2–æFãÂ÷â Ğ Ğ¢ÇF&ÆR6Æ74æÖSÒ'rÖgVÆÂFW‡B×6Ò#àĞ¢ÇF†VCàĞ¢ÇG"6Æ74æÖSÒ&&÷&FW"Ö"&÷&FW"×7W&f6RÓ"#àĞ¢µ²u6V&6‚FW&ÒrÂt6Æ–6·2rÂu7VæBrÂufVæF2rÂt6õ2rÂt:|:6òuÒæÖ‚†‚’ÓàĞ¢ÇF‚¶W“×¶‡Ò6Æ74æÖSÒ'‚ÓB’Ó"ãRFW‡BÖÆVgBFW‡B×‡2föçB×6VÖ–&öÆBFW‡B×6ÆFRÓSWW&66RG&6¶–ær×v–FW"v†—FW76RÖæ÷w&#ç¶‡ÓÂ÷FƒàĞ¢—ĞĞ¢Â÷G#àĞ¢Â÷F†VCàĞ¢ÇF&öG“àĞ¢·6V&6…FW&×2æÖ‚‡7B’Óâ°Ğ¢6öç7B—5v7F–ærÒ‡7Bæ6Æ–6·2ÇÂ’ãÒRbb‡7Bç7VæBÇÂ’ãÒ"bb‡7Bç6ÆW2ÇÂ’ÓÓÒ°Ğ¢6öç7B—4vööBÒ‡7Bç6ÆW2ÇÂ’âbb‡7Bæ6÷2ÇÂ’âbb‡7Bæ6÷2ÇÂ’ÂC°Ğ¢&WGW&â€Ğ¢ÇG"¶W“×·7Bæ–GÒ6Æ74æÖSÒ&&÷&FW"Ö"&÷&FW"×7W&f6RÓ"óC†÷fW#¦&r×7W&f6RÓ"ó3#àĞ¢ÇFB6Æ74æÖSÒ'‚ÓB’Ó"ãRFW‡B×6ÆFRÓ3Ö‚×rÕ³#…ÒG'Væ6FR#ç·7Bæ¶W—v÷&E÷FW‡BÇÂ7Bæ¶W—v÷&BÇÂ~(	BwÓÂ÷FCàĞ¢ÇFB6Æ74æÖSÒ'‚ÓB’Ó"ãRFW‡B×6ÆFRÓC#ç²‡7Bæ6Æ–6·2ÇÂ’çFôÆö6ÆU7G&–ær‚—ÓÂ÷FCàĞ¢ÇFB6Æ74æÖSÒ'‚ÓB’Ó"ãRFW‡B×6ÆFRÓC#å"G²‡7Bç7VæBÇÂ’çFôf—†VBƒ"—ÓÂ÷FCàĞ¢ÇFB6Æ74æÖSÒ'‚ÓB’Ó"ãRFW‡BÖVÖW&ÆBÓC#å"G²‡7Bç6ÆW2ÇÂ’çFôf—†VBƒ"—ÓÂ÷FCàĞ¢ÇFB6Æ74æÖS×¶‚ÓB’Ó"ãRföçB×6VÖ–&öÆBG²‡7Bæ6÷2ÇÂ’âSòwFW‡B×&VBÓCr¢‡7Bæ6÷2ÇÂ’â3òwFW‡BÖÖ&W"ÓCr¢‡7Bæ6÷2ÇÂ’âòwFW‡BÖVÖW&ÆBÓCr¢wFW‡B×6ÆFRÓcwÖÓàĞ¢²‡7Bæ6÷2ÇÂ’âòG²‡7Bæ6÷2ÇÂ’çFôf—†VBƒ—ÒV¢~(	BwĞĞ¢Â÷FCàĞ¢ÇFB6Æ74æÖSÒ'‚ÓB’Ó"ãR#àĞ¢¶—4vööBğĞ¢òò6×æ†2ÔåT•3¢7&–"æ÷f6×æ†VÒfW¢FRF–6–öæ"¶W—v÷&@Ğ¢‡6VÆV7FVD6×–vãòçF&vWF–æu÷G—RÇÂrr’çFõWW$66R‚’ÓÓÒtÔåTÂrğĞ¢Æ'WGFöàĞ¢öä6Æ–6³×²‚’Óâ°Ğ¢6öç7B&öBÒ&öGV7G2æf–æB‚‡’Óâæ6–âÓÓÒ‡7BæGfW'F—6VEö6–âÇÂ6VÆV7FVD6×–vãòæ6–â’“°Ğ¢–b‡&öB’6WD¶–6¶öfe&öGV7B‡&öB“°Ğ¢×ĞĞ¢F—FÆSÒ$7&–æ÷f6×æ†6ì;Fæ–6&W7FRFW&Öòƒ6×æ†Ò¶W—v÷&BU„5B’ Ğ¢6Æ74æÖSÒ'‚Ó"ãR’ÓFW‡B×‡2föçB×6VÖ–&öÆB&r×f–öÆWBÓSó#FW‡B×f–öÆWBÓC&÷&FW"&÷&FW"×f–öÆWBÓSó3&÷VæFVBÖÆr†÷fW#¦&r×f–öÆWBÓSó3G&ç6—F–öâÖ6öÆ÷'2fÆW‚—FV×2Ö6VçFW"vÓ#àĞ¢ÅÇW26Æ74æÖSÒ'rÓ2‚Ó2"óâæ÷f6×æ†Ğ¢Âö'WGFöãâ Ğ Ğ¢Æ'WGFöâöä6Æ–6³×²‚’Óâ&öÖ÷FT¶W—v÷&B‡7B—ĞĞ¢6Æ74æÖSÒ'‚Ó"ãR’ÓFW‡B×‡2föçB×6VÖ–&öÆB&rÖVÖW&ÆBÓSó#FW‡BÖVÖW&ÆBÓC&÷&FW"&÷&FW"ÖVÖW&ÆBÓSó3&÷VæFVBÖÆr†÷fW#¦&rÖVÖW&ÆBÓSó3G&ç6—F–öâÖ6öÆ÷'2fÆW‚—FV×2Ö6VçFW"vÓ#àĞ¢ÅÇW26Æ74æÖSÒ'rÓ2‚Ó2"óâ&öÖ÷fW Ğ¢Âö'WGFöãâ Ğ Ğ¢—5v7F–ærğĞ¢Ç7â6Æ74æÖSÒ'FW‡B×‡2FW‡B×&VBÓCfÆW‚—FV×2Ö6VçFW"vÓ#ãÅG&VæF–ætF÷vâ6Æ74æÖSÒ'rÓ2‚Ó2"óâFW7W&L:Ö6–óÂ÷7ãâ Ğ Ğ¢Ç7â6Æ74æÖSÒ'FW‡B×‡2FW‡B×6ÆFRÓS#äö'6W'f#Â÷7ãàĞ¢ĞĞ¢Â÷FCàĞ¢Â÷G#â“°Ğ Ğ¢Ò—ĞĞ¢Â÷F&öG“àĞ¢Â÷F&ÆSàĞ¢ĞĞ¢ÂöF—càĞ¢ÂöF—câĞ¢ĞĞ¢ÂöF—càĞ¢ÂóàĞ¢ĞĞ¢ÂöF—càĞ Ğ¢²ò¢Fö7BFR7V6W76ò&&VF—f"²'VFvWB¢÷ĞĞ¢·&V7F—fFT'VFvWEFö7Bbb€Ğ¢ÆF—b6Æ74æÖSÒ&f—†VB&÷GFöÒÓb&–v‡BÓb¢ÓSfÆW‚—FV×2×7F'BvÓ2‚ÓB’Ó2&rÕ²3ƒ#uÒ&÷&FW"&÷&FW"ÖVÖW&ÆBÓSó3&÷VæFVB×†Â6†F÷rÓ'†ÂÖ‚×r×6Òæ–ÖFRÖfFRÖ–â#àĞ¢Ä6†V6´6—&6ÆR6Æ74æÖSÒ'rÓB‚ÓBFW‡BÖVÖW&ÆBÓCfÆW‚×6‡&–æ²Ó×BÓãR"óàĞ¢ÆF—b6Æ74æÖSÒ&fÆW‚ÓÖ–â×rÓ#àĞ¢Ç6Æ74æÖSÒ'FW‡B×6ÒföçB×6VÖ–&öÆBFW‡B×v†—FR#ä6×æ†&VF—fF6öÒ7V6W76òÂ÷àĞ¢Ç6Æ74æÖSÒ'FW‡B×‡2FW‡B×6ÆFRÓC×BÓãRG'Væ6FR#ç·&V7F—fFT'VFvWEFö7Bæ6×–väæÖWÓÂ÷àĞ¢Ç6Æ74æÖSÒ'FW‡B×‡2FW‡BÖVÖW&ÆBÓC×BÓãR#àĞ¢'VFvWC¢"G·&V7F—fFT'VFvWEFö7Bç&Wd'VFvWBçFôf—†VBƒ"—Ò(i""G·&V7F—fFT'VFvWEFö7BææWt'VFvWBçFôf—†VBƒ"—Ò+r7FGW3¢W6Fò(i"Tä$ÄT@Ğ¢Â÷àĞ¢·&V7F—fFT'VFvWEFö7Bæ'VFvWEv&æ–ærbb€Ğ¢Ç6Æ74æÖSÒ'FW‡B×‡2FW‡BÖÖ&W"ÓC×BÓãR#î)ª·&V7F—fFT'VFvWEFö7Bæ'VFvWEv&æ–æwÓÂ÷àĞ¢—ĞĞ¢ÂöF—càĞ¢Æ'WGFöâöä6Æ–6³×²‚’Óâ6WE&V7F—fFT'VFvWEFö7B†çVÆÂ—Ò6Æ74æÖSÒ'FW‡B×6ÆFRÓS†÷fW#§FW‡B×v†—FRfÆW‚×6‡&–æ²Ó#àĞ¢Å‚6Æ74æÖSÒ'rÓ2ãR‚Ó2ãR"óàĞ¢Âö'WGFöãàĞ¢ÂöF—càĞ¢—ĞĞ Ğ¢²ò¢&VF—f"²§W7F"'VFvWBÖöFÂ¢÷ĞĞ¢·&V7F—fFT'VFvWDÖöFÂbb66÷VçBbb€Ğ¢Å&V7F—fFUv—F„'VFvWDÖöFÀĞ¢6×–vã×·&V7F—fFT'VFvWDÖöFÇĞĞ¢66÷VçC×¶66÷VçGĞĞ¢öä6Æ÷6S×²‚’Óâ6WE&V7F—fFT'VFvWDÖöFÂ†çVÆÂ—ĞĞ¢öäFöæS×²‡WFFW2’Óâ°Ğ¢6öç7B–BÒ&V7F—fFT'VFvWDÖöFÂæ–C°Ğ¢òòâGVÆ—¦"Æ—7F(	B&÷L:6ò6×–vä6öÇVÖâFW6&V6R‡7FFRÒwW6VBrĞ¢6WD6×–vç2‚‡&Wb’Óâ&WbæÖ‚†2’ÓàĞ¢2æ–BÓÓÒ–Bò²ââæ2ÂââçWFFW2Â7FFS¢vVæ&ÆVBrÂ7FGW3¢vVæ&ÆVBrÒ¢0Ğ¢’“°Ğ¢òò"âGVÆ—¦"6×æ†6VÆV6–öæF(	B&÷L:6ò†VFW"FW6&V6PĞ¢–b‡6VÆV7FVD6×–vãòæ–BÓÓÒ–B’°Ğ¢6WE6VÆV7FVD6×–vâ‚‡&Wb’Óâ‡²ââç&WbÂââçWFFW2Â7FFS¢vVæ&ÆVBrÂ7FGW3¢vVæ&ÆVBrÒ’“°Ğ¢ĞĞ¢òò2âfV6†"ÖöFÀĞ¢6WE&V7F—fFT'VFvWDÖöFÂ†çVÆÂ“°Ğ¢×ĞĞ¢óàĞ¢—ĞĞ Ğ¢¶¶–6¶öfe&öGV7Bbb66÷VçBğĞ¢Ä¶–6¶öfdÖöFÀĞ¢&öGV7C×¶¶–6¶öfe&öGV7GĞĞ¢66÷VçC×¶66÷VçGĞĞ¢öä6Æ÷6S×²‚’Óâ6WD¶–6¶öfe&öGV7B†çVÆÂ—ĞĞ¢öäFöæS×²‚’Óâ·6WD¶–6¶öfe&öGV7B†çVÆÂ“¶ÆöD6×–vç2‚“·×Òóâ Ğ¢çVÆÇĞĞ Ğ¢·6†÷u&÷÷6ÄÖöFÂbb66÷VçBğĞ¢ÄÖçVÄ6×–vå&÷÷6ÄÖöFÀĞ¢66÷VçC×¶66÷VçGĞĞ¢öä6Æ÷6S×²‚’Óâ6WE6†÷u&÷÷6ÄÖöFÂ†fÇ6R—ĞĞ¢öäFöæS×¶ÆöD6×–vç7Òóâ Ğ Ğ¢çVÆÇĞĞ Ğ¢·6†÷t7&VFUv—¦&Bbb66÷VçBğĞ¢Ä7&VFT6×–våv—¦&@Ğ¢66÷VçC×¶66÷VçGĞĞ¢&öGV7G3×·&öGV7G7ĞĞ¢öä6Æ÷6S×²‚’Óâ6WE6†÷t7&VFUv—¦&B†fÇ6R—ĞĞ¢öäFöæS×¶ÆöD6×–vç7Òóâ Ğ¢çVÆÇĞĞ¢ÂöF—câ“°Ğ Ğ§Ğ