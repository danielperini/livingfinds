import { assertEquals } from 'jsr:@std/assert';
import {
  classifyCampaignLifecycle
} from './campaignLifecyclePolicy.ts';

const base={
  kind:'UNKNOWN' as const,

  ageHours:10,

  impressions7d:0,
  clicks7d:0,
  spend7d:0,
  orders7d:0,
  sales7d:0,

  impressions30d:0,
  clicks30d:0,
  spend30d:0,
  orders30d:0,
  sales30d:0,

  harvestableTerms:0,
  derivedExactCampaigns:0,

  priorZeroDeliveryEscalations:0,
  priorWasteBidReductions:0,

  targetAcos:25,
  maxAcos:40,

  inStock:true,
  buyable:true,
  listingActive:true,
  offerActive:true,

  protectedWinner:false,
  accountHardStop:false,
};

Deno.test(
 'nova campanha espera',
 ()=>{
   const r=
     classifyCampaignLifecycle({
       ...base,
       ageHours:12
     });

   assertEquals(
     r.phase,
     'NEW'
   );
 }
);

Deno.test(
 '72h zero delivery recupera',
 ()=>{
   const r=
     classifyCampaignLifecycle({
       ...base,
       ageHours:80
     });

   assertEquals(
     r.phase,
     'ZERO_DELIVERY_RECOVERY'
   );
 }
);

Deno.test(
 '3 escaladas vira replace',
 ()=>{
   const r=
     classifyCampaignLifecycle({
       ...base,
       ageHours:300,
       priorZeroDeliveryEscalations:3
     });

   assertEquals(
     r.phase,
     'REPLACE_REBUILD'
   );
 }
);

Deno.test(
 'AUTO começa em discovery',
 ()=>{
   const r=
     classifyCampaignLifecycle({
       ...base,

       kind:'AUTO',

       ageHours:100,

       clicks7d:4,
       spend7d:3,

       clicks30d:4,
       spend30d:3
     });

   assertEquals(
     r.phase,
     'AUTO_DISCOVERY'
   );
 }
);

Deno.test(
 'AUTO com comprador vai para harvest',
 ()=>{
   const r=
     classifyCampaignLifecycle({
       ...base,

       kind:'AUTO',

       ageHours:150,

       clicks7d:10,
       spend7d:8,
       orders7d:1,
       sales7d:60,

       clicks30d:10,
       spend30d:8,
       orders30d:1,
       sales30d:60,

       harvestableTerms:1
     });

   assertEquals(
     r.phase,
     'AUTO_HARVEST_READY'
   );

   assertEquals(
     r.behavior,
     'HARVEST_TO_MANUAL_EXACT'
   );
 }
);

Deno.test(
 'manual exact recém harvestada aprende',
 ()=>{
   const r=
     classifyCampaignLifecycle({
       ...base,

       kind:'MANUAL_EXACT',

       ageHours:24,

       clicks7d:2,
       spend7d:1,

       clicks30d:2,
       spend30d:1
     });

   assertEquals(
     r.phase,
     'MANUAL_EXACT_NEW'
   );
 }
);

Deno.test(
 'manual exact winner cresce',
 ()=>{
   const r=
     classifyCampaignLifecycle({
       ...base,

       kind:'MANUAL_EXACT',

       ageHours:300,

       clicks7d:20,
       spend7d:10,
       orders7d:3,
       sales7d:100,

       clicks30d:40,
       spend30d:20,
       orders30d:5,
       sales30d:200
     });

   assertEquals(
     r.phase,
     'WINNER'
   );
 }
);

Deno.test(
 'waste reduz antes de pausar',
 ()=>{
   const r=
     classifyCampaignLifecycle({
       ...base,

       kind:'MANUAL_EXACT',

       ageHours:300,

       clicks7d:12,
       spend7d:8,

       clicks30d:18,
       spend30d:12
     });

   assertEquals(
     r.phase,
     'WASTE_CONTROL'
   );

   assertEquals(
     r.behavior,
     'REDUCE_BID'
   );
 }
);

Deno.test(
 'waste persistente após duas reduções pausa',
 ()=>{
   const r=
     classifyCampaignLifecycle({
       ...base,

       ageHours:500,

       clicks7d:20,
       spend7d:15,

       clicks30d:30,
       spend30d:25,

       priorWasteBidReductions:2
     });

   assertEquals(
     r.phase,
     'PAUSE_CANDIDATE'
   );
 }
);
