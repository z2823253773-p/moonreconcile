#!/usr/bin/env python3
"""Recompute committed goldens with exhaustive partial matching, independent of MoonBit."""
import json
from pathlib import Path


def optimum(left_count, edges):
    by_left = [[] for _ in range(left_count)]
    for edge in edges:
        by_left[edge["left"]].append((edge["right"], edge["weight"]))

    def visit(left, used):
        if left == left_count:
            return 0
        best = visit(left + 1, used)  # Unmatched is allowed.
        for right, weight in by_left[left]:
            if right not in used:
                best = max(best, weight + visit(left + 1, used | {right}))
        return best

    return visit(0, set())


root = Path(__file__).resolve().parents[1]
cases = json.loads((root / "tests/fixtures/assignment-oracle.json").read_text())["cases"]
for index, case in enumerate(cases):
    actual = optimum(case["left_count"], case["edges"])
    assert actual == case["optimum"], (index, actual, case["optimum"])
print(f"{len(cases)} exhaustive assignment goldens independently verified")
