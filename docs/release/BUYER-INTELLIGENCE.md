# Lucia buyer intelligence integration

## Scope

This additive integration implements the owner-only buyer-intelligence API,
read-only enhancements for Dossier, Investors, and Pipeline, and a canonical
read identity for legal-suffix variants. Lucia remains the product shell.
buyerDB remains the ingestion and historical transaction warehouse.

## Data safety

- The canonical-identity migration replaces only the two existing read RPCs and
  adds a query-only normalizer plus a read-only schema check.
- No table row is inserted, updated, merged, or deleted. Existing entity UUIDs,
  contacts, provenance, party links, and source records remain untouched.
- Canonical matching removes only terminal legal suffixes. It deliberately
  preserves a meaningful leading `LP`, so `LP 208 FLATBUSH LLC` is not merged
  with `208 FLATBUSH LLC`.
- The server calls the existing `api_buyers` and `api_entity` RPCs with the
  already-configured Supabase admin credential.
- Aggregate responses contain transaction facts and a boolean contact-available
  flag. Buyer-history responses contain only buyer-role transaction evidence:
  recorded property address, date, borough, asset type, price, and source URL.
  Every row returned by `api_entity` is preserved; indistinguishable records are
  not collapsed without a source deal identifier. Missing source facts remain
  null and are never inferred.
- Phone numbers, email addresses, entity mailing addresses, contact records, and
  provenance JSON are not returned.
- Both existing owner authorities are preserved: the production Owner password
  gate and an authenticated Supabase `owner`/`admin` profile.

## UI contract

The immutable production bundle is not edited. `/js/buyer-intelligence.js` is a
separate shell enhancement, following the existing compatibility-script
pattern. Its script and stylesheet URLs carry content-derived versions so a
refresh cannot retain an older buyer query or presentation. It adds:

1. Dossier: exact-borough and, when unambiguous, exact-asset historical buyers;
   every shown buyer expands to the supporting property-address history.
2. Investors: all Manhattan repeat buyers (two or more recorded purchases),
   deterministically ranked by deal count, recorded volume, recency, and name;
   every buyer expands to its full matching address-linked history.
3. Pipeline: the top exact-segment historical buyer plus that buyer's latest
   matching recorded purchase address on mapped parcel cards.

## Verified live Manhattan contract (2026-08-19)

- 1,078 stored buyer entities and 1,153 buyer-role transaction records were
  checked.
- `api_entity` returned all 1,153 expected Manhattan buyer transactions.
- All 1,153 returned transactions had a recorded property address.
- There are 61 canonical repeat Manhattan buyers: 1 with five purchases, 3 with
  four, 6 with three, and 51 with two. The corrected additional group is
  `139 Bowery Holdings` / `139 BOWERY HOLDINGS LLC`, whose two source deals total
  $72 million. The Investors request uses `minDeals=2` and a limit of 200 (the
  deployed RPC maximum), so the complete current repeat-buyer population is
  returned with room for growth.
- Some source rows legitimately lack other facts (48 dates, 44 prices, 1 asset
  type, and 20 source URLs). The UI labels those fields as unavailable instead
  of guessing.

`buyer_intelligence_schema_check()` is part of the production deployment gate.
It fails closed if any Manhattan buyer deal loses its property address, if the
canonical repeat count falls below the raw entity count, or if either buyer RPC
becomes callable outside the server-side `service_role` path.

Manual investor buy boxes, Airtable CRM matches, and buyerDB history remain
separate and source-labelled.
