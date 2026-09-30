# Migration workflow (synthetic)

All rows are invented. `record_id` was renamed to `new_id`; right status `old` explicitly maps to `active`; decimal `1.00` equals `1`. `legacy_note` is intentionally unmapped and `export_stamp` explicitly ignored. Duplicate `D` keys on both sides and empty keys are diagnosed; no first-row-wins matching occurs.

```sh
node cli/main.mjs compare examples/migration/left.csv examples/migration/right.csv --config examples/migration/rules.json --out /tmp/migration-run
node cli/main.mjs resolve /tmp/migration-run --decisions examples/migration/reviewed.csv --out /tmp/migration-reviewed
node cli/main.mjs resolve /tmp/migration-run --decisions /tmp/migration-reviewed/decisions.csv --out /tmp/migration-replayed
```

Expected: compare pairs only A and leaves three records pending on each side. It reports exactly the declared unmapped and ignored columns, four duplicate-key rows, and two empty-key rows. Three explicit synthetic manual overrides produce four pairs per side, eight field results (equal 6, equivalent 2), zero unresolved records; original structural/key diagnostics remain visible and exit is 1.
