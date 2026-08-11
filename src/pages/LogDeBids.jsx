import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  FileText, Search, RefreshCw, Loader2,
  Minus, XCircle, Filter, TrendingUp, TrendingDown, Download, AlertTriangle, Play, CheckCircle2
} from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  LineChart, Line, AreaChart, Area, ReferenceLine,
} from 'recharts';

const normalizeAsin = value => {
  const asin = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(asin) ? asin : '';
};

const buildCampaignAsinMap = (campaigns, productAds) => {
  const candidates = new Map();
  const add = row => {
    const campaignId = String(row?.campaign_id || row?.amazon_campaign_id || '').trim();
    const asin = normalizeAsin(row?.asin);
    if (!campaignId || !asin) return;
    if (!candidates.has(campaignId)) candidates.set(campaignId, new Set());
    candidates.get(campaignId).add(asin);
  };
  campaigns.forEach(add);
  productAds.forEach(add);
  return new Map(
    [...candidates.entries()]
      .filter(([, asins]) => asins.size === 1)
      .map(([campaignId, asins]) => [campaignId, [...asins][0]])
  );
};

export default function LogDeBids() {
  const [account, setAccount] = useState(null);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ direction: 'all', status: 'all', date: '' });
  const [error, setError] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const [runningBidEngine, setRunningBidEngine] = useState(false);
  const [bidEngineMsg, setBidEngineMsg] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0] || (await base44.entities.AmazonAccount.list())[0];
      setAccount(acc);
      if (!acc) return;

      // Buscar de 3 fontes: AdsBidChangeLog, OptimizationDecision e CampaignChangeHistory
      const [apiLogs, autopilotDecs, campaignHistory, campaigns, productAds] = await Promise.all([
        base44.entities.AdsBidChangeLog.filter({ amazon_account_id: acc.id }, '-created_at', 300),
        base44.entities.OptimizationDecision.filter(
          { amazon_account_id: acc.id, decision_type: 'bid_change' }, '-created_at', 300
        ),
        base44.entities.CampaignChangeHistory.filter(
          { amazon_account_id: acc.id, change_type: 'BASE_BID' }, '-changed_at', 300
        ),
        base44.entities.Campaign.filter({ amazon_account_id: acc.id }, '-updated_date', 5000).catch(() => []),
        base44.entities.ProductAd.filter({ amazon_account_id: acc.id }, '-updated_date', 10000).catch(() => []),
      ]);
      const campaignAsinById = buildCampaignAsinMap(campaigns, productAds);
      const resolveAsin = row => normalizeAsin(row?.asin)
        || campaignAsinById.get(String(row?.campaign_id || row?.amazon_campaign_id || '').trim())
        || '';

      const normalizedApiLogs = apiLogs.map(l => {
        const oldBid = Number(l.old_bid ?? l.bid_before ?? 0);
        const newBid = Number(l.new_bid ?? l.bid_after ?? 0);
        const diff = newBid - oldBid;
        return {
          ...l,
          date: l.date || l.created_at?.slice(0, 10) || l.created_date?.slice(0, 10) || '',
          keyword: l.keyword || l.keyword_text || '',
          asin: resolveAsin(l),
          old_bid: oldBid,
          new_bid: newBid,
          change_amount: l.change_amount ?? diff,
          change_percent: l.change_percent ?? l.change_pct ?? (oldBid > 0 ? (diff / oldBid) * 100 : 0),
          direction: l.direction || (diff > 0.001 ? 'increase' : diff < -0.001 ? 'decrease' : 'unchanged'),
          _source: 'api',
        };
      });

      // Normalizar OptimizationDecision
      const decLogs = autopilotDecs.map(d => ({
        id: `dec_${d.id}`,
        date: d.executed_at?.slice(0, 10) || d.created_at?.slice(0, 10) || '',
        campaign_id: d.campaign_id || '',
        campaign_name: '',
        keyword_id: d.keyword_id || d.entity_id || '',
        keyword: d.keyword_text || '',
        asin: resolveAsin(d),
        old_bid: d.value_before || 0,
        new_bid: d.value_after || 0,
        change_amount: (d.value_after || 0) - (d.value_before || 0),
        change_percent: d.change_pct || 0,
        direction: d.action?.includes('increase') ? 'increase' : d.action?.includes('reduce') ? 'decrease' : 'unchanged',
        reason: d.rationale?.slice(0, 120) || d.action || '',
        ai_confidence: d.confidence ? d.confidence / 100 : 0,
        risk_level: d.risk || 'low',
        status: d.status === 'executed' ? 'executed' : d.status === 'approved' ? 'pending' : d.status || 'pending',
        created_at: d.created_at || '',
        _source: 'autopilot',
      }));

      // Normalizar CampaignChangeHistory (BASE_BID)
      const histLogs = campaignHistory.map(h => {
        const oldVal = parseFloat(h.old_value) || 0;
        const newVal = parseFloat(h.new_value) || 0;
        const diff = newVal - oldVal;
        return {
          id: `hist_${h.id}`,
          date: h.changed_at?.slice(0, 10) || h.created_date?.slice(0, 10) || '',
          campaign_id: h.campaign_id || '',
          campaign_name: h.campaign_id || '',
          keyword_id: h.keyword_id || '',
          keyword: h.keyword_id || '',
          asin: resolveAsin(h),
          old_bid: oldVal,
          new_bid: newVal,
          change_amount: diff,
          change_percent: oldVal > 0 ? ((diff / oldVal) * 100) : 0,
          direction: diff > 0.001 ? 'increase' : diff < -0.001 ? 'decrease' : 'unchanged',
          reason: h.reason || h.source || '',
          ai_confidence: 0,
          risk_level: 'low',
          status: h.status === 'executed' ? 'executed' : h.status || 'executed',
          created_at: h.changed_at || h.created_date || '',
          _source: 'history',
        };
      });

      // Unir e ordenawßOt¶‰žËkºwµçR†Æöræ7&VFVEöBÇÂÆöræ7&VFVEöFFRÇÂ’ævWEF–ÖR‚“°¢–b„çVÖ&W"æ—4f–æ—FR‡F–ÖW7F×’bbF–ÖW7F×â†Æ7D&–D6†ævT'”¶W—v÷&BævWB†¶W—v÷&D–B’ÇÂ’’°¢Æ7D&–D6†ævT'”¶W—v÷&Bç6WB†¶W—v÷&D–BÂF–ÖW7F×“°¢Ð¢Ð ¢6öç7B7F—fTÆW'Dw&÷W2ÒæWrÖÇ7G&–ærÂç•µÓâ‚“°¢f÷"†6öç7BÆW'Böb²ââæ7F—fTÆW'G2Âââæ6¶æ÷vÆVFvVDÆW'G5Ò’°¢6öç7B¶W’ÒÆW'D¶W’†ÆW'B“°¢–b‚7F—fTÆW'Dw&÷W2æ†2†¶W’’’7F—fTÆW'Dw&÷W2ç6WB†¶W’ÂµÒ“°¢7F—fTÆW'Dw&÷W2ævWB†¶W’’çW6‚†ÆW'B“°¢Ð¢6öç7B¶VWW$ÆW'D'”¶W—v÷&BÒæWrÖÇ7G&–ærÂç“â‚“°¢6öç7BÆW'EWFFW2ÒæWrÖÇ7G&–ærÂç“â‚“°¢f÷"†6öç7B¶¶W’ÂÆW'G5Òöb7F—fTÆW'Dw&÷W2’°¢ÆW'G2ç6÷'B‚†ÆVgBÂ&–v‡B’Óâ&÷uF–ÖR‡&–v‡B’Ò&÷uF–ÖR†ÆVgB’“°¢–b†¶W’’¶VWW$ÆW'D'”¶W—v÷&Bç6WB†¶W’ÂÆW'G5³Ò“°¢f÷"†6öç7BGWÆ–6FRöbÆW'G2ç6Æ–6Rƒ’’°¢ÆW'EWFFW2ç6WB†GWÆ–6FRæ–BÂ°¢–C¢GWÆ–6FRæ–BÀ¢7FGW3¢w&W6öÇfVBrÀ¢&W6öÇfVEöC¢æ÷t—6òÀ¢&W6öÇWF–öå÷&V6öã¢vGWÆ–6FUöæõö–×&W76–öç5öÆW'BrÀ¢WFFVEöC¢æ÷t—6òÀ¢Ò“°¢7VÖÖ'’æGWÆ–6FUöÆW'G5÷&W6öÇfVB²³°¢Ð¢Ð ¢6öç7BWfÇVFVD¶W—v÷&D–G2ÒæWr6WCÇ7G&–æsâ‚“°¢6öç7B&Vg&W6…Fö¶VâÒ66÷VçBæG5÷&Vg&W6…÷Fö¶VâÇÂFVæòæVçbævWB‚tE5õ$Te$U4…õDô´Târ’ÇÂrs°¢6öç7B&öf–ÆT–BÒ66÷VçBæG5÷&öf–ÆUö–BÇÂFVæòæVçbævWB‚tE5õ$ôd”ÄUô”Br’ÇÂrs° ¢f÷"†6öç7B¶¶W—v÷&D–BÂ¶W—v÷&EÒöb¶W—v÷&G4'”–B’°¢6öç7B¶W—v÷&DVæ&ÆVBÒÆ÷vW"†¶W—v÷&Bç7FFRÇÂ¶W—v÷&Bç7FGW2’ÓÓÒvVæ&ÆVBs°¢–b‚¶W—v÷&DVæ&ÆVBbb¶VWW$ÆW'D'”¶W—v÷&Bæ†2†¶W—v÷&D–B’’6öçF–çVS°¢WfÇVFVD¶W—v÷&D–G2æFB†¶W—v÷&D–B“°¢6öç7B¶VWW$ÆW'BÒ¶VWW$ÆW'D'”¶W—v÷&BævWB†¶W—v÷&D–B“°¢6öç7Bf—'7E6VVäBÒæWrFFR†¶W—v÷&Bæf—'7E÷6VVåöBÇÂ¶W—v÷&Bç7–æ6VEöBÇÂ¶W—v÷&Bæ7&VFVEöFFRÇÂ’ævWEF–ÖR‚“°¢–b†¶W—v÷&DVæ&ÆVBbbçVÖ&W"æ—4f–æ—FR†f—'7E6VVäB’bbf—'7E6VVäBãÒ7WFöfcC†‚’°¢–b†¶VWW$ÆW'B’°¢ÆW'EWFFW2ç6WB†¶VWW$ÆW'Bæ–BÂ°¢–C¢¶VWW$ÆW'Bæ–BÀ¢7FGW3¢w7FÆRrÀ¢&W6öÇWF–öå÷&V6öã¢v¶W—v÷&EövU÷VæFW%óC†‚rÀ¢FFög&W6†æW73¢wVæ¶æ÷vârÀ¢WFFVEöC¢æ÷t—6òÀ¢Ò“°¢7VÖÖ'’æÆW'G5÷7FÆVB²³°¢Ð¢6öçF–çVS°¢Ð ¢6öç7B6×–vä–BÒFW‡B†¶W—v÷&Bæ6×–våö–BÇÂ¶VWW$ÆW'Còæ6×–våö–B“°¢6öç7B6×–vâÒ6×–vç4'”–BævWB†6×–vä–B“°¢6öç7B6–âÒFW‡B†¶W—v÷&Bæ6–âÇÂ6×–vãòæ6–âÇÂ¶VWW$ÆW'Còæ6–â’çFõWW$66R‚“°¢6öç7B&öGV7BÒ&öGV7G4'”6–âævWB†6–â“°¢6öç7BV6öæöÖ–72ÒV6öæöÖ–74'”6–âævWB†6–â“°¢6öç7B6–væÂÒF&vWF–æu6–væÇ2ævWB†¶W—v÷&D–B“°¢6öç7B7W'&VçD&–BÒf–æ—FR†¶W—v÷&Bæ7W'&VçEö&–Bóò¶W—v÷&Bæ&–BÂÔ”åô$”B“°¢6öç7BFV6—6–öâÒ6Æ76–g”æô–×&W76–öä6Æ–'&F–öâ‡°¢¶W—v÷&DVæ&ÆVBÀ¢6×–vä¶æ÷vã¢6×–vâÀ¢6×–vå7FFS¢Æ÷vW"†6×–vãòç7FFRÇÂ6×–vãòç7FGW2ÇÂ6×–vãòæÖ¦öå÷7FGW2’À¢6×–vä÷W&F–öæÃ¢6×–vä—4÷W&F–öæÂ†6×–vâ’À¢&öGV7DVÆ–v–&–Æ—G“¢&öGV7DVÆ–v–&–Æ—G’‡&öGV7B’À¢7G'V7GW&U&VG“¢6×–vå7G'V7GW&U&VG’†6×–vâÂVæ&ÆVE&öGV7DG2’À¢V6öæöÖ–75&VG“¢6×–väV6öæöÖ–75&VG’†6×–vâÂV6öæöÖ–72Âæ÷rævWEF–ÖR‚’’À¢¶W—v÷&DÖWG&–4F—3¢6–væÃòæFFW2ç6—¦RÇÂÀ¢¶W—v÷&D–×&W76–öç3¢6–væÂò6–væÂæ–×&W76–öç2¢çVÆÂÀ¢&V6VçD&–D6†ævS¢æ÷rævWEF–ÖR‚’Ò†Æ7D&–D6†ævT'”¶W—v÷&BævWB†¶W—v÷&D–B’ÇÂ’Â$”Eô4ôôÄDõtåôÕ2À¢7W'&VçD&–BÀ¢Ö„&–C¢Ô…ô$”BÀ¢Ò“°¢7VÖÖ'’æ¶W—v÷&G5öæÇ—¦VB²³° ¢–b†FV6—6–öâæ7F–öâÓÓÒu5DÄUôäõôDDr’7VÖÖ'’æ¶W—v÷&G5ö†VÆEöæõöFF²³°¢–b†FV6—6–öâæ7F–öâÓÓÒu5DÄUôuT$E$”Âr’7VÖÖ'’æ¶W—v÷&G5ö†VÆEöwV&G&–Â²³°¢–b†FV6—6–öâæ7F–öâÓÓÒt„ôÄEô4ôäd•$ÔTEõ¤U$òr’7VÖÖ'’æ¶W—v÷&G5ö†VÆEö6öæf—&ÖVE÷¦W&ò²³° ¢6öç7BÆ–fV7–6ÆUWFFRÒFV6—6–öåFôÆW'EWFFR†¶VWW$ÆW'BÂFV6—6–öâÂæ÷t—6ò“°¢–b†Æ–fV7–6ÆUWFFR’°¢ÆW'EWFFW2ç6WB†Æ–fV7–6ÆUWFFRæ–BÂÆ–fV7–6ÆUWFFR“°¢–b†Æ–fV7–6ÆUWFFRç7FGW2ÓÓÒw&W6öÇfVBr’7VÖÖ'’æÆW'G5÷&W6öÇfVB²³°¢–b†Æ–fV7–6ÆUWFFRç7FGW2ÓÓÒw7FÆRr’7VÖÖ'’æÆW'G5÷7FÆVB²³°¢Ð¢–b‚6†÷VÆDÖ–çF–ä7F—fTæô–×&W76–öäÆW'B†FV6—6–öâæ7F–öâ’’6öçF–çVS° ¢ÆWB&W7VÇF–æt&–BÒ7W'&VçD&–C°¢–b†FV6—6–öâæ7F–öâÓÓÒt$ôõ5Eô4ôäd•$ÔTEõ¤U$òrbb&V6öæ6–ÆTöæÇ’’°¢–b‚&Vg&W6…Fö¶VâÇÂ&öf–ÆT–B’°¢7VÖÖ'’æW'&÷'2çW6‚†&ö÷7BG¶¶W—v÷&D–GÓ¢7&VFVæ6–—2Ö¦öâG2W6VçFW6“°¢ÒVÇ6R°¢6öç7B&W7VÇBÒv—BWFFT¶W—v÷&D&–B€¢&6SCBÀ¢66÷VçBÀ¢¶W—v÷&BÀ¢6–âÀ¢ÖF‚æÖ–â†7W'&VçD&–B²$ôõ5EôÔõTåBÂÔ…ô$”B’À¢&Vg&W6…Fö¶VâÀ¢&öf–ÆT–BÀ¢æ÷rÀ¢“°¢–b‡&W7VÇBæö²’°¢7VÖÖ'’æ¶W—v÷&G5ö&ö÷7FVB²³°¢&W7VÇF–æt&–BÒ&W7VÇBææWuö&–BÇÂ7W'&VçD&–C°¢v—BæWr&öÖ—6R‚‡&W6öÇfR’Óâ6WEF–ÖV÷WB‡&W6öÇfRÂ3’“°¢ÒVÇ6R°¢7VÖÖ'’æW'&÷'2çW6‚†&ö÷7BG¶¶W—v÷&D–GÓ¢G·&W7VÇBæW'&÷'Ö“°¢Ð¢Ð¢Ð ¢6öç7BÆW'DÖW76vRÒ¶W—v÷&B"G¶¶W—v÷&Bæ¶W—v÷&E÷FW‡BÇÂ¶W—v÷&Bæ¶W—v÷&BÇÂ¶W—v÷&D–GÒ"†&–BGVÃ¢"BG·&W7VÇF–æt&–BçFôf—†VBƒ"—Ò’FWfR¦W&ò–×&W76öW26öæf—&ÖFò÷"FF÷2F–&–÷2FRF&vWF–æræ2VÇF–Ö2C†‚æ°¢–b†¶VWW$ÆW'B’°¢ÆW'EWFFW2ç6WB†¶VWW$ÆW'Bæ–BÂ°¢–C¢¶VWW$ÆW'Bæ–BÀ¢7FGW3¢v7F—fRrÀ¢6WfW&—G“¢v†–v‚rÀ¢ÖW76vS¢ÆW'DÖW76vRÀ¢ÖWG&–5÷fÇVS¢À¢7W'&VçE÷fÇVS¢À¢FF÷6÷W&6S¢uF&vWF–ætÖWG&–74F–Ç’rÀ¢FFög&W6†æW73¢vg&W6‚rÀ¢Æ7EöFWFV7FVEöC¢æ÷t—6òÀ¢&W6öÇWF–öå÷&V6öã¢FV6—6–öâç&V6öâÀ¢WFFVEöC¢æ÷t—6òÀ¢Ò“°¢ÒVÇ6R°¢v—B&6SCBæ56W'f–6U&öÆRæVçF—F–W2äÆW'Bæ7&VFR‡°¢Ö¦öåö66÷VçEö–C¢66÷VçD–BÀ¢ÆW'E÷G—S¢væõö–×&W76–öç2rÀ¢ÆW'EöfÖ–Ç“¢v¶W—v÷&BrÀ¢6WfW&—G“¢v†–v‚rÀ¢F—FÆS¢t¶W—v÷&B6VÒ–×&W76öW2†C†‚†6öæf—&ÖFò’rÀ¢ÖW76vS¢ÆW'DÖW76vRÀ¢VçF—G•÷G—S¢v¶W—v÷&BrÀ¢VçF—G•ö–C¢¶W—v÷&Bæ–BÀ¢¶W—v÷&Eö–C¢¶W—v÷&D–BÀ¢6×–våö–C¢6×–vä–BÀ¢6–âÀ¢7W'&VçE÷fÇVS¢À¢ÖWG&–5÷fÇVS¢À¢F‡&W6†öÆE÷fÇVS¢À¢FF÷v–æF÷s¢sC†‚rÀ¢FF÷6÷W&6S¢uF&vWF–ætÖWG&–74F–Ç’rÀ¢FFög&W6†æW73¢vg&W6‚rÀ¢7FGW3¢v7F—fRrÀ¢FVGWÆ–6F–öåö¶W“¢G¶66÷VçD–GÓ£¦æõö–×&W76–öç3£¦¶W—v÷&C£¢G¶¶W—v÷&D–GÓ££C††À¢6÷W&6UögVæ7F–öã¢v6Æ–'&FT&–G4æô–×&W76–öç2rÀ¢f—'7EöFWFV7FVEöC¢æ÷t—6òÀ¢Æ7EöFWFV7FVEöC¢æ÷t—6òÀ¢7&VFVEöC¢æ÷t—6òÀ¢Ò“°¢7VÖÖ'’æÆW'G5ö7&VFVB²³°¢Ð¢Ð ¢f÷"†6öç7B¶¶W’ÂÆW'G5Òöb7F—fTÆW'Dw&÷W2’°¢–b†WfÇVFVD¶W—v÷&D–G2æ†2†¶W’’’6öçF–çVS°¢6öç7B¶VWW"ÒÆW'G2ç6÷'B‚†ÆVgBÂ&–v‡B’Óâ&÷uF–ÖR‡&–v‡B’Ò&÷uF–ÖR†ÆVgB’•³Ó°¢–b‚¶VWW"ÇÂÆW'EWFFW2æ†2†¶VWW"æ–B’’6öçF–çVS°¢ÆW'EWFFW2ç6WB†¶VWW"æ–BÂ°¢–C¢¶VWW"æ–BÀ¢7FGW3¢¶W’òw&W6öÇfVBr¢w7FÆRrÀ¢âââ†¶W’ò²&W6öÇfVEöC¢æ÷t—6òÒ¢·Ò’À¢&W6öÇWF–öå÷&V6öã¢¶W’òv¶W—v÷&Eöæ÷Eöf÷VæEö÷%öæ÷EöVæ&ÆVBr¢vÆW'E÷v—F†÷WEö¶W—v÷&Eö–FVçF—G’rÀ¢FFög&W6†æW73¢wVæ¶æ÷vârÀ¢WFFVEöC¢æ÷t—6òÀ¢Ò“°¢–b†¶W’’7VÖÖ'’æÆW'G5÷&W6öÇfVB²³°¢VÇ6R7VÖÖ'’æÆW'G5÷7FÆVB²³°¢Ð ¢v—BÇ”ÆW'EWFFW2†&6SCBÂ²ââæÆW'EWFFW2çfÇVW2‚•Ò“°¢7VÖÖ'’æ66÷VçG5÷&ö6W76VB²³°¢Ò6F6‚†66÷VçDW'&÷#¢ç’’°¢7VÖÖ'’æW'&÷'2çW6‚†6öçFG¶66÷VçBæ–GÓ¢G¶66÷VçDW'&÷"æÖW76vWÖ“°¢Ð¢Ð ¢&WGW&â&W7öç6Ræ§6öâ‡°¢ö³¢G'VRÀ¢'VÆS¢v6Æ–'&FUö&–G5öæõö–×&W76–öç5ö6öæf—&ÖVEóC†…÷c"rÀ¢&V6öæ6–ÆUööæÇ“¢&V6öæ6–ÆTöæÇ’À¢&ö÷7EöÖ÷VçC¢$ôõ5EôÔõTåBÀ¢Ö…ö&–C¢Ô…ô$”BÀ¢7VÖÖ'’À¢W†V7WFVEöC¢æ÷t—6òÀ¢Ò“°¢Ò6F6‚†W'&÷#¢ç’’°¢&WGW&â&W7öç6Ræ§6öâ‡²ö³¢fÇ6RÂW'&÷#¢W'&÷"æÖW76vRÒÂ²7FGW3¢SÒ“°¢Ð§Ò“° 