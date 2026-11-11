<?php
/**
 * Exact, non-persistent invoice reference matching preview.
 *
 * @package WPEssentialShippingCostMonitorPro
 */

namespace WPEssential\ShippingCostMonitorPro\Admin;

defined( 'ABSPATH' ) || exit;

/**
 * Matches a bounded set of invoice references without saving source rows.
 */
final class ReferenceMatcher {
	/**
	 * Register the private admin AJAX action.
	 */
	public function register(): void {
		add_action( 'wp_ajax_wpe_scm_match_preview', array( $this, 'match_preview' ) );
	}

	/**
	 * Return exact WooCommerce order-number or order-ID matches.
	 */
	public function match_preview(): void {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			wp_send_json_error(
				array( 'message' => __( 'You do not have permission to match invoice references.', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
				403
			);
		}

		$nonce_value = isset( $_POST['nonce'] ) && is_string( $_POST['nonce'] )
			// phpcs:ignore WordPress.Security.NonceVerification, WordPress.Security.ValidatedSanitizedInput -- This is the nonce check itself; the value is length-capped and sanitized below.
			? wp_unslash( $_POST['nonce'] )
			: '';
		$nonce = strlen( $nonce_value ) <= 128 ? sanitize_text_field( $nonce_value ) : '';

		if ( ! wp_verify_nonce( $nonce, 'wpe_scm_match_preview' ) ) {
			wp_send_json_error(
				array( 'message' => __( 'The matching request expired. Reload the page and try again.', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
				403
			);
		}

		$references = isset( $_POST['references'] ) && is_array( $_POST['references'] )
			// phpcs:ignore WordPress.Security.NonceVerification, WordPress.Security.ValidatedSanitizedInput -- Nonce verified above; each reference is type-checked, length-capped and sanitized before use.
			? wp_unslash( $_POST['references'] )
			: array();

		if ( empty( $references ) || count( $references ) > 50 ) {
			wp_send_json_error(
				array( 'message' => __( 'Match between 1 and 50 invoice rows at a time.', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
				400
			);
		}

		$normalized = array();
		foreach ( $references as $row ) {
			if ( ! is_array( $row ) || ! isset( $row['row'] ) || ! isset( $row['reference'] ) || ! is_scalar( $row['row'] ) || ! is_scalar( $row['reference'] ) ) {
				wp_send_json_error(
					array( 'message' => __( 'The reference list has an invalid row.', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
					400
				);
			}

			$row_value = (string) $row['row'];
			$raw_reference = (string) $row['reference'];
			if (
				strlen( $row_value ) > 4
				|| ! preg_match( '/^[1-9][0-9]{0,3}$/D', $row_value )
				|| (int) $row_value > 5000
				|| strlen( $raw_reference ) > 100
			) {
				wp_send_json_error(
					array( 'message' => __( 'The reference list has an invalid row.', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
					400
				);
			}

			$raw_reference = trim( $raw_reference );
			$reference = trim( sanitize_text_field( $raw_reference ) );
			$reference = preg_replace( '/^#\s*/', '', $reference );
			if ( '' === $reference || strlen( $reference ) > 100 ) {
				wp_send_json_error(
					array( 'message' => __( 'Each reference must contain 1 to 100 characters.', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
					400
				);
			}

			$normalized[] = array(
				'row'       => (int) $row_value,
				'reference' => $reference,
			);
		}

		$counts = array_count_values( array_column( $normalized, 'reference' ) );
		$results = array();

		foreach ( $normalized as $entry ) {
			$reference = $entry['reference'];
			if ( $counts[ $reference ] > 1 ) {
				$results[] = array(
					'row'    => $entry['row'],
					'status' => 'duplicate',
				);
				continue;
			}

			$matches = self::find_exact_matches( $reference );

			if ( 1 === count( $matches ) ) {
				$order = reset( $matches );
				$existing_amount = (string) $order->get_meta( '_wpe_scm_cost_amount', true );
				$has_existing_cost = '' !== $existing_amount;
				$result = array(
					'row'               => $entry['row'],
					'status'            => $has_existing_cost ? 'existing_cost' : 'matched',
					'order_id'          => $order->get_id(),
					'order_number'      => $order->get_order_number(),
					'order_status'      => $order->get_status(),
					'order_status_label' => wc_get_order_status_name( $order->get_status() ),
					'currency'          => $order->get_currency(),
					'has_existing_cost' => $has_existing_cost,
				);
				if ( $has_existing_cost ) {
					$result['existing_cost'] = array(
						'amount'    => wc_format_decimal( $existing_amount, wc_get_price_decimals() ),
						'currency'  => strtoupper( sanitize_text_field( (string) $order->get_meta( '_wpe_scm_cost_currency', true ) ) ),
						'evidence'  => sanitize_key( (string) $order->get_meta( '_wpe_scm_cost_evidence', true ) ),
						'tax_basis' => sanitize_key( (string) $order->get_meta( '_wpe_scm_cost_tax_basis', true ) ),
					);
				}
				$results[] = $result;
			} elseif ( count( $matches ) > 1 ) {
				$results[] = array(
					'row'    => $entry['row'],
					'status' => 'ambiguous',
				);
			} else {
				$results[] = array(
					'row'    => $entry['row'],
					'status' => 'unmatched',
				);
			}
		}

		wp_send_json_success(
			array(
				'results'     => $results,
				'persisted'   => false,
				'committed'   => false,
			)
		);
	}

	/**
	 * Resolve exact shipping-order matches for preview and commit validation.
	 *
	 * @param string $reference Normalized order reference.
	 * @return array<int,\WC_Order> Orders keyed by ID.
	 */
	public static function find_exact_matches( string $reference ): array {
		$candidate_ids = array();
		if ( function_exists( 'wc_order_search' ) ) {
			$search_results = wc_order_search( $reference );
			if ( is_array( $search_results ) ) {
				$candidate_ids = array_merge( $candidate_ids, $search_results );
			}
		}

		if ( ctype_digit( $reference ) ) {
			$order_id = filter_var( $reference, FILTER_VALIDATE_INT, array( 'options' => array( 'min_range' => 1 ) ) );
			if ( false !== $order_id ) {
				$candidate_ids[] = $order_id;
			}
		}

		$candidate_ids = array_unique( array_filter( array_map( 'absint', $candidate_ids ) ) );
		$matches = array();

		foreach ( $candidate_ids as $candidate_id ) {
			$order = wc_get_order( $candidate_id );
			if (
				$order instanceof \WC_Order
				&& 'shop_order' === $order->get_type()
				&& ! empty( $order->get_items( 'shipping' ) )
				&& (
					(string) $order->get_order_number() === $reference
					|| (string) $order->get_id() === $reference
				)
			) {
				$matches[ $order->get_id() ] = $order;
			}
		}

		return $matches;
	}
}
