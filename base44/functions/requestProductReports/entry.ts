import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const auth = await base44.auth.isAuthenticated().catch(() => false);
    if (!auth && !body._service_role) return Response.json({ok:false,error:'Não autorizado'},{status:401});
    if (!body.amazon_account_id) return Response.json({ok:false,error:'amazon_account_id obrigatório'},{status:400});
    const rows = await base44.asServiceRole.entities.SyncExecutionLog.filter({amazon_account_id:body.amazon_account_id,operation:'product_reports_request_v2',status:'completed'},'-completed_at',1).catch(()=>[]);
    const last = rows[0];
    if (last?.completed_at && Date.now()-new Date(last.completed_at).getTime() < 3300000) {
      const saved = JSON.parse(last.result_summary || '{}');
      if (saved.requested?.length) return Response.json({ok:true,reused:true,requested:saved.requested,errors:saved.errors || [],requested_at:last.completed_at});
    }
    const result = await base44.functions.invoke('requestProductReportsV2', body);
    return Response.json(result?.data || result || {});
  } catch (error) {
    return Response.json({ok:false,error:error?.message || 'Erro ao solicitar relatórios'},{status:500});
  }
});