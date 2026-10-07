import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { kickoffDiscovery } from '../../shared/productDiscoveryPolicy.ts';

Deno.serve(async request => {
  const base44 = createClientFromRequest(request);
  try {
    const body = await request.json().catch(() => ({}));
    if (!body._service_role && !(await base44.auth.isAuthenticated().catch(() => false))) return Response.json({ ok:false, error:'Não autorizado' }, {status:401});
    const db = base44.asServiceRole;
    const accounts = body.amazon_account_id ? await db.entities.AmazonAccount.filter({id:body.amazon_account_id}) : await db.entities.AmazonAccount.filter({status:'connected'});
    const results = [];
    for (const account of accounts) {
      if (body.dry_run !== true) {
        const sync = await db.functions.invoke('syncProductCatalogV2', {amazon_account_id:account.id,_service_role:true});
        if (sync?.data?.ok !== true) {results.push({account_id:account.id,ok:false,error:'Varredura sem inventário atualizado; sugestões preservadas.'});continue;}
      }
      let [products,campaigns,queue] = await Promise.all([
        db.entities.Product.filter({amazon_account_id:account.id},'-created_date',5000),
        db.entities.Campaign.filter({amazon_account_id:account.id},'-updated_date',10000),
        db.entities.ProductKickoffQueue.filter({amazon_account_id:account.id},'-created_date',5000),
      ]);
      if (body.dry_run !== true) {
        const skus = products.filter(p=>['ready','blocked'].includes(kickoffDiscovery(p,campaigns,queue).status)).slice(0,50).map(p=>p.sku);
        if (skus.length) {
          await db.functions.invoke('syncAmazonOfferAvailability',{amazon_account_id:account.id,_service_role:true,skus,max_products:50});
          products=await db.entities.Product.filter({amazon_account_id:account.id},'-created_date',5000);
        }
      }
      const checkedAt = new Date().toISOString();
      const candidates = [];
      for (const product of products) {
        const result = kickoffDiscovery(product,campaigns,queue);
        if (body.dry_run !== true) await db.entities.Product.update(product.id,{
          kickoff_discovery_status:result.status,kickoff_discovery_reasons:result.reasons,
          kickoff_discovery_checked_at:checkedAt,
          ...(['ready','blocked','queued'].includes(result.status) && !product.kickoff_discovered_at ? {kickoff_discovered_at:checkedAt} : {}),
        });
        if (['ready','blocked','queued'].includes(result.status)) candidates.push({sku:product.sku,asin:product.asin,...result});
      }
      results.push({account_id:account.id,ok:true,checked_at:checkedAt,scanned:products.length,candidates});
    }
    return Response.json({ok:results.every(r=>r.ok),dry_run:body.dry_run===true,results});
  } catch (error) {return Response.json({ok:false,error:error.message},{status:500});}
});
