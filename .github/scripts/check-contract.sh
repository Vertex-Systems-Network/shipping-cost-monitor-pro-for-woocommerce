#!/usr/bin/env bash
# Checks that every Free hook, constant, script handle and JS global the Pro add-on relies on
# still exists in the Free plugin, and that Pro still provides what Free reads.
# Usage: check-contract.sh FREE_DIR PRO_DIR. Kept identical in both repositories.
set -euo pipefail
free="$1"; pro="$2"; fail=0
ok()  { echo "ok $*"; }
bad() { echo "::error::$*"; fail=1; }
# Join each PHP tree into one line so calls split across lines still match.
free_php=$(find "$free/shipping-cost-monitor-for-woocommerce.php" "$free/includes" -name '*.php' -print0 | xargs -0 cat | tr '\n' ' ')
pro_php=$(find "$pro/shipping-cost-monitor-pro-for-woocommerce.php" "$pro/includes" -name '*.php' -print0 | xargs -0 cat | tr '\n' ' ')

hooks=$(grep -oE "add_(action|filter)\(\s*'wpe_scm_[a-z_]+'" <<<"$pro_php" | grep -oE "wpe_scm_[a-z_]+" | sort -u)
[ -n "$hooks" ] || bad "No wpe_scm_ hooks found in Pro; the contract check cannot be right"
for hook in $hooks; do
  if grep -qE "(do_action|apply_filters)\(\s*'$hook'" <<<"$free_php"; then ok "hook $hook"; else bad "Pro hooks into '$hook', but Free never fires it"; fi
done
for const in $(grep -oE "\bWPE_SCM_[A-Z_]+\b" <<<"$pro_php" | grep -v '^WPE_SCM_PRO_' | sort -u); do
  if grep -qE "define\(\s*'$const'" <<<"$free_php"; then ok "constant $const"; else bad "Pro uses constant $const, but Free does not define it"; fi
done
if grep -q "'wpe-scm-admin'" <<<"$pro_php"; then
  if grep -q "'wpe-scm-admin'" <<<"$free_php"; then ok "script handle wpe-scm-admin"; else bad "Pro depends on script handle wpe-scm-admin, which Free no longer registers"; fi
fi
if grep -rq "wpeScmDashboard" "$pro/assets"; then
  if grep -q "'wpeScmDashboard'" <<<"$free_php"; then ok "JS global wpeScmDashboard"; else bad "Pro reads window.wpeScmDashboard, which Free no longer localizes"; fi
fi
if grep -rq "wpeScmPro" "$free/assets/js"; then
  if grep -rq "wpeScmPro" "$pro/assets"; then ok "JS global wpeScmPro"; else bad "Free reads window.wpeScmPro, which Pro no longer sets"; fi
fi
if grep -q "^ \* Requires Plugins:.*shipping-cost-monitor-for-woocommerce" "$pro/shipping-cost-monitor-pro-for-woocommerce.php"; then ok "Pro requires Free"; else bad "Pro header must list shipping-cost-monitor-for-woocommerce in Requires Plugins"; fi
exit $fail
