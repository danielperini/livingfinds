import {
  createClientFromRequest,
} from 'npm:@base44/sdk@0.8.40';

function n(v:any):number|null {
  const x=Number(v);
  return Number.isFinite(x)
    ? x
    : null;
}

Deno.serve(async req => {

  try {

    const base44=
      createClientFromRequest(req);

    const body=
      await req.json().catch(() => ({}));

    const accounts=
      body.amazon_account_id
        ? await base44.asServiceRole
            .entities.AmazonAccount
            .filter(
              {id:body.amazon_account_id},
              undefined,
              1
            )
        : await base44.asServiceRole
            .entities.AmazonAccount
            .filter(
              {status:'connected'},
              '-updated_at',
              10
            );

    const reports:any[]=[];

    for(const account of accounts) {

      const aid=String(account.id);

      const products=
        await base44.asServiceRole
          .entities.Product
          .filter(
            {amazon_account_id:aid},
            undefined,
            3000
          )
          .catch(() => []);

      let inventory:any[]=[];

      try {
        inventory=
          await base44.asServiceRole
            .entities.InventorySnapshot
            .filter(
              {amazon_account_id:aid},
              '-updated_at',
              5000
            );
      } catch {}

      let profitability:any[]=[];

      try {
        profitability=
          await base44.asServiceRole
            .entities.ProductProfitability
            .filter(
              {amazon_account_id:aid},
              '-updated_at',
              5000
            );
      } catch {}

      const samples=
        products
          .slice(0,50)
          .map((p:any) => ({
            asin:p.asin,
            sku:p.sku,

            stock_fields:{
              stock_available:p.stock_available,
              inventory_available:p.inventory_available,
              quantity:p.quantity,
              stock:p.stock,
              available:p.available,
              available_quantity:p.available_quantity,
              fulfillable_quantity:p.fulfillable_quantity,
              inventory:p.inventory,
              inventory_quantity:p.inventory_quantity,
            },

            eligibility_fields:{
              authorized:p.authorized,
              ads_authorized:p.ads_authorized,
              is_authorized:p.is_authorized,
              ads_enabled:p.ads_enabled,
              listing_active:p.listing_active,
              buyable:p.buyable,
              status:p.status,
              active:p.active,
            },
          }));

      const inventorySamples=
        inventory
          .slice(0,50)
          .map((x:any) => ({
            asin:x.asin,
            sku:x.sku,
            available:x.available,
            quantity:x.quantity,
            fulfillable_quantity:x.fulfillable_quantity,
            inventory_available:x.inventory_available,
            stock_available:x.stock_available,
            raw_keys:Object.keys(x).sort(),
          }));

      const profitabilitySamples=
        profitability
          .slice(0,50)
          .map((x:any) => ({
            asin:x.asin,
            sku:x.sku,
            stock_coverage_days:x.stock_coverage_days,
            in_stock:x.in_stock,
            available:x.available,
            raw_keys:Object.keys(x).sort(),
          }));

      return Response.json({
        ok:true,

        amazon_account_id:aid,

        products_count:
          products.length,

        inventory_count:
          inventory.length,

        profitability_count:
          profitability.length,

        product_samples:
          samples,

        inventory_samples:
          inventorySamples,

        profitability_samples:
          profitabilitySamples,
      });
    }

    return Response.json({
      ok:true,
      reports,
    });

  } catch(error:any) {

    return Response.json(
      {
        ok:false,
        error:
          error?.message ||
          String(error),
      },
      {
        status:500
      }
    );
  }
});
