#!/usr/bin/env bash
# scripts/hooks/reuse_surface_reminder.sh

# This hook checks if a new component is being created.
# If so, it reminds the agent/developer to do a capability search first.

# Check git staging for new files in src/components/
NEW_FILES=$(git diff --cached --name-status | awk '$1 == "A" && $2 ~ /^src\/components\// {print $2}')

if [ -n "$NEW_FILES" ]; then
  echo "⚠️  REUSE REMINDER: You are adding new components:"
  echo "$NEW_FILES"
  echo ""
  echo "Before proceeding, please confirm you have performed a capability search."
  echo "Could an existing primitive or shared component have been extended instead?"
  echo "If this is a truly new surface, you may proceed."
fi
