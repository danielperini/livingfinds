# Amazon keyword identity audit

## Cause and field contract

Several bid producers wrote human text only to legacy `keyword`; the conservative optimizer created OptimizationDecision without its available keyword text. Consumers expected only `keyword_text`, then displayed `keyword_id` or generic `entity_name` as a phrase. CSV used a different resolver from the feed. Migration and execution logs could promote `entity_name` into keyword text without checking identity.

`keyword_id`, `keywordId`, `amazon_keyword_id` and keyword `entity_id` are technical identifiers. API keyword mutations and identity joins keep using them. They never supply human text or customer queries.

Human keyword text resolves in order from `keyword_text`, `keywordText`, `keyword`, `term`, `normalized_term`. Only strings participate. Values equal to known technical identifiers or explicitly formatted technical ID labels are excluded; numeric strings otherwise remain valid. Generic `entity_name` is not a textual alias. The documented legacy migration explicitly validates that field at its keyword-only boundary.

Customer query resolves separately from `search_term_original`, `search_term`, `searchTerm`, `search_term_normalized`, `normalized_search_term`. In the ingestion resolver, targeted keyword text never substitutes a missing customer query.

Missing text displays `Keyword ID: <id>`, with the full technical ID, or `Texto indisponível` when there is no identity either.

## Classification of relevant flows

| Locations | Classification | Audit result |
| --- | --- | --- |
| syncAdGroupsAndKeywords, syncBidChangesFromApi | Technical identifiers + human text from Amazon | `keywordId` and `keywordText` are separate API fields; no ID-to-query fallback. Repository normalizes legacy log aliases. |
| downloadAndProcessAmazonAdsReportJob, processReportsBatch, scheduledAdsReportSync, scheduledAdsReportPoll | Technical report dimensions + human query | Report keyword IDs remain dimensions; searchTerm remains its own source. Main report processor now validates keyword and query provenance independently. |
| searchTermHarvestPolicy, searchTermHarvestEvidence, verifiedBidEvidence, promotionConfirmation | Human query + identifier joins | Customer queries supply harvest text; identifiers only match campaign/ad group/keyword evidence. No keyword-ID-to-searchTerm fallback found. |
| calibrateBidsNoImpressions, executeStockBidRules, boostBidsNoSpend24h | Compatibility fallback / missing canonical persistence | Existing `keyword` logs now also receive validated `keyword_text`, while keeping `keyword_id`. Alerts explicitly label missing text as ID. |
| smartBidFromCpc | Compatibility legacy log producer | Existing implementation preserved. Repository canonicalizes `keyword` and fills available text from a unique same-account Keyword when a log carries only its ID. |
| runScheduledBidAdjustments | Technical queue identity + compatibility text | Logs and restore actions retain text independently of remote identity, including payload aliases. Bid mutation still uses keywordId only. |
| runConservativeBidOptimizer | Missing mapping in OptimizationDecision | Decisions now persist available `_meta.keyword_text` alongside keyword_id; metadata uses the shared textual resolver. |
| migrateDecisions, executeAutopilotDecisionV2, approveDecision | Possible erroneous generic-name mapping | Legacy migration validates keyword-only names. Execution/negative payloads use textual aliases; missing text never becomes an ID phrase. Approval refuses a negative mutation with no keyword text. |
| evaluateBidChangeOutcomesV2, reconcilePendingBidDecisions, runProfitAfterAdsPauseGuard | Generic fallback / human history labels | Removed entity-name-to-keyword persistence and raw-ID rationale fallback. |
| server EntityRepo mapRow/splitSystem/create/update/bulk + atomic decision path | Persistence boundary | Read normalization does not rewrite database history. Creates, updates, bulk and atomic inserts normalize text separately from IDs. Partial text updates use existing identity to detect contamination. Unique same-account Keyword lookup fills known text for ID-only logs/decisions. |
| OptimizationDecision, AdsBidChangeLog schemas | Identifier / human text declarations | Both properties document their separate meanings; no numeric-only keyword ban. |
| MotorDecisionFeed, motorHistoryCsv, motorDecisionTitle | Human labels + CSV + technical ID fallback | Same textual resolution for feed and CSV. CSV ID and text remain separate columns; unavailable text leaves the text cell empty. |
| KeywordBidChangesPanel, ConservativeBidDiagnosticPanel, AutopilotDecisionsTable, Recommendations, AdsAutopilot, SalaDeComando, AdsManagement | UI compatibility fallback | Relevant titles use validated text and explicit ID labels; log-to-decision mappings do not promote IDs to text. |
| motorLabels | Action/reason/confirmation labels | Does not resolve keyword identity or text; preserved unchanged. |
| Other decision engines, queues, bid mutation helpers | Technical identifiers / canonical text pass-through | IDs select API targets and join evidence; text fields are copied from Keyword/search evidence. Repository normalization protects persistence and historical reads. |
| reconcileEconomicEvidenceDecisions key | Compatibility identity key | `keyword_text || entity_id` is used only to compare records, not persisted/exported as a phrase or customer query. |

The repository-wide symbol inventory covered 378 source/schema/test/script files and searched keyword_id, keywordId, keyword_text, keywordText, keyword, term, normalized_term, search_term and searchTerm. Runtime source, schemas, tests and scripts were considered; archived backups, generated bundles, dependency files and historical report snapshots are not executable mapping sources.

## Validation and production limits

Regression tests cover canonical and legacy aliases, legitimate numeric queries, contaminated and incomplete history, the production CSV builder, repository create/bulk/update/read and the available atomic decision path. Repository tests use a SQL transport stub and cannot contact production.

Build runs into a fresh /tmp output directory. Relevant lint is checked against the saved pre-change source to distinguish existing errors. Strict Deno diagnostics for the five legacy functions are identical before/after (73 errors, no new signatures); the repository and modern affected functions pass strict checking.

No production data migration or deletion is needed: historical normalization is read-only. Existing global whitespace and lint/type errors are outside this correction and are preserved. Full frontend typechecking has 444 baseline errors and 443 after the correction, with no new error signatures. Lint in eight affected UI files has eight baseline errors and eight afterward. Global diff checking still reports 1,305 pre-existing whitespace diagnostics; the isolated correction passes git diff --check.

The existing scripts/deploy-keyword-integrity.sh is a dated, one-off rollout with hard-coded image tags/release SHA and a fixed rollback. It also changes nginx and maintenance state. It is not a safe deployment of this isolated patch and must not be reused unchanged. README describes publishing the whole Base44 app; server/README.md documents a Docker rebuild from the entire workspace without an isolated-release rollback procedure. Publishing the dirty workspace would include unrelated work; this audit does not authorize that wider release.
