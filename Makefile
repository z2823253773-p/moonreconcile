.PHONY: verify verify-unit

verify:
	python3 scripts/verify.py

verify-unit:
	python3 -m unittest tests.test_verify -v
