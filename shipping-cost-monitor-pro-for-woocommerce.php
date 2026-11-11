<?php
/**
 * Plugin Name: Shipping Cost Monitor Pro for WooCommerce
 * Plugin URI: https://wpessential.org
 * Description: Adds courier invoice CSV import with exact order matching and read-only ShipStation label costs to Shipping Cost Monitor for WooCommerce.
 * Version: 1.0.0
 * Requires at least: 7.0
 * Requires PHP: 8.1
 * WC requires at least: 11.2
 * WC tested up to: 11.2
 * Requires Plugins: woocommerce, shipping-cost-monitor-for-woocommerce
 * Author: WPEssential
 * Author URI: https://wpessential.org
 * License: GPL-2.0-or-later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: shipping-cost-monitor-pro-for-woocommerce
 * Update URI: https://woocommerce.com/products/shipping-cost-monitor-pro-for-woocommerce/
 *
 * @package WPEssentialShippingCostMonitorPro
 */

defined( 'ABSPATH' ) || exit;

if ( defined( 'WPE_SCM_PRO_FILE' ) ) {
	return;
}

define( 'WPE_SCM_PRO_VERSION', '1.0.0' );
define( 'WPE_SCM_PRO_FILE', __FILE__ );
define( 'WPE_SCM_PRO_DIR', plugin_dir_path( __FILE__ ) );
define( 'WPE_SCM_PRO_URL', plugin_dir_url( __FILE__ ) );

if ( ! function_exists( 'wpe_scm_pro_notice' ) ) {
	/**
	 * Print an admin notice for administrators.
	 *
	 * @param string $message Already translated message.
	 */
	function wpe_scm_pro_notice( string $message ): void {
		if ( ! current_user_can( 'activate_plugins' ) ) {
			return;
		}
		printf( '<div class="notice notice-error"><p>%s</p></div>', esc_html( $message ) );
	}
}

if ( ! is_readable( WPE_SCM_PRO_DIR . 'vendor/autoload.php' ) ) {
	add_action(
		'admin_notices',
		static function (): void {
			wpe_scm_pro_notice( __( 'Shipping Cost Monitor Pro is missing its generated files. Install the packaged Pro ZIP instead of the raw source.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
		}
	);
	return;
}

require_once WPE_SCM_PRO_DIR . 'vendor/autoload.php';

add_action(
	'before_woocommerce_init',
	static function (): void {
		if ( class_exists( '\\Automattic\\WooCommerce\\Utilities\\FeaturesUtil' ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', WPE_SCM_PRO_FILE, true );
		}
	}
);

// The free plugin fires this after its own modules are registered (WooCommerce active).
add_action( 'wpe_scm_init', array( \WPEssential\ShippingCostMonitorPro\Plugin::class, 'boot' ) );

add_action(
	'plugins_loaded',
	static function (): void {
		if ( ! did_action( 'wpe_scm_init' ) ) {
			add_action(
				'admin_notices',
				static function (): void {
					wpe_scm_pro_notice( __( 'Shipping Cost Monitor Pro needs Shipping Cost Monitor for WooCommerce and WooCommerce to be installed and active.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
				}
			);
		}
	},
	30
);

/**
 * Add a Documentation link beside Deactivate on the Plugins screen.
 */
add_filter(
	'plugin_action_links_' . plugin_basename( WPE_SCM_PRO_FILE ),
	static function ( $links ) {
		$links = is_array( $links ) ? $links : array();
		if ( ! defined( 'WPE_SCM_FILE' ) || ! class_exists( 'WooCommerce' ) || ! current_user_can( 'manage_woocommerce' ) ) {
			return $links;
		}
		$links['docs'] = sprintf(
			'<a href="%1$s">%2$s</a>',
			esc_url( admin_url( 'admin.php?page=shipping-cost-monitor-for-woocommerce&tab=docs&chapter=06-pro-invoice-import' ) ),
			esc_html__( 'Documentation', 'shipping-cost-monitor-pro-for-woocommerce' )
		);
		return $links;
	}
);
