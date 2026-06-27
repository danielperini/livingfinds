import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id } = body;
    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    // Fetch recent campaign metrics to generate decisions
    const campaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id });
    const decisions = [];

    for (const campaign of campaigns) {
      // High ACOS: recommend bid reduction
      if (campaign.acos > 40 && campaign.clicks > 10) {
        const existing = await base44.asServiceRole.entities.Decision.filter({
          amazon_account_id,
          entity_id: campaign.campaign_id,
          status: 'pending',
          decision_type: 'bid_adjust',
        });
        if (existing.length === 0) {
          const decision = await base44.asServiceRole.entities.Decision.create({
            amazon_account_id,
            decision_type: 'budget_change',
            entity_type: 'campaign',
            entity_id: campaign.campaign_id,
            entity_name: campaign.name,
            rationale: `ACOS is ${campaign.acos.toFixed(1)}% (above 40% threshold). Recommend reducing daily budget by 15% to improve efficiency.`,
            current_value: campaign.daily_budget,
            proposed_value: Number((campaign.daily_budget * 0.85).toFixed(2)),
            change_pct: -15,
            confidence: 0.78,
            priority: campaign.acos > 60 ? 'high' : 'medium',
            status: 'pending',
          });
          decisions.push(decision);
        }
      }

      // Low spend, good ROAS: recommend budget increase
      if (campaign.roas > 4 && campaign.spend < campaign.daily_budget * 0.7 && campaign.clicks > 5) {
        const existing = await base44.asServiceRole.entities.Decision.filter({
          amazon_account_id,
          entity_id: campaign.campaign_id,
          status: 'pending',
          decision_type: 'budget_change',
        });
        if (existing.length === 0) {
          const decision = await base44.asServiceRole.entities.Decision.create({
            amazon_account_id,
            decision_type: 'budget_change',
            entity_type: 'campaign',
            entity_id: campaign.campaign_id,
            entity_name: campaign.name,
            rationale: `ROAS is ${campaign.roas.toFixed(2)}x with only ${Math.round((campaign.spend / campaign.daily_budget) * 100)}% budget utilization. Recommend increasing budget by 20% to capture more profitable traffic.`,
            current_value: campaign.daily_budget,
            proposed_value: Number((campaign.daily_budget * 1.20).toFixed(2)),
            change_pct: 20,
            confidence: 0.82,
            priority: 'medium',
            status: 'pending',
          });
          decisions.push(decision);
        }
      }

      // Zero clicks in 7+ days: recommend pause
      if (campaign.clicks === 0 && campaign.spend > 0 && campaign.state === 'enabled') {
        const existing = await base44.asServiceRole.entities.Decision.filter({
          amazon_account_id,
          entity_id: campaign.campaign_id,
          status: 'pending',
          decision_type: 'pause_campaign',
        });
        if (existing.length === 0) {
          const decision = await base44.asServiceRole.entities.Decision.create({
            amazon_account_id,
            decision_type: 'pause_campaign',
            entity_type: 'campaign',
            entity_id: campaign.campaign_id,
            entity_name: campaign.name,
            rationale: `Campaign has ${campaign.spend} spend but 0 clicks. Recommend pausing to prevent wasted budget.`,
            current_value: null,
            proposed_value: null,
            change_pct: null,
            confidence: 0.91,
            priority: 'high',
            status: 'pending',
          });
          decisions.push(decision);
        }
      }
    }

    // Also analyze keywords
    const keywords = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id });
    for (const kw of keywords) {
      if (kw.acos > 60 && kw.clicks > 5) {
        const existing = await base44.asServiceRole.entities.Decision.filter({
          amazon_account_id,
          entity_id: kw.keyword_id,
          status: 'pending',
          decision_type: 'bid_adjust',
        });
        if (existing.length === 0) {
          const newBid = Number((kw.bid * 0.80).toFixed(2));
          if (newBid > 0.02) {
            await base44.asServiceRole.entities.Decision.create({
              amazon_account_id,
              decision_type: 'bid_adjust',
              entity_type: 'keyword',
              entity_id: kw.keyword_id,
              entity_name: `${kw.keyword_text} (${kw.match_type})`,
              rationale: `Keyword ACOS is ${kw.acos.toFixed(1)}% with ${kw.clicks} clicks. Reducing bid by 20% to improve efficiency.`,
              current_value: kw.bid,
              proposed_value: newBid,
              change_pct: -20,
              confidence: 0.75,
              priority: kw.acos > 80 ? 'high' : 'medium',
              status: 'pending',
            });
          }
        }
      }
    }

    // Record learning event
    await base44.asServiceRole.entities.LearningEvent.create({
      amazon_account_id,
      event_type: 'learner_cycle',
      entity_type: 'account',
      entity_id: amazon_account_id,
      observation: `Learner cycle completed. Analyzed ${campaigns.length} campaigns, ${keywords.length} keywords. Generated ${decisions.length} new decisions.`,
      recorded_at: new Date().toISOString(),
    });

    return Response.json({ ok: true, decisions_generated: decisions.length, campaigns_analyzed: campaigns.length, keywords_analyzed: keywords.length });
  } catch (error) {
    return Response.json({ ok: false, message: error.message || 'Learner cycle failed' }, { status: 500 });
  }
});