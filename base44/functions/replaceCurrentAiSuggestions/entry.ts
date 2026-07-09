/**
 * replaceCurrentAiSuggestions
 *
 * Arquiva todas as sugestões com origem em IA (Claude, OpenAI, etc).
 * Não deleta fisicamente — altera status para archived_by_policy.
 * Bloqueia reativação automática.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const AI_SOURCES = [
  'CLAUDE_PRODUCT_ANALYSIS',
  'OPENAI_TITLE_ANALYSIS',
  'AI_GENERATED',
  'GPT_TITLE_ANALYSIS',
  'PRODUCT_ANALYSIS',
];

Deno.serve(async (req) => {
  const now = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' });

    const aid = account.id;
    let totalArchived = 0;

    for (const src of AI_SOURCES) {
      let skip = 0;
      while (true) {
        const batch = await base44.asServiceRole.entities.KeywordSuggestion.filter(
          { amazon_account_id: aid, source: src },
          null, 100
        ).catch(() => []);

        const toArchive = batch.filter((s: any) =>
          s.status !== 'archived_by_policy' && !s.reactivation_blocked
        );

        if (!toArchive.length) break;

        for (let i = 0; i < toArchive.length; i += 50) {
          const chunk = toArchive.slice(i, i + 50);
          await base44.asServiceRole.entities.KeywordSuggestion.bulkUpdate(
            chunk.map((s: any) => ({
              id: s.id,
              status: 'archived_by_policy',
              archive_reason: 'Substituída por sugestão oficial Amazon Ads',
              reactivation_blocked: true,
            }))
          ).catch(() => {});
          totalArchived += chunk.length;
        }

        if (batch.length < 100) break;
        skip += 100;
        await new Promise(r => setTimeout(r, 200));
      }
    }

    return Response.json({
      ok: true,
      archived: totalArchived,
      sources_processed: AI_SOURCES,
      message: `${totalArchived} sugestões de IA arquivadas por política. Mantidas para auditoria.`,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});