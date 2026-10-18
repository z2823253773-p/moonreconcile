.PHONY: verify verify-unit

verify:
	python3 -I scripts/verify.py

verify-unit:
	python3 -I scripts/verify.py --unit-only
