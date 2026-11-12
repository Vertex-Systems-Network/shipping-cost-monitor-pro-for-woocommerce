# Shipping Cost Monitor Pro for WooCommerce

Paid add-on for [Shipping Cost Monitor for WooCommerce](https://github.com/Vertex-Systems-Network/shipping-cost-monitor-for-woocommerce) by WPEssential. It is sold on the WooCommerce.com Marketplace, which handles billing, subscriptions and updates.

**Pro needs the free plugin.** Install and activate *Shipping Cost Monitor for WooCommerce* first. Without it Pro does nothing and shows a notice. Its header declares `Requires Plugins: woocommerce, shipping-cost-monitor-for-woocommerce`.

## What Pro adds

- **Courier invoice CSV import**: map columns, match rows to orders by exact order number, review, then save confirmed costs onto the orders.
- **ShipStation label costs (read-only)**: connect a ShipStation V2 API key, preview label costs for a date range, and send them to the same review table. The key is stored encrypted.

Pro adds a panel to the free plugin's dashboard (**WooCommerce → Shipping Cost Monitor**). Its documentation is in the free plugin's built-in Documentation tab (chapters 6 and 7), and on the [free plugin's wiki](https://github.com/Vertex-Systems-Network/shipping-cost-monitor-for-woocommerce/wiki).

## How Free and Pro fit together

| | Free | Pro |
|---|---|---|
| Repository | `shipping-cost-monitor-for-woocommerce` | this repository |
| Distributed on | WordPress.org | WooCommerce.com |
| Works alone | Yes | No: needs Free |

Pro uses only these parts of Free, and both repositories' CI checks they still match (`.github/scripts/check-contract.sh`):

- actions `wpe_scm_init` and `wpe_scm_dashboard_enqueued`, filter `wpe_scm_dashboard_data` (Free also offers `wpe_scm_carrier_adapters`)
- constant `WPE_SCM_FILE`, script handle `wpe-scm-admin`, JS global `window.wpeScmDashboard`
- Free reads `window.wpeScmPro.InvoicePanel`, which Pro sets

## Building

There is no local build. The shared workflow (`.github/workflows/build-installable-zip.yml`, identical in both repositories) currently runs **only in the public free repository** (decision F-13): this private repository has no GitHub Actions budget. The free repository's CI reads this repository with a read-only token, runs the Free/Pro contract check and lints Pro on PHP 8.1–8.4, but uploads no Pro ZIP. To test a Pro branch, push a branch with the same name to the free repository, or run the free workflow manually with **other_ref** set to the Pro branch.

## Repository layout

```
shipping-cost-monitor-pro-for-woocommerce.php   Pro bootstrap (Requires Plugins: free plugin)
includes/                                       PHP classes (PSR-4, WPEssential\ShippingCostMonitorPro)
assets/js/pro.js                                Invoice import and ShipStation UI (wp.element, no build step)
uninstall.php, changelog.txt, composer.json, LICENSE
.github/                                        CI workflow and the Free/Pro contract check
```

Licensed GPL-2.0-or-later.
