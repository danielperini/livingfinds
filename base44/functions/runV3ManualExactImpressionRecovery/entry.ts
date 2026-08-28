/**
 * runV3ManualExactImpressionRecovery
 *
 * CURRENT HOSTING VERSION
 *
 * Não depende de backend hospedado Base44.
 *
 * Esta função roda dentro do servidor Living Finds atual
 * e orquestra serviços já disponíveis via HTTP interno.
 */

const LOCAL_BASE =
  Deno.env.get('LIVINGFINDS_INTERNAL_BASE_URL')
  ||
  Deno.env.get('INTERNAL_API_BASE_URL')
  ||
  'http://127.0.0.1:8000';

const API_TOKEN =
  Deno.env.get('API_TOKEN')
  ||
  Deno.env.get('INTERNAL_API_TOKEN')
  ||
  '';

function jsonResponse(
  data: unknown,
  status = 200
) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        'content-type': 'application/json'
      }
    }
  );
}

async function invokeLocal(
  fn: string,
  body: Record<string, unknown>,
  timeoutMs = 300000
): Promise<any> {

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      timeoutMs
    );

  try {

    const headers:
      Record<string,string> = {
        'content-type':
          'application/json'
      };

    if(API_TOKEN) {
      headers.authorization =
        `Bearer ${API_TOKEN}`;
    }

    const response =
      await fetch(
        `${LOCAL_BASE}/functions/${fn}`,
        {
          method:'POST',
          headers,
          body:JSON.stringify(body),
          signal:controller.signal
        }
      );

    const text =
      await response.text();

    let data:any;

    try {
      data=JSON.parse(text);
    }
    catch {
      data={
        ok:false,
        raw:text
      };
    }

    return {
      http_status:
        response.status,

      ...data
    };

  }
  finally {
    clearTimeout(timeout);
  }
}

Deno.serve(async(req) => {

  const started =
    Date.now();

  try {

    const body =
      await req.json()
        .catch(() => ({}));

    /*
     * A lógica econômica continua no V3 canônico.
     *
     * Esta função NÃO cria cliente Base44.
     * Ela solicita ao V3 atual uma revisão específica
     * de campanhas MANUAL EXACT subexpostas.
     */

    const result =
      await invokeLocal(
        'runCanonicalDecisionCycle',
        {
          _service_role:true,

          trigger_type:
            'manual_exact_impression_recovery',

          daily_ai_review:true,

          autonomous_adjustments:true,

          sku_by_sku_review:true,

          bid_optimization:true,

          manual_exact_impression_recovery:true,

          impression_recovery_policy:{
            enabled:true,

            exact_only:true,

            progressive_steps:[
              {
                min_age_hours:24,
                max_age_hours:48,
                max_impressions:0,
                bid_increase_pct:10
              },
              {
                min_age_hours:48,
                max_age_hours:96,
                max_impressions:20,
                bid_increase_pct:10
              },
              {
                min_age_hours:96,
                max_age_hours:168,
                max_impressions:50,
                bid_increase_pct:15
              }
            ],

            young_campaigns:{
              enabled:true,
              allow_exploration:true
            },

            precedence:[
              'HARD_GUARD',
              'SPEND_VELOCITY',
              'ECONOMICS',
              'IMPRESSION_RECOVERY'
            ],

            block_if_no_sale_spend_velocity:true,

            require_safe_cpc:true,

            require_configured_ceiling:true,

            structural_review_after_days:7
          }
        },
        900000
      );

    return jsonResponse({
      ok:
        result?.ok !== false,

      hosting:
        'CURRENT_LIVINGFINDS_SERVER',

      delegated_to:
        'CANONICAL_PROFIT_ENGINE_V3',

      result,

      duration_ms:
        Date.now() - started
    });

  }
  catch(error) {

    return jsonResponse(
      {
        ok:false,

        hosting:
          'CURRENT_LIVINGFINDS_SERVER',

        error:
          error instanceof Error
            ? error.message
            : String(error),

        duration_ms:
          Date.now() - started
      },
      500
    );
  }
});
