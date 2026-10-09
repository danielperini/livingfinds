# Active product coverage — 2026-10-09

The user authorized active advertising and more impressions for every product with available FBA stock, keeping the account daily cap at R$100. An earlier containment run was cancelled before any confirmed pause. Live API readback confirmed AUTO campaigns, product ads, ad groups and four automatic targets for 12 eligible stocked products. Discovery bids were raised within the configured account bid ceiling; the microphone and black coffee grinder campaigns were re-enabled.

Two eligibility defects were found and corrected:

- Listings merchant-fulfilled quantity could overwrite FBA stock and catalog status. Offer synchronization now writes offer information only; available FBA quantity remains owned by inventory synchronization. Ads authorization uses the same FBA-only stock policy.
- Every ERROR issue was incorrectly treated as a non-buyable listing. FBA-0024b actually returned BUYABLE/DISCOVERABLE, with issue 100581 and ATTRIBUTE_SUPPRESSED for a swatch image. Buyability now follows BUYABLE status and actual listing/search suppression actions. Attribute issues remain visible as issue codes without blocking the product.

Amazon describes BUYABLE as purchasable in its [Listings API documentation](https://developer-docs.amazon/sp-api/lang-en_us/reference/searchlistingsitems). Tests cover merchant/FBA divergence, unknown stock, attribute errors, actual suppression, and DISCOVERABLE without BUYABLE.

Enabled status and higher bids do not establish an increase in impressions or sales. Those outcomes require subsequent Amazon reports. Live actions were confirmed by re-reading the affected resources.
