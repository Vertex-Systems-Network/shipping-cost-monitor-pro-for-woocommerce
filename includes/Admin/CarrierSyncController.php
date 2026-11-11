<?php
/**
 * Authenticated ShipStation connection and bounded sync actions.
 *
 * @package WPEssentialShippingCostMonitorPro
 */

namespace WPEssential\ShippingCostMonitorPro\Admin;

defined( 'ABSPATH' ) || exit;

/**
 * Privileged AJAX boundary for API-key management and read-only label preview.
 */
final class CarrierSyncController {
	/**
	 * Register private admin actions.
	 */
	public function register(): void {
		add_action( 'wp_ajax_wpe_scm_shipstation_connect', array( $this, 'connect' ) );
		add_action( 'wp_ajax_wpe_scm_shipstation_disconnect', array( $this, 'disconnect' ) );
		add_action( 'wp_ajax_wpe_scm_shipstation_sync', array( $this, 'sync' ) );
	}

	/**
	 * Verify and securely store a ShipStation key.
	 */
	public function connect(): void {
		$this->authorize( 'wpe_scm_carrier_manage' );
		// phpcs:ignore WordPress.Security.NonceVerification, WordPress.Security.ValidatedSanitizedInput -- Nonce and capability verified in authorize() above; raw value is length-checked, then validated by the adapter.
		$key_value = isset( $_POST['api_key'] ) && is_string( $_POST['api_key'] ) ? wp_unslash( $_POST['api_key'] ) : '';
		if ( strlen( $key_value ) > 512 ) {
			wp_send_json_error( array( 'message' => __( 'The API key exceeds the supported length.', 'shipping-cost-monitor-pro-for-woocommerce' ) ), 400 );
		}
		$result = ( new \WPEssential\ShippingCostMonitorPro\Integrations\ShipStationAdapter() )->connect( trim( $key_value ) );
		if ( is_wp_error( $result ) ) {
			wp_send_json_error( array( 'message' => $result->get_error_message() ), 400 );
		}
		wp_send_json_success( array( 'state' => 'connected', 'message' => __( 'ShipStation connected. Its API key is stored encrypted on this site.', 'shipping-cost-monitor-pro-for-woocommerce' ) ) );
	}

	/**
	 * Delete the encrypted ShipStation credential envelope.
	 */
	public function disconnect(): void {
		$this->authorize( 'wpe_scm_carrier_manage' );
		( new \WPEssential\ShippingCostMonitorPro\Integrations\ShipStationAdapter() )->disconnect();
		wp_send_json_success( array( 'state' => 'disconnected', 'message' => __( 'ShipStation disconnected and its saved key was removed.', 'shipping-cost-monitor-pro-for-woocommerce' ) ) );
	}

	/**
	 * Fetch a bounded, PII-minimized label preview without changing orders.
	 */
	public function sync(): void {
		$this->authorize( 'wpe_scm_carrier_sync' );
		// phpcs:ignore WordPress.Security.NonceVerification, WordPress.Security.ValidatedSanitizedInput -- Nonce verified in authorize() above; length-checked here and sanitized below.
		$from_raw = isset( $_POST['from'] ) && is_string( $_POST['from'] ) ? wp_unslash( $_POST['from'] ) : '';
		// phpcs:ignore WordPress.Security.NonceVerification, WordPress.Security.ValidatedSanitizedInput -- Nonce and capability verified in authorize() above; raw value is length-checked, then validated by the adapter.
		$to_raw = isset( $_POST['to'] ) && is_string( $_POST['to'] ) ? wp_unslash( $_POST['to'] ) : '';
		// phpcs:ignore WordPress.Security.NonceVerification, WordPress.Security.ValidatedSanitizedInput -- Nonce and capability verified in authorize() above; raw value is length-checked, then validated by the adapter.
		$cursor = isset( $_POST['cursor'] ) && is_scalar( $_POST['cursor'] ) ? (string) wp_unslash( $_POST['cursor'] ) : '1';
		if ( strlen( $from_raw ) > 10 || strlen( $to_raw ) > 10 || strlen( $cursor ) > 4 || ! preg_match( '/^[1-9][0-9]{0,3}$/D', $cursor ) ) {
			wp_send_json_error( array( 'message' => __( 'The label preview request is invalid.', 'shipping-cost-monitor-pro-for-woocommerce' ) ), 400 );
		}
		$from = sanitize_text_field( $from_raw );
		$to = sanitize_text_field( $to_raw );
		$result = ( new \WPEssential\ShippingCostMonitorPro\Integrations\ShipStationAdapter() )->fetch_shipments(
			array(
				'from'   => $from,
				'to'     => $to,
				'cursor' => $cursor,
			)
		);
		if ( is_wp_error( $result ) ) {
			wp_send_json_error( array( 'message' => $result->get_error_message() ), 400 );
		}
		wp_send_json_success( $result );
	}

	/**
	 * Enforce capability and bounded action nonce.
	 *
	 * @param string $action Nonce action.
	 */
	private function authorize( string $action ): void {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			wp_send_json_error( array( 'message' => __( 'You do not have permission to manage carrier connections.', 'shipping-cost-monitor-pro-for-woocommerce' ) ), 403 );
		}
		// phpcs:ignore WordPress.Security.NonceVerification, WordPress.Security.ValidatedSanitizedInput -- This is the nonce check itself; the value is length-capped and sanitized on the next line.
		$raw_nonce = isset( $_POST['nonce'] ) && is_string( $_POST['nonce'] ) ? wp_unslash( $_POST['nonce'] ) : '';
		$nonce = strlen( $raw_nonce ) <= 128 ? sanitize_text_field( $raw_nonce ) : '';
		if ( ! wp_verify_nonce( $nonce, $action ) ) {
			wp_send_json_error( array( 'message' => __( 'The request expired. Reload the dashboard and try again.', 'shipping-cost-monitor-pro-for-woocommerce' ) ), 403 );
		}
	}
}
