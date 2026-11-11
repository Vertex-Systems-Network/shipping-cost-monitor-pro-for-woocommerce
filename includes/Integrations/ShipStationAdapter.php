<?php
/**
 * Read-only ShipStation V2 label evidence adapter.
 *
 * @package WPEssentialShippingCostMonitorPro
 */

namespace WPEssential\ShippingCostMonitorPro\Integrations;

defined( 'ABSPATH' ) || exit;

/**
 * Fetches bounded booked-label evidence. It never creates labels or mutates orders.
 */
final class ShipStationAdapter implements \WPEssential\ShippingCostMonitor\Integrations\CarrierAdapterInterface {
	private const OPTION_NAME = 'wpe_scm_shipstation_credentials';
	private const API_URL = 'https://api.shipstation.com/v2/labels';
	private const PAGE_SIZE = 100;
	private const MAX_WINDOW_DAYS = 31;

	public function get_id(): string {
		return 'shipstation';
	}

	public function get_label(): string {
		return 'ShipStation V2';
	}

	public function get_regions(): array {
		return array( 'Global; account and carrier availability dependent' );
	}

	public function get_capabilities(): array {
		return array( 'shipment_ids', 'tracking_ids', 'booked_costs' );
	}

	public function get_connection_state(): string {
		$stored = get_option( self::OPTION_NAME, false );
		if ( false === $stored ) {
			return 'disconnected';
		}
		$key = $this->decrypt_key( $stored );
		return is_wp_error( $key ) ? 'reauth_required' : 'connected';
	}

	/**
	 * Verify the API key remotely, then store it only as authenticated ciphertext.
	 *
	 * @param string $api_key ShipStation API V2 key.
	 * @return true|\WP_Error
	 */
	public function connect( string $api_key ) {
		if ( strlen( $api_key ) < 12 || strlen( $api_key ) > 512 || ! preg_match( '/^[A-Za-z0-9._-]+$/D', $api_key ) ) {
			return new \WP_Error( 'wpe_scm_shipstation_key_invalid', __( 'Enter a valid ShipStation V2 API key.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
		}

		$test = $this->request_labels( $api_key, array( 'page_size' => 1 ) );
		if ( is_wp_error( $test ) ) {
			return $test;
		}

		$encrypted = $this->encrypt_key( $api_key );
		if ( is_wp_error( $encrypted ) ) {
			return $encrypted;
		}

		update_option( self::OPTION_NAME, $encrypted, false );
		return true;
	}

	/**
	 * Remove saved encrypted credentials.
	 */
	public function disconnect(): void {
		delete_option( self::OPTION_NAME );
	}

	/**
	 * Validate stored credentials against the read-only labels endpoint.
	 *
	 * @return true|\WP_Error
	 */
	public function test_connection() {
		$key = $this->stored_key();
		if ( is_wp_error( $key ) ) {
			return $key;
		}
		$result = $this->request_labels( $key, array( 'page_size' => 1 ) );
		return is_wp_error( $result ) ? $result : true;
	}

	/**
	 * Fetch one bounded page of label evidence.
	 *
	 * @param array<string,mixed> $query Bounded from/to dates and page cursor.
	 * @return array|\WP_Error
	 */
	public function fetch_shipments( array $query ) {
		$key = $this->stored_key();
		if ( is_wp_error( $key ) ) {
			return $key;
		}

		$from = isset( $query['from'] ) && is_string( $query['from'] ) ? $query['from'] : '';
		$to = isset( $query['to'] ) && is_string( $query['to'] ) ? $query['to'] : '';
		$start = $this->parse_date( $from );
		$end = $this->parse_date( $to );
		if ( ! $start || ! $end || $start > $end || ( $end->getTimestamp() - $start->getTimestamp() ) > ( self::MAX_WINDOW_DAYS * DAY_IN_SECONDS ) ) {
			return new \WP_Error( 'wpe_scm_shipstation_date_range', __( 'Choose a valid date range of 31 days or less.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
		}

		$page = isset( $query['cursor'] ) && is_scalar( $query['cursor'] ) ? absint( $query['cursor'] ) : 1;
		$page = max( 1, min( 1000, $page ) );
		$labels = $this->request_labels(
			$key,
			array(
				'label_status'     => 'completed',
				'created_at_start' => $start->format( 'Y-m-d\T00:00:00\Z' ),
				'created_at_end'   => $end->format( 'Y-m-d\T23:59:59\Z' ),
				'page'             => $page,
				'page_size'        => self::PAGE_SIZE,
				'sort_by'          => 'created_at',
				'sort_dir'         => 'asc',
			)
		);
		if ( is_wp_error( $labels ) ) {
			return $labels;
		}

		if ( ! isset( $labels['labels'] ) || ! is_array( $labels['labels'] ) ) {
			return new \WP_Error( 'wpe_scm_shipstation_response', __( 'ShipStation returned an unsupported labels response.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
		}

		$items = array();
		foreach ( array_slice( $labels['labels'], 0, self::PAGE_SIZE ) as $label ) {
			if ( ! is_array( $label ) || ! empty( $label['voided'] ) || ! empty( $label['is_return_label'] ) ) {
				continue;
			}

			$cost = isset( $label['shipment_cost'] ) && is_array( $label['shipment_cost'] ) ? $label['shipment_cost'] : array();
			$amount = isset( $cost['amount'] ) && is_scalar( $cost['amount'] ) ? (string) $cost['amount'] : '';
			$currency = isset( $cost['currency'] ) && is_string( $cost['currency'] ) ? strtoupper( $cost['currency'] ) : '';
			if ( '' === $amount || ! is_numeric( $amount ) || (float) $amount < 0 || ! preg_match( '/^[A-Z]{3}$/D', $currency ) ) {
				continue;
			}

			$items[] = array(
				'provider_shipment_id' => isset( $label['shipment_id'] ) && is_string( $label['shipment_id'] ) ? sanitize_text_field( $label['shipment_id'] ) : '',
				'tracking_id'          => isset( $label['tracking_number'] ) && is_string( $label['tracking_number'] ) ? sanitize_text_field( $label['tracking_number'] ) : '',
				'order_reference'      => isset( $label['external_shipment_id'] ) && is_string( $label['external_shipment_id'] ) ? sanitize_text_field( $label['external_shipment_id'] ) : '',
				'amount'               => $amount,
				'currency'             => $currency,
				'evidence'             => 'booked_label',
				'tax_basis'            => 'unknown',
				'occurred_at'           => isset( $label['created_at'] ) && is_string( $label['created_at'] ) ? sanitize_text_field( $label['created_at'] ) : '',
				'label_id'             => isset( $label['label_id'] ) && is_string( $label['label_id'] ) ? sanitize_text_field( $label['label_id'] ) : '',
				'refund_status'        => isset( $label['refund_status'] ) && is_string( $label['refund_status'] ) ? sanitize_key( $label['refund_status'] ) : '',
			);
		}

		return array(
			'items'       => $items,
			'next_cursor' => count( $labels['labels'] ) >= self::PAGE_SIZE && $page < 1000 ? (string) ( $page + 1 ) : '',
		);
	}

	/**
	 * Request the fixed ShipStation endpoint and return decoded JSON only.
	 *
	 * @param string               $api_key API key.
	 * @param array<string,string|int> $params Query parameters.
	 * @return array|\WP_Error
	 */
	private function request_labels( string $api_key, array $params ) {
		$url = self::API_URL;
		if ( ! empty( $params ) ) {
			$url = add_query_arg( $params, $url );
		}
		$response = wp_remote_get(
			$url,
			array(
				'timeout'             => 15,
				'redirection'         => 0,
				'limit_response_size' => 1048576,
				'sslverify'           => true,
				'headers'             => array(
					'API-Key' => $api_key,
					'Accept'  => 'application/json',
				),
			)
		);
		if ( is_wp_error( $response ) ) {
			return new \WP_Error( 'wpe_scm_shipstation_unreachable', __( 'Could not reach ShipStation. Check the site connection and try again.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
		}

		$status = (int) wp_remote_retrieve_response_code( $response );
		if ( 401 === $status ) {
			return new \WP_Error( 'wpe_scm_shipstation_auth', __( 'ShipStation rejected the API key. Check it and reconnect.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
		}
		if ( 403 === $status ) {
			return new \WP_Error( 'wpe_scm_shipstation_scope', __( 'ShipStation denied access to label data for this account or plan.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
		}
		if ( 429 === $status ) {
			return new \WP_Error( 'wpe_scm_shipstation_rate_limit', __( 'ShipStation rate-limited the request. Wait before syncing again.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
		}
		if ( 200 !== $status ) {
			return new \WP_Error( 'wpe_scm_shipstation_response', __( 'ShipStation returned an unexpected response. No order data was changed.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
		}

		$body = wp_remote_retrieve_body( $response );
		$data = json_decode( $body, true );
		if ( ! is_array( $data ) ) {
			return new \WP_Error( 'wpe_scm_shipstation_json', __( 'ShipStation returned invalid JSON. No order data was changed.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
		}
		return $data;
	}

	/**
	 * Retrieve a decrypted API key without ever exposing it to public status.
	 *
	 * @return string|\WP_Error
	 */
	private function stored_key() {
		$stored = get_option( self::OPTION_NAME, false );
		if ( false === $stored ) {
			return new \WP_Error( 'wpe_scm_shipstation_disconnected', __( 'Connect a ShipStation API key before syncing.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
		}
		return $this->decrypt_key( $stored );
	}

	/**
	 * Encrypt credentials with a key derived only from site-configured WordPress salts.
	 *
	 * @param string $api_key Plain API key.
	 * @return array|\WP_Error
	 */
	private function encrypt_key( string $api_key ) {
		if ( ! function_exists( 'openssl_encrypt' ) || ! function_exists( 'random_bytes' ) ) {
			return new \WP_Error( 'wpe_scm_crypto_unavailable', __( 'Secure credential storage is unavailable on this server; the key was not saved.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
		}
		$key = $this->encryption_key();
		if ( is_wp_error( $key ) ) {
			return $key;
		}
		try {
			$iv = random_bytes( 12 );
		} catch ( \Throwable $error ) {
			return new \WP_Error( 'wpe_scm_crypto_unavailable', __( 'Could not create a secure credential envelope; the key was not saved.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
		}

		$tag = '';
		$ciphertext = openssl_encrypt( $api_key, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag, 'wpe-scm-shipstation-v1' );
		if ( false === $ciphertext || 16 !== strlen( $tag ) ) {
			return new \WP_Error( 'wpe_scm_crypto_unavailable', __( 'Could not encrypt the API key; the key was not saved.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
		}
		// phpcs:disable WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- Encodes binary IV, tag and ciphertext of the AES-256-GCM credential envelope for option storage; not code obfuscation.
		return array(
			'version'    => 1,
			'iv'         => base64_encode( $iv ),
			'tag'        => base64_encode( $tag ),
			'ciphertext' => base64_encode( $ciphertext ),
		);
		// phpcs:enable WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
	}

	/**
	 * Decrypt a stored envelope; malformed or rotated keys fail closed.
	 *
	 * @param mixed $stored Stored envelope.
	 * @return string|\WP_Error
	 */
	private function decrypt_key( $stored ) {
		if ( ! is_array( $stored ) || 1 !== ( $stored['version'] ?? null ) || ! isset( $stored['iv'], $stored['tag'], $stored['ciphertext'] ) ) {
			return new \WP_Error( 'wpe_scm_crypto_invalid', __( 'Reconnect ShipStation; its encrypted key is unavailable.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
		}
		if ( ! function_exists( 'openssl_decrypt' ) ) {
			return new \WP_Error( 'wpe_scm_crypto_unavailable', __( 'Secure credential storage is unavailable on this server.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
		}
		$key = $this->encryption_key();
		if ( is_wp_error( $key ) ) {
			return $key;
		}
		// phpcs:disable WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode -- Strictly decodes the stored credential envelope written by encrypt_key(); not code obfuscation.
		$iv = base64_decode( (string) $stored['iv'], true );
		$tag = base64_decode( (string) $stored['tag'], true );
		$ciphertext = base64_decode( (string) $stored['ciphertext'], true );
		// phpcs:enable WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode
		if ( false === $iv || 12 !== strlen( $iv ) || false === $tag || 16 !== strlen( $tag ) || false === $ciphertext || strlen( $ciphertext ) > 1024 ) {
			return new \WP_Error( 'wpe_scm_crypto_invalid', __( 'Reconnect ShipStation; its encrypted key is invalid.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
		}
		$plaintext = openssl_decrypt( $ciphertext, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag, 'wpe-scm-shipstation-v1' );
		return is_string( $plaintext ) && '' !== $plaintext
			? $plaintext
			: new \WP_Error( 'wpe_scm_crypto_invalid', __( 'Reconnect ShipStation; its encrypted key cannot be opened with the current site salts.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
	}

	/**
	 * Require unique, non-default salts from wp-config.php so ciphertext is not self-keyed in the DB.
	 *
	 * @return string|\WP_Error
	 */
	private function encryption_key() {
		if ( ! defined( 'AUTH_KEY' ) || ! defined( 'SECURE_AUTH_KEY' ) ) {
			return new \WP_Error( 'wpe_scm_crypto_salts', __( 'Add unique AUTH_KEY and SECURE_AUTH_KEY values in wp-config.php before connecting a carrier.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
		}
		$auth = (string) AUTH_KEY;
		$secure = (string) SECURE_AUTH_KEY;
		foreach ( array( $auth, $secure ) as $salt ) {
			if ( '' === $salt || false !== stripos( $salt, 'put your unique phrase here' ) || false !== stripos( $salt, 'change this to a unique phrase' ) ) {
				return new \WP_Error( 'wpe_scm_crypto_salts', __( 'Replace default WordPress salts in wp-config.php before connecting a carrier.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
			}
		}
		return hash_hmac( 'sha256', 'wpe_scm_shipstation_encryption_v1', $auth . '|' . $secure, true );
	}

	/**
	 * Parse a strict calendar date at UTC midnight.
	 *
	 * @param string $value Date in YYYY-MM-DD form.
	 * @return \DateTimeImmutable|false
	 */
	private function parse_date( string $value ) {
		if ( ! preg_match( '/^\d{4}-\d{2}-\d{2}$/D', $value ) ) {
			return false;
		}
		$date = \DateTimeImmutable::createFromFormat( '!Y-m-d', $value, new \DateTimeZone( 'UTC' ) );
		$errors = \DateTimeImmutable::getLastErrors();
		if ( ! $date || ( false !== $errors && ( ! empty( $errors['warning_count'] ) || ! empty( $errors['error_count'] ) ) ) ) {
			return false;
		}
		return $date->format( 'Y-m-d' ) === $value ? $date : false;
	}
}
