# Supplier catalog workflow (synthetic)

All rows and truth are invented. Supplier IDs differ and are excluded from scoring. Brand blocks candidates; name edit score threshold is 8000. The separate [`truth.json`](truth.json) manifest declares L1↔R1 as true and R2 unmatched. It is intentionally independent of engine output and the decisions CSV.

```sh
node cli/main.mjs compare examples/catalog/left.csv examples/catalog/right.csv --config examples/catalog/rules.json --out /tmp/catalog-run
node cli/main.mjs resolve /tmp/catalog-run --decisions examples/catalog/reviewed.csv --out /tmp/catalog-reviewed
node cli/main.mjs resolve /tmp/catalog-run --decisions /tmp/catalog-reviewed/decisions.csv --out /tmp/catalog-replayed
```

Expected: two candidates, L1/R1 score 8000 and L1/R2 score 10000. The unique recommendation is the false, exact-name decoy. Initial counts are left pending 1, right pending 2, pairs 0, fields 0. Human review rejects the recommendation, accepts its qualifying competitor, and confirms R2 unmatched. Final counts: one pair, right unmatched 1, one different name field, unresolved 0, exit 1. This engineered example demonstrates that a score and a unique assignment are not identity proof; it estimates no real-world accuracy.
