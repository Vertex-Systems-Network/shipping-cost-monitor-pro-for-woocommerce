<?php
/**
 * Explicit, bounded invoice row commit into existing order cost records.
 *
 * @package WPEssentialShippingCostMonitorPro
 */

namespace WPEssential\ShippingCostMonitorPro\Admin;

defined( 'ABSPATH' ) || exit;

/**
 * Commits only reviewed, exact-matched invoice rows; raw files are never stored.
 */
final class InvoiceImporter {
	/**
	 * Register the privileged AJAX commit action.
	 */
	public function register(): void {
		add_action( 'wp_ajax_wpe_scm_commit_invoice_rows', array( $this, 'commit_rows' ) );
	}

	/**
	 * Validate and commit up to 50 explicitly selected invoice rows.
	 */
	public function commit_rows(): void {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			wp_send_json_error(
				array( 'message' => __( 'You do not have permission to import shipping costs.', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
				403
			);
		}

		$nonce_value = isset( $_POST['nonce'] ) && is_string( $_POST['nonce'] )
			// phpcs:ignore WordPress.Security.NonceVerification, WordPress.Security.ValidatedSanitizedInput -- This is the nonce check itself; the value is length-capped and sanitized below.
			? wp_unslash( $_POST['nonce'] )
			: '';
		$nonce = strlen( $nonce_value ) <= 128 ? sanitize_text_field( $nonce_value ) : '';

		if ( ! wp_verify_nonce( $nonce, 'wpe_scm_commit_invoice_rows' ) ) {
			wp_send_json_error(
				array( 'message' => __( 'The import request expired. Reload the page and review the rows again.', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
				403
			);
		}

		$rows = isset( $_POST['rows'] ) && is_array( $_POST['rows'] )
			// phpcs:ignore WordPress.Security.NonceVerification, WordPress.Security.ValidatedSanitizedInput -- Nonce verified above; each row field is type-checked, length-capped and sanitized in commit_row().
			? wp_unslash( $_POST['rows'] )
			: array();

		if ( empty( $rows ) || count( $rows ) > 50 ) {
			wp_send_json_error(
				array( 'message' => __( 'Commit between 1 and 50 matched rows at a time.', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
				400
			);
		}

		$duplicate_order_ids = array();
		foreach ( $rows as $row ) {
			if ( ! is_array( $row ) || ! isset( $row['order_id'] ) || ! is_scalar( $row['order_id'] ) ) {
				continue;
			}

			$candidate_id = (string) $row['order_id'];
			if ( strlen( $candidate_id ) <= 20 && preg_match( '/^[1-9][0-9]*$/D', $candidate_id ) ) {
				$duplicate_order_ids[ $candidate_id ] = ( $duplicate_order_ids[ $candidate_id ] ?? 0 ) + 1;
			}
		}

		$results = array();
		foreach ( $rows as $row ) {
			$candidate_id = is_array( $row ) && isset( $row['order_id'] ) && is_scalar( $row['order_id'] )
				? (string) $row['order_id']
				: '';

			if ( isset( $duplicate_order_ids[ $candidate_id ] ) && $duplicate_order_ids[ $candidate_id ] > 1 ) {
				$row_number = is_array( $row ) && isset( $row['row'] ) && is_scalar( $row['row'] )
					? (int) $row['row']
					: 0;
				$results[] = array(
					'row'    => $row_number,
					'status' => 'duplicate_order_in_batch',
				);
				continue;
			}

			$results[] = $this->commit_row( $row );
		}

		$has_committed_row = in_array( 'committed', array_column( $results, 'status' ), true );
		wp_send_json_success(
			array(
				'results'   => $results,
				'persisted' => $has_committed_row,
				'committed' => $has_committed_row,
			)
		);
	}

	/**
	 * Validate one row against the exact WooCommerce order before saving.
	 *
	 * @param mixed $row Submitted row.
	 * @return array<string,mixed>
	 */
	private function commit_row( $row ): array {
		if (
			! is_array( $row )
			|| ! isset( $row['row'], $row['order_id'], $row['reference'], $row['amount'], $row['currency'], $row['batch'] )
		) {
			return array( 'status' => 'invalid' );
		}

		$row_value      = is_scalar( $row['row'] ) ? (string) $row['row'] : '';
		$order_id_value = is_scalar( $row['order_id'] ) ? (string) $row['order_id'] : '';
		if (
			! preg_match( '/^[1-9][0-9]{0,3}$/D', $row_value )
			|| (int) $row_value > 5000
			|| strlen( $order_id_value ) > 20
			|| ! preg_match( '/^[1-9][0-9]*$/D', $order_id_value )
		) {
			return array( 'status' => 'invalid' );
		}

		$row_number   = (int) $row_value;
		$order_id     = filter_var( $order_id_value, FILTER_VALIDATE_INT, array( 'options' => array( 'min_range' => 1 ) ) );
		if ( false === $order_id ) {
			return array( 'status' => 'invalid' );
		}
		$raw_reference = is_scalar( $row['reference'] ) ? (string) $row['reference'] : '';
		$raw_amount    = is_scalar( $row['amount'] ) ? (string) $row['amount'] : '';
		$raw_currency  = is_scalar( $row['currency'] ) ? (string) $row['currency'] : '';
		$raw_batch     = is_scalar( $row['batch'] ) ? (string) $row['batch'] : '';
		$raw_evidence  = isset( $row['evidence'] ) && is_scalar( $row['evidence'] ) ? (string) $row['evidence'] : '';
		$raw_tax_basis = isset( $row['tax_basis'] ) && is_scalar( $row['tax_basis'] ) ? (string) $row['tax_basis'] : '';

		if (
			strlen( $raw_reference ) > 100
			|| strlen( $raw_amount ) > 64
			|| strlen( $raw_currency ) > 3
			|| strlen( $raw_batch ) > 64
			|| strlen( $raw_evidence ) > 32
			|| strlen( $raw_tax_basis ) > 16
		) {
			return array(
				'row'    => $row_number,
				'status' => 'invalid',
			);
		}

		$raw_reference = trim( $raw_reference );
		$raw_amount    = trim( $raw_amount );
		$raw_currency  = trim( $raw_currency );
		$raw_batch     = trim( $raw_batch );
		$raw_evidence  = trim( $raw_evidence );
		$raw_tax_basis = trim( $raw_tax_basis );

		$reference = preg_replace( '/^#\s*/', '', trim( sanitize_text_field( $raw_reference ) ) );
		$currency  = strtoupper( sanitize_text_field( $raw_currency ) );
		$batch_hash = strtolower( $raw_batch );
		$evidence  = sanitize_key( $raw_evidence );
		$tax_basis = sanitize_key( $raw_tax_basis );

		if (
			! $row_number
			|| ! $order_id
			|| '' === $reference
			|| strlen( $reference ) > 100
			|| ! preg_match( '/^[a-f0-9]{64}$/', $batch_hash )
			|| ! preg_match( '/^[0-9]+(?:\.[0-9]+)?$/D', $raw_amount )
			|| ! preg_match( '/^[A-Z]{3}$/', $currency )
			|| ! array_key_exists( $currency, get_woocommerce_currencies() )
			|| ! in_array( $evidence, array( 'invoice_final', 'merchant_confirmed', 'booked_label' ), true )
			|| ! in_array( $tax_basis, array( 'unknown', 'exclusive', 'inclusive' ), true )
		) {
			return array(
				'row'    => $row_number,
				'status' => 'invalid',
			);
		}

		$amount = wc_format_decimal( $raw_amount, wc_get_price_decimals(), false );
		if ( ! is_numeric( $amount ) ) {
			return array(
				'row'    => $row_number,
				'status' => 'invalid',
			);
		}

		$order = wc_get_order( $order_id );
		if (
			! $order instanceof \WC_Order
			|| 'shop_order' !== $order->get_type()
			|| empty( $order->get_items( 'shipping' ) )
			|| ! current_user_can( 'edit_shop_order', $order_id )
			|| (
				(string) $order->get_id() !== $reference
				&& (string) $order->get_order_number() !== $reference
			)
		) {
			return array(
				'row'    => $row_number,
				'status' => 'order_mismatch',
			);
		}

		$exact_matches = ReferenceMatcher::find_exact_matches( $reference );
		if ( count( $exact_matches ) > 1 ) {
			return array(
				'row'    => $row_number,
				'status' => 'ambiguous',
			);
		}
		if ( 1 !== count( $exact_matches ) || ! isset( $exact_matches[ $order_id ] ) ) {
			return array(
				'row'    => $row_number,
				'status' => 'order_mismatch',
			);
		}

		if ( strtoupper( $order->get_currency() ) !== $currency ) {
			return array(
				'row'    => $row_number,
				'status' => 'currency_mismatch',
				'order'  => $order->get_order_number(),
				'currency' => $order->get_currency(),
			);
		}

		$fingerprint = hash( 'sha256', $batch_hash . ':' . $row_number . ':' . $order_id );
		$saved_fingerprint = (string) $order->get_meta( '_wpe_scm_cost_import_fingerprint', true );

		if ( $saved_fingerprint === $fingerprint ) {
			return array(
				'row'    => $row_number,
				'status' => 'already_imported',
				'order'  => $order->get_order_number(),
			);
		}

		if ( '' !== (string) $order->get_meta( '_wpe_scm_cost_amount', true ) ) {
			return array(
				'row'    => $row_number,
				'status' => 'existing_cost',
				'order'  => $order->get_order_number(),
			);
		}

		$source = sprintf(
			/* translators: %d: invoice source row number. */
			__( 'Invoice CSV source row %d', 'shipping-cost-monitor-pro-for-woocommerce' ),
			$row_number
		);

		$order->update_meta_data( '_wpe_scm_cost_amount', $amount );
		$order->update_meta_data( '_wpe_scm_cost_currency', $currency );
		$order->update_meta_data( '_wpe_scm_cost_evidence', $evidence );
		$order->update_meta_data( '_wpe_scm_cost_tax_basis', $tax_basis );
		$order->update_meta_data( '_wpe_scm_cost_note', $source );
		$order->update_meta_data( '_wpe_scm_cost_updated_at', gmdate( 'Y-m-d H:i:s' ) );
		$order->update_meta_data( '_wpe_scm_cost_updated_by', get_current_user_id() );
		$order->update_meta_data( '_wpe_scm_cost_import_fingerprint', $fingerprint );
		$order->update_meta_data( '_wpe_scm_cost_import_batch', $batch_hash );
		$order->update_meta_data( '_wpe_scm_cost_import_row', $row_number );
		$order->save();

		$order->add_order_note(
			sprintf(
				/* translators: 1: amount, 2: currency, 3: source row, 4: evidence, 5: tax treatment. */
				__( 'Shipping cost imported from invoice CSV: %1$s %2$s, source row %3$d (%4$s; tax %5$s).', 'shipping-cost-monitor-pro-for-woocommerce' ),
				$amount,
				$currency,
				$row_number,
				$evidence,
				$tax_basis
			),
			0,
			true
		);

		return array(
			'row'    => $row_number,
			'status' => 'committed',
			'order'  => $order->get_order_number(),
		);
	}
}
