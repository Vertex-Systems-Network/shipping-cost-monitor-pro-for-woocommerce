<?php
/**
 * Uninstall cleanup.
 *
 * Removes the encrypted carrier credential. Order-level shipping cost records
 * are merchant accounting data stored on WooCommerce orders and are kept.
 *
 * @package WPEssentialShippingCostMonitorPro
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

delete_option( 'wpe_scm_shipstation_credentials' );
