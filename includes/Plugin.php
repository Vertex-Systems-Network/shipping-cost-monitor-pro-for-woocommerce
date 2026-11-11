<?php
/**
 * Pro add-on coordinator.
 *
 * @package WPEssentialShippingCostMonitorPro
 */

namespace WPEssential\ShippingCostMonitorPro;

defined( 'ABSPATH' ) || exit;

/**
 * Registers Pro modules on top of the free plugin.
 */
final class Plugin {
	/**
	 * Whether boot() already ran.
	 *
	 * @var bool
	 */
	private static bool $booted = false;

	/**
	 * Register Pro hooks. Called on the free plugin's wpe_scm_init action.
	 */
	public static function boot(): void {
		if ( self::$booted ) {
			return;
		}
		self::$booted = true;

		add_filter(
			'wpe_scm_carrier_adapters',
			static function ( $adapters ) {
				$adapters   = is_array( $adapters ) ? $adapters : array();
				$adapters[] = new Integrations\ShipStationAdapter();
				return $adapters;
			}
		);

		( new Admin\CarrierSyncController() )->register();
		( new Admin\ReferenceMatcher() )->register();
		( new Admin\InvoiceImporter() )->register();

		add_filter( 'wpe_scm_dashboard_data', array( self::class, 'dashboard_data' ) );
		add_action( 'wpe_scm_dashboard_enqueued', array( self::class, 'enqueue_assets' ) );
	}

	/**
	 * Add Pro endpoints, nonces and carrier status to the dashboard data.
	 *
	 * @param mixed $dashboard Dashboard data from the free plugin.
	 * @return array<string,mixed>
	 */
	public static function dashboard_data( $dashboard ): array {
		$dashboard = is_array( $dashboard ) ? $dashboard : array();

		$dashboard['ajax_url']           = admin_url( 'admin-ajax.php' );
		$dashboard['match_nonce']        = wp_create_nonce( 'wpe_scm_match_preview' );
		$dashboard['import_nonce']       = wp_create_nonce( 'wpe_scm_commit_invoice_rows' );
		$dashboard['carrier_nonce']      = wp_create_nonce( 'wpe_scm_carrier_manage' );
		$dashboard['carrier_sync_nonce'] = wp_create_nonce( 'wpe_scm_carrier_sync' );
		$dashboard['carrier_adapters']   = ( new \WPEssential\ShippingCostMonitor\Integrations\AdapterRegistry() )->get_public_status();
		$dashboard['pro_version']        = WPE_SCM_PRO_VERSION;

		return $dashboard;
	}

	/**
	 * Enqueue the Pro panel after the free dashboard script, which holds the localized data.
	 */
	public static function enqueue_assets(): void {
		wp_enqueue_script(
			'wpe-scm-pro',
			WPE_SCM_PRO_URL . 'assets/js/pro.js',
			array( 'wpe-scm-admin', 'wp-element', 'wp-i18n' ),
			WPE_SCM_PRO_VERSION,
			true
		);
		wp_set_script_translations( 'wpe-scm-pro', 'shipping-cost-monitor-pro-for-woocommerce' );
	}
}
