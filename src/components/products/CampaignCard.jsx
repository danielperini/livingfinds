import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Rocket, Pause, Play, Plus, RefreshCw, Loader2, AlertCircle } from 'lucide-react';

const UI_STATES = {
  CHECKING: 'CHECKING',
  NOT_CREATED: 'NOT_CREATED',
  CREATING: 'CREATING',
  ACTIVE: 'ACTIVE',
  PAUSING: 'PAUSING',
  PAUSED: 'PAUSED',
  ACTIVATING: 'ACTIVATING',
  ARCHIVED: 'ARCHIVED',
  ERROR: 'ERROR',
  NEEDS_RECONCILIATION: 'NEEDS_RECONCILIATION',
};

const ACTION_BY_STATE = {
  NOT_CREATED: 'KICK_OFF',
  ACTIVE: 'PAUSE',
  PAUSED: 'ENABLE',
  ARCHIVED: 'CREATE_NEW',
  ERROR: 'RETRY',
};

const STATE_LABELS = {
  [UI_STATES.CHECKING]: 'Verificando...',
  [UI_STATES.CREATING]: 'Criando...',
  [UI_STATES.PAUSING]: 'Pausando...',
  [UI_STATES.ACTIVATING]: 'Ativando...',
};

export default function CampaignCard({ asin, accountId, onCampaignChange }) {
  const [uiState, setUiState] = useState(UI_STATES.CHECKING);
  const [campaign, setCampaign] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const loadCampaignState = useCallback(async () => {
    setUiState(UI_STATES.CHECKING);
    setError(null);
    
    try {
      // 1. Verificar campanhas locais
      const localCampaigns = await base44.entities.Campaign.filter({ 
        amazon_account_id: accountId, 
        asin 
      });

      if (localCampaigns.length === 0) {
        // 2. Verificar na Amazon se existe campanha
        try {
          const amazonRes = await base44.functions.invoke('verifyAmazonCampaignState', {
            amazon_account_id: accountId,
            asin,
          });
          
          if (amazonRes.data?.ok && amazonRes.data?.campaign) {
            // Campanha encontrada na Amazon mas não no banco - sincronizar
            const amazonCampaign = amazonRes.data.campaign;
            await base44.entities.Campaign.create({
              amazon_account_id: accountId,
              campaign_id: amazonCampaign.campaign_id,
              campaign_name: amazonCampaign.name,
              asin,
              state: amazonCampaign.state?.toLowerCase() || 'enabled',
              daily_budget: amazonCampaign.budget?.budget || 0,
              start_date: amazonCampaign.startDate,
              created_by_app: false,
            });
            setCampaign({
              campaign_id: amazonCampaign.campaign_id,
              campaign_name: amazonCampaign.name,
              state: amazonCampaign.state?.toLowerCase(),
              daily_budget: amazonCampaign.budget?.budget,
              start_date: amazonCampaign.startDate,
            });
            
            if (amazonCampaign.state === 'ENABLED') {
              setUiState(UI_STATES.ACTIVE);
            } else if (amazonCampaign.state === 'PAUSED') {
              setUiState(UI_STATES.PAUSED);
            } else if (amazonCampaign.state === 'ARCHIVED') {
              setUiState(UI_STATES.ARCHIVED);
            }
            return;
          }
        } catch (amazonErr) {
          console.error('Erro ao verificar Amazon:', amazonErr.message);
        }
        
        setUiState(UI_STATES.NOT_CREATED);
        setCampaign(null);
        return;
      }

      const activeCampaign = localCampaigns.find(c => !c.archived);
      
      if (!activeCampaign) {
        const archivedCampaign = localCampaigns[localCampaigns.length - 1];
        setCampaign(archivedCampaign);
        setUiState(UI_STATES.ARCHIVED);
        return;
      }

      setCampaign(activeCampaign);

      // 3. Verificar estado real na Amazon
      try {
        const amazonRes = await base44.functions.invoke('verifyAmazonCampaignState', {
          amazon_account_id: accountId,
          campaign_id: activeCampaign.campaign_id,
        });
        
        if (amazonRes.data?.ok && amazonRes.data?.campaign) {
          const amazonState = amazonRes.data.campaign.state;
          const localState = activeCampaign.state?.toLowerCase();
          
          // Atualizar estado local se diferente da Amazon
          if (amazonState && amazonState.toLowerCase() !== localState) {
            await base44.entities.Campaign.update(activeCampaign.id, {
              state: amazonState.toLowerCase(),
              campaign_status: amazonState.toLowerCase(),
            });
            activeCampaign.state = amazonState.toLowerCase();
          }
        }
      } catch (amazonErr) {
        console.error('Erro ao sincronizar com Amazon:', amazonErr.message);
      }

      if (activeCampaign.state === 'enabled' || activeCampaign.campaign_status === 'active') {
        setUiState(UI_STATES.ACTIVE);
      } else if (activeCampaign.state === 'paused' || activeCampaign.campaign_status === 'paused') {
        setUiState(UI_STATES.PAUSED);
      } else if (activeCampaign.state === 'archived' || activeCampaign.archived) {
        setUiState(UI_STATES.ARCHIVED);
      } else {
        setUiState(UI_STATES.NEEDS_RECONCILIATION);
      }
    } catch (err) {
      setError(err.message);
      setUiState(UI_STATES.ERROR);
    }
  }, [accountId, asin]);

  useEffect(() => {
    loadCampaignState();
  }, [loadCampaignState]);

  const handleKickOff = async () => {
    setLoading(true);
    setUiState(UI_STATES.CREATING);
    
    try {
      const res = await base44.functions.invoke('createAutoCampaignForAsin', {
        amazon_account_id: accountId,
        asin,
      });

      if (res.data?.ok) {
        if (res.data.already_exists || res.data.reconciled) {
          alert('Esta campanha já existia e foi sincronizada com sucesso.');
        } else {
          alert('Campanha criada com sucesso.');
        }
        onCampaignChange?.();
        await loadCampaignState();
      } else {
        throw new Error(res.data?.error || 'Falha ao criar campanha');
      }
    } catch (err) {
      setError(err.message);
      setUiState(UI_STATES.ERROR);
      alert(`Erro: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handlePause = async () => {
    if (!confirm('Tens a certeza de que pretendes pausar esta campanha? Os anúncios deixarão de ser exibidos até a campanha ser reativada.')) {
      return;
    }

    setLoading(true);
    setUiState(UI_STATES.PAUSING);

    try {
      const res = await base44.functions.invoke('pauseCampaign', {
        amazon_account_id: accountId,
        campaign_id: campaign.campaign_id,
      });

      if (res.data?.ok) {
        alert('Campanha pausada com sucesso.');
        onCampaignChange?.();
        await loadCampaignState();
      } else {
        throw new Error(res.data?.error || 'Falha ao pausar campanha');
      }
    } catch (err) {
      setError(err.message);
      setUiState(UI_STATES.ERROR);
      alert(`Erro: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleEnable = async () => {
    if (!confirm('Tens a certeza de que pretendes ativar esta campanha?')) {
      return;
    }

    setLoading(true);
    setUiState(UI_STATES.ACTIVATING);

    try {
      const res = await base44.functions.invoke('reactivateCampaigns', {
        amazon_account_id: accountId,
        campaign_ids: [campaign.campaign_id],
      });

      if (res.data?.ok) {
        alert('Campanha ativada com sucesso.');
        onCampaignChange?.();
        await loadCampaignState();
      } else {
        throw new Error(res.data?.error || 'Falha ao ativar campanha');
      }
    } catch (err) {
      setError(err.message);
      setUiState(UI_STATES.ERROR);
      alert(`Erro: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateNewVersion = async () => {
    const date = new Date().toISOString().slice(0, 10);
    const version = (campaign?.version || 0) + 1;
    const newName = `AUTO | ${asin} | V${version} | ${date}`;
    
    if (!confirm(`Criar nova campanha com nome: ${newName}?`)) {
      return;
    }

    setLoading(true);
    setUiState(UI_STATES.CREATING);

    try {
      const res = await base44.functions.invoke('createAutoCampaignForAsin', {
        amazon_account_id: accountId,
        asin,
        custom_name: newName,
      });

      if (res.data?.ok) {
        alert('Nova campanha criada com sucesso.');
        onCampaignChange?.();
        await loadCampaignState();
      } else {
        throw new Error(res.data?.error || 'Falha ao criar campanha');
      }
    } catch (err) {
      setError(err.message);
      setUiState(UI_STATES.ERROR);
      alert(`Erro: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const isError = uiState === UI_STATES.ERROR;
  const lastSync = campaign?.synced_at ? new Date(campaign.synced_at) : null;

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-4 space-y-3">
      {/* Cabeçalho */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Campanha Automática</h3>
        <button onClick={loadCampaignState} disabled={loading}
          className="p-1.5 text-slate-500 hover:text-cyan transition-colors" title="Sincronizar">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Informações da campanha */}
      <div className="space-y-2 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-slate-500">Produto:</span>
          <span className="text-slate-300 font-mono">{asin}</span>
        </div>
        
        {campaign && (
          <>
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Campanha:</span>
              <span className="text-slate-300 font-mono truncate max-w-[200px]" title={campaign.campaign_name}>
                {campaign.campaign_name || campaign.name}
              </span>
            </div>
            
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Campaign ID:</span>
              <span className="text-cyan font-mono text-[10px]">
                ...{campaign.campaign_id?.slice(-8)}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-slate-500">Estado:</span>
              <span className={`font-semibold ${
                uiState === UI_STATES.ACTIVE ? 'text-emerald-400' :
                uiState === UI_STATES.PAUSED ? 'text-amber-400' :
                'text-slate-400'
              }`}>
                {uiState === UI_STATES.ACTIVE ? 'Ativa' :
                 uiState === UI_STATES.PAUSED ? 'Pausada' :
                 uiState === UI_STATES.ARCHIVED ? 'Arquivada' : '—'}
              </span>
            </div>

            {campaign.daily_budget && (
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Orçamento diário:</span>
                <span className="text-slate-300">${campaign.daily_budget.toFixed(2)}</span>
              </div>
            )}

            {lastSync && (
              <div className="text-[10px] text-slate-600">
                Última sincronização: {lastSync.toLocaleTimeString('pt-BR')}
              </div>
            )}
          </>
        )}

        {uiState === UI_STATES.NOT_CREATED && (
          <div className="text-center py-2">
            <p className="text-slate-400">Campanha ainda não criada</p>
          </div>
        )}

        {uiState === UI_STATES.ARCHIVED && (
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-2 text-[10px] text-amber-300">
            <AlertCircle className="w-3 h-3 inline mr-1" />
            Campanhas arquivadas não podem ser reativadas.
          </div>
        )}

        {isError && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2 text-[10px] text-red-400">
            <AlertCircle className="w-3 h-3 inline mr-1" />
            Erro: {error}
          </div>
        )}
      </div>

      {/* Botões de ação */}
      <div className="pt-3 border-t border-surface-2">
        {uiState === UI_STATES.NOT_CREATED && (
          <button onClick={handleKickOff} disabled={loading}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-cyan hover:bg-cyan/90 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-50">
            <Rocket className="w-3.5 h-3.5" />
            Kick Off
          </button>
        )}

        {uiState === UI_STATES.ACTIVE && (
          <button onClick={handlePause} disabled={loading}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 border border-amber-500/30 text-xs font-semibold rounded-lg transition-colors disabled:opacity-50">
            <Pause className="w-3.5 h-3.5" />
            Pausar campanha
          </button>
        )}

        {uiState === UI_STATES.PAUSED && (
          <button onClick={handleEnable} disabled={loading}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 border border-emerald-500/30 text-xs font-semibold rounded-lg transition-colors disabled:opacity-50">
            <Play className="w-3.5 h-3.5" />
            Ativar campanha
          </button>
        )}

        {uiState === UI_STATES.ARCHIVED && (
          <button onClick={handleCreateNewVersion} disabled={loading}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-cyan hover:bg-cyan/90 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-50">
            <Plus className="w-3.5 h-3.5" />
            Criar nova campanha
          </button>
        )}

        {loading && uiState !== UI_STATES.CHECKING && (
          <button disabled
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-surface-3 text-slate-400 text-xs font-semibold rounded-lg">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {STATE_LABELS[uiState]}
          </button>
        )}

        {isError && (
          <button onClick={loadCampaignState}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-surface-2 border border-slate-600 text-slate-400 text-xs font-semibold rounded-lg hover:text-white transition-colors">
            <RefreshCw className="w-3.5 h-3.5" />
            Tentar novamente
          </button>
        )}

        {uiState === UI_STATES.NEEDS_RECONCILIATION && (
          <button onClick={loadCampaignState} disabled={loading}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-50">
            <RefreshCw className="w-3.5 h-3.5" />
            Sincronizar campanha
          </button>
        )}
      </div>

      {/* Texto auxiliar */}
      {uiState === UI_STATES.NOT_CREATED && (
        <p className="text-[10px] text-slate-500 text-center">
          Crie uma campanha automática para recolher termos de pesquisa e dados iniciais de desempenho.
        </p>
      )}
    </div>
  );
}