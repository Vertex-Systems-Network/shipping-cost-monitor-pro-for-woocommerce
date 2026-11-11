#!/usr/bin/env bash
# Checks that every Free hook, constant, script handle and JS global the Pro add-on relies on
# still exists in the Free plugin. Usage: check-contract.sh FREE_DIR PRO_DIR
# Kept identical in both repositories.
set -euo pipefail
free="$1"; pro="$2"; fail=0
free_php=$(find "$free/shipping-cost-monitor-for-woocommerce.php" "$free/includes" -name '*.php')
pro_php=$(find "$pro/shipping-cost-monitor-pro-for-woocommerce.php" "$pro/includes" -name '*.php')

for hook in $(grep -hoE "add_(action|filter)\( *'wpe_scm_[a-z_]+'" $pro_php | grep -oE "wpe_scm_[a-z_]+" | sort -u); do
  if ! grep -qE "(do_action|apply_filters)\( *'$hook'" $free_php; then
    echo "::error::Pro hooks into '$hook', but Free never fires it"; fail=1
  else echo "ok hook $hook"; fi
done
for const in $(grep -hoE "\bWPE_SCM_[A-Z_]+\b" $pro_php | grep -v '^WPE_SCM_PRO_' | sort -u); do
  if ! grep -qE "define\( *'$const'" $free_php; then
    echo "::error::Pro uses constant $const, but Free does not define it"; fail=1
  else echo "ok constant $const"; fi
done
if grep -q "'wpe-scm-admin'" $pro_php; then
  grep -q "'wpe-scm-admin'" $free_php || { echo "::error::Pro depends on script handle wpe-scm-admin, which Free no longer registers"; fail=1; }
  echo "ok script handle wpe-scm-admin"
fi
if grep -q "wpeScmDashboard" -r "$pro/assets"; then
  grep -q "'wpeScmDashboard'" $free_php || { echo "::error::Pro reads window.wpeScmDashboard, which Free no longer localizes"; fail=1; }
  echo "ok JS global wpeScmDashboard"
fi
if grep -q "wpeScmPro" -r "$free/assets/js"; then
  grep -q "wpeScmPro" -r "$pro/assets" || { echo "::error::Free reads window.wpeScmPro, which Pro no longer sets"; fail=1; }
  echo "ok JS global wpeScmPro"
fi
grep -q "^ \* Requires Plugins:.*shipping-cost-monitor-for-woocommerce" "$pro/shipping-cost-monitor-pro-for-woocommerce.php" || { echo "::error::Pro header must list shipping-cost-monitor-for-woocommerce in Requires Plugins"; fail=1; }
exit $fail
