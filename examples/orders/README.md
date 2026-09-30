# Orders workflow (synthetic)

All rows are invented. Compare by the unique `order_id`/`external_ref`; the right status translation is explicit, amount tolerance is 0.02, and dates require exact days. No fuzzy candidates run.

```sh
node cli/main.mjs compare examples/orders/left.csv examples/orders/right.csv --config examples/orders/rules.json --out /tmp/orders-run
node cli/main.mjs resolve /tmp/orders-run --decisions examples/orders/reviewed.csv --out /tmp/orders-reviewed
node cli/main.mjs resolve /tmp/orders-run --decisions /tmp/orders-reviewed/decisions.csv --out /tmp/orders-replayed
```

Expected: two exact pairs; left `L3` remains pending after compare and becomes human-confirmed unmatched after resolve; right has two pairs. Six field results: equal 1, equivalent by rule 2, different 3, invalid 0. Amount differences are -0.01 and -1; B's date difference is -1 day. Complete runs exit 1 because the report retains substantive differences and the confirmed missing order.
