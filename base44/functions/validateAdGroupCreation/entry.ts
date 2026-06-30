/**
 * validateAdGroupCreation — Valida criação de grupos de anúncios conforme regras
 * Verifica: produto único, SKU válido, estoque, elegibilidade, duplicidades, naming
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const {
      amazon_account_id,
      campaign_id,
      asin,
      sku,
      product_name,
      group_type = 'exact',
      keywords = [],
      initial_bid = 0.30,
      daily_budget = 25,
    } = body;

    if (!amazon_account_id || !asin) {
      return Response.json({ error: 'amazon_account_id e asin obrigatórios' }, { status: 400 });
    }

    const validations = {
      passed: true,
      alerts: [],
      warnings: [],
      blocks: [],
      checks: {},
      suggestions: {},
    };

    // === 1. VALIDAR PRODUTO ===
    const product = await base44.asServiceRole.entities.Product.filter({ amazon_account_id, asin }).then(r => r[0]);
    
    validations.checks.product_exists = !!product;
    if (!product) {
      validations.blocks.push({
        field: 'asin',
        message: `ASIN ${asin} não encontrado na base local. Execute sync primeiro.`,
      });
      validations.passed = false;
    } else {
      // Verificar status do produto
      if (product.status === 'inactive' || product.status === 'archived') {
        validations.blocks.push({
          field: 'product_status',
          message: `Produto está ${product.status}. Ative o listing antes de anunciar.`,
        });
        validations.passed = false;
      }

      // Verificar estoque
      const inventory = product.fba_inventory || 0;
      validations.checks.has_inventory = inventory > 0;
      if (inventory === 0) {
        validations.warnings.push({
          field: 'inventory',
          message: 'Produto sem estoque FBA. Anúncio pode não rodar.',
          severity: 'high',
        });
      }

      // Verificar se tem nome
      validations.checks.has_product_name = !!(product.product_name || product.display_name);
      if (!validations.checks.has_product_name) {
        validations.warnings.push({
          field: 'product_name',
          message: 'Produto sem nome. Edite o nome antes de criar campanha.',
          severity: 'medium',
        });
      }
    }

    // === 2. VERIFICAR ASIN COM MÚLTIPLOS SKUS ===
    const productsSameAsin = await base44.asServiceRole.entities.Product.filter({ amazon_account_id, asin });
    validations.checks.asin_has_multiple_skus = productsSameAsin.length > 1;
    
    if (productsSameAsin.length > 1) {
      const skus = productsSameAsin.map(p => ({
        sku: p.sku,
        price: p.price,
        inventory: p.fba_inventory || 0,
        status: p.status,
      }));
      
      validations.alerts.push({
        field: 'asin_multiple_skus',
        message: 'ASIN associado a mais de um SKU. Selecione a oferta principal.',
        type: 'warning',
        data: { skus },
      });
      
      // Verificar se SKU informado é o principal
      const skuMatch = productsSameAsin.find(p => p.sku === sku);
      if (!skuMatch) {
        validations.warnings.push({
          field: 'sku_mismatch',
          message: `SKU ${sku} não encontrado para este ASIN. Verifique a oferta correta.`,
          severity: 'high',
        });
      }
    }

    // === 3. VERIFICAR DUPLICIDADE DE GRUPO ===
    const existingGroups = await base44.asServiceRole.entities.AdGroup.filter({
      amazon_account_id,
      campaign_id,
      primary_asin: asin,
      group_type,
    });

    const activeGroup = existingGroups.find(g => g.state === 'enabled' && !g.archived);
    validations.checks.no_duplicate_group = !activeGroup;
    
    if (activeGroup) {
      validations.blocks.push({
        field: 'duplicate_group',
        message: `Já existe grupo ativo para este ASIN com segmentação ${group_type}: ${activeGroup.ad_group_name}`,
        data: { existing_group_id: activeGroup.ad_group_id },
      });
      validations.passed = false;
    }

    // === 4. VALIDAR NOMENCLATURA ===
    const identifier = sku || asin;
    const expectedName = `AG-SP-${group_type.toUpperCase()}-${identifier}-${(product_name || asin).slice(0, 20).replace(/[^A-Z0-9]/gi, '-').toUpperCase()}`;
    validations.suggestions.expected_name = expectedName;
    validations.suggestions.naming_standard = 'AG-SP-{TYPE}-{SKU}-{PRODUCT}';

    // === 5. VALIDAR KEYWORDS ===
    validations.checks.has_keywords = keywords.length > 0;
    if (keywords.length === 0 && group_type !== 'product_targeting') {
      validations.blocks.push({
        field: 'keywords',
        message: 'Nenhuma palavra-chave válida. Adicione pelo menos uma keyword.',
      });
      validations.passed = false;
    }

    // Verificar duplicidade de keywords
    const normalized = keywords.map(k => k.toLowerCase().trim());
    const unique = new Set(normalized);
    validations.checks.no_duplicate_keywords = unique.size === keywords.length;
    
    if (unique.size < keywords.length) {
      validations.warnings.push({
        field: 'duplicate_keywords',
        message: `${keywords.length - unique.size} palavras-chave duplicadas serão removidas.`,
        severity: 'low',
      });
    }

    // Verificar keywords vazias
    const emptyKeywords = keywords.filter(k => !k.trim());
    if (emptyKeywords.length > 0) {
      validations.blocks.push({
        field: 'empty_keywords',
        message: `${emptyKeywords.length} palavras-chave vazias. Remova antes de criar.`,
      });
      validations.passed = false;
    }

    // === 6. VALIDAR LANCE ===
    validations.checks.has_valid_bid = initial_bid >= 0.20 && initial_bid <= 10;
    if (!validations.checks.has_valid_bid) {
      if (initial_bid < 0.20) {
        validations.blocks.push({
          field: 'bid_too_low',
          message: `Lance R$${initial_bid} abaixo do mínimo (R$0.20). Use R$0.20 ou mais.`,
        });
        validations.passed = false;
      } else {
        validations.warnings.push({
          field: 'bid_too_high',
          message: `Lance R$${initial_bid} acima de R$10. Confirmar?`,
          severity: 'medium',
        });
      }
    }

    // Calcular CPC máximo econômico
    if (product) {
      const price = product.price || 0;
      const estimatedCost = price * 0.4;
      const amazonFees = price * 0.15;
      const logistics = 10;
      const profitBeforeAds = price - estimatedCost - amazonFees - logistics;
      const estimatedConversion = 0.10; // 10%
      const maxEconomicCpc = profitBeforeAds * estimatedConversion;

      validations.suggestions.max_economic_cpc = parseFloat(maxEconomicCpc.toFixed(2));
      validations.suggestions.profit_before_ads = parseFloat(profitBeforeAds.toFixed(2));
      
      if (initial_bid > maxEconomicCpc) {
        validations.alerts.push({
          field: 'bid_above_economic_limit',
          message: `Lance R$${initialBid} acima do CPC econômico máximo (R$${maxEconomicCpc.toFixed(2)}).`,
          type: 'warning',
          data: {
            requested_bid: initial_bid,
            max_economic_cpc: parseFloat(maxEconomicCpc.toFixed(2)),
            profit_before_ads: parseFloat(profitBeforeAds.toFixed(2)),
          },
        });
      }
    }

    // === 7. VALIDAR ORÇAMENTO ===
    validations.checks.has_budget = daily_budget >= 10;
    if (!validations.checks.has_budget) {
      validations.warnings.push({
        field: 'low_budget',
        message: `Orçamento R$${daily_budget} pode ser insuficiente. Mínimo recomendado: R$25.`,
        severity: 'medium',
      });
    }

    // === 8. VERIFICAR ESTRATÉGIA DE LANCE ===
    const isNewCampaign = !campaign_id || campaign_id.includes('NEW');
    if (isNewCampaign) {
      validations.suggestions.recommended_bidding = 'dynamic_down_only';
      validations.suggestions.bidding_rationale = 'Campanha nova: usar somente redução para proteger margem';
      
      if (group_type === 'discovery' || group_type === 'broad') {
        validations.suggestions.recommended_bid = 0.25;
        validations.suggestions.bid_rationale = 'Grupo de descoberta: bid conservador';
      }
    }

    // === 9. VERIFICAR PLACEMENTS ===
    if (isNewCampaign) {
      validations.suggestions.recommended_placements = {
        placement_top_search: 0,
        placement_rest_search: 0,
        placement_product_pages: 0,
      };
      validations.suggestions.placement_rationale = 'Campanha nova: sem ajustes de placement até ter dados';
    }

    // === 10. VERIFICAR CAMPO OBRIGATÓRIO ===
    if (!sku) {
      validations.warnings.push({
        field: 'missing_sku',
        message: 'SKU não informado. Usando ASIN como identificador.',
        severity: 'low',
      });
    }

    // Resumo final
    validations.can_proceed = validations.passed && validations.blocks.length === 0;
    validations.requires_confirmation = validations.alerts.length > 0 || validations.warnings.some(w => w.severity === 'high');
    validations.summary = {
      total_checks: Object.keys(validations.checks).length,
      passed_checks: Object.values(validations.checks).filter(v => v).length,
      blocks: validations.blocks.length,
      alerts: validations.alerts.length,
      warnings: validations.warnings.length,
    };

    return Response.json({
      ok: true,
      validations,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});