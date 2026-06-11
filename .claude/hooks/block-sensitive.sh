#!/bin/bash

# .claude/hooks/block-sensitive.sh
# 
# Purpose: Blocks commits/merges that introduce sensitive payment logic
# unless the Commercial Launch Gate is explicitly enabled in the environment.
#
# This enforces ADR-040 §5: "charging cannot begin until counsel drafts it"
# and §6: "LLC + accountant before taking money."

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Check if we are in a CI environment or if the user has explicitly enabled the gate
# In local dev, this check is advisory unless COMMERCIAL_LAUNCH_ENABLED is set.
# In CI/CD, this blocks the pipeline if payment code is detected but gate is closed.

# Detect if the commit contains payment-related keywords
# (MoR checkout, issuance webhook, billing, license issuance)
if git diff --cached --name-only | xargs grep -l -E "(checkout|issuance|webhook|billing|license.*issue|payment)" 2>/dev/null; then
    echo -e "${RED}⚠️  Sensitive payment/issuance code detected in staged changes.${NC}"
    
    # Check the environment gate
    if [ "${COMMERCIAL_LAUNCH_ENABLED}" != "true" ]; then
        echo -e "${RED}🚫 BLOCKED: Commercial launch is NOT enabled.${NC}"
        echo ""
        echo "According to ADR-040 §5 and §6, you cannot merge payment logic until:"
        echo "  1. Counsel has drafted the BUSL re-scope (Legal Draft Status: Approved)"
        echo "  2. LLC and Accountant are engaged"
        echo "  3. Merchant-of-Record (MoR) is configured"
        echo ""
        echo "To bypass this (ONLY if legal requirements are met), set:"
        echo "  export COMMERCIAL_LAUNCH_ENABLED=true"
        echo "  export LEGAL_DRAFT_STATUS=approved"
        echo "  export ACCOUNTANT_ENGAGED=true"
        echo "  export MOR_PROVIDER=stripe"
        echo ""
        echo "Aborting commit."
        exit 1
    else
        echo -e "${GREEN}✅ Commercial launch gate is OPEN. Proceeding.${NC}"
    fi
fi

# If no sensitive code, or gate is open, allow the hook to pass
exit 0