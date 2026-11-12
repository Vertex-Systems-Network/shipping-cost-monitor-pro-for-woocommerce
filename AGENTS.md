# Repository instructions for AI contributors (Pro add-on)

This repository is the **Pro add-on**. Product, architecture, QA gates and the decision register live in the free plugin's repository, `Vertex-Systems-Network/shipping-cost-monitor-for-woocommerce` (`AGENTS.md`, `docs/`). Read that repository's `AGENTS.md` first; its rules apply here too. Record decisions in its `docs/OWNER-DECISION-REGISTER.md`.

## Rules specific to Pro

- Slug, text domain, folder and main file: `shipping-cost-monitor-pro-for-woocommerce` (F-5, F-7). Namespace `WPEssential\ShippingCostMonitorPro`.
- Pro **requires the free plugin** and must keep `Requires Plugins: woocommerce, shipping-cost-monitor-for-woocommerce`. Never copy free-plugin code into Pro, and never put Pro code into the free repository (F-11).
- Pro is sold on WooCommerce.com, which handles billing and updates (F-8). Do not add licensing or update code, and do not add the `Woo:` header by hand.
- Carrier credentials: only the read-only ShipStation V2 adapter is authorised (A-2, C-3); it has not had an independent security review or a merchant-account test.

## Keeping Free and Pro in step (F-11)

- Pro may use only the Free contract listed in `README.md`. `.github/scripts/check-contract.sh` (identical in both repositories) fails CI when Free stops providing something Pro uses.
- **Every change, in either repository, must be checked against the other.** If a Pro change needs something new from Free (a hook, a data key, a constant), make the Free change too, in a branch with the **same name** in the free repository, and open both PRs. CI builds each branch against the same-named branch of the other repository, so the pair is tested together. Merge Free first.
- If a Free change alters or removes anything in the contract, update Pro in a same-named branch in this repository.
- If a change touches documented behaviour, update the free plugin's built-in documentation (`assets/docs/`) and the wiki in the same PR pair.
- Keep `.github/workflows/build-installable-zip.yml` and `.github/scripts/check-contract.sh` identical in both repositories, apart from the `paths:` trigger list.
- This repository stays private (F-12). It has no GitHub Actions budget, so CI does not run here (F-13): the shared workflow skips every job in this repository. Pro is checked and linted by the free repository's CI. Test a Pro branch there, on a same-named free branch or by running the free workflow manually with `other_ref` set to the Pro branch. No downloadable Pro ZIP is built for now. Never deliver ZIPs in chat.
