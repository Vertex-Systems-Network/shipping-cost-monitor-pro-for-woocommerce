/**
 * Shipping Cost Monitor Pro for WooCommerce: invoice CSV import and carrier label review.
 * Registers its panel on window.wpeScmPro; the free dashboard renders it when present.
 */
( function ( wp ) {
	'use strict';

	if ( ! wp || ! wp.element || ! wp.i18n ) {
		return;
	}

	const h = wp.element.createElement;
	const __ = wp.i18n.__;
	const report = window.wpeScmDashboard || {};
	const carrierAdapters = Array.isArray( report.carrier_adapters ) ? report.carrier_adapters : [];

	function parseCsvRecords( text, delimiter ) {
		const rows = [];
		let row = [];
		let field = '';
		let inQuotes = false;
		let quoteClosed = false;
		const maximumColumns = 100;
		const maximumFieldLength = 65536;

		function appendField() {
			if ( row.length >= maximumColumns ) {
				throw new Error( __( 'This preview supports up to 100 columns per row.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
			}
			row.push( field );
			field = '';
			quoteClosed = false;
		}

		function appendCharacter( character ) {
			field += character;
			if ( field.length > maximumFieldLength ) {
				throw new Error( __( 'A CSV field exceeds the 65,536-character preview limit.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
			}
		}

		for ( let index = 0; index < text.length; index++ ) {
			const character = text[ index ];

			if ( '"' === character ) {
				if ( quoteClosed ) {
					throw new Error( __( 'Unexpected text follows a closing quote.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
				}
				if ( inQuotes && '"' === text[ index + 1 ] ) {
					appendCharacter( '"' );
					index++;
				} else if ( inQuotes ) {
					inQuotes = false;
					quoteClosed = true;
				} else if ( '' === field ) {
					inQuotes = true;
				} else {
					throw new Error( __( 'A quote appears in an invalid position.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
				}
				continue;
			}

			if ( quoteClosed && ( ! inQuotes && character !== delimiter && '\n' !== character && '\r' !== character ) ) {
				throw new Error( __( 'Unexpected text follows a closing quote.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
			}

			if ( ! inQuotes && character === delimiter ) {
				appendField();
				continue;
			}

			if ( ! inQuotes && ( '\n' === character || '\r' === character ) ) {
				if ( '\r' === character && '\n' === text[ index + 1 ] ) {
					index++;
				}
				appendField();
				rows.push( row );
				row = [];
				if ( rows.length > 5001 ) {
					throw new Error( __( 'This preview is limited to 5,000 data rows.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
				}
				continue;
			}

			appendCharacter( character );
		}

		if ( inQuotes ) {
			throw new Error( __( 'The CSV has an unclosed quoted field.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
		}

		if ( '' !== field || row.length > 0 ) {
			appendField();
			rows.push( row );
		}

		if ( rows.length > 5001 ) {
			throw new Error( __( 'This preview is limited to 5,000 data rows.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
		}

		return rows.filter( function ( values ) {
			return values.some( function ( value ) {
				return '' !== value.trim();
			} );
		} );
	}

	function normalizeOrderReference( value ) {
		return String( value || '' ).trim().replace( /^#\s*/, '' );
	}

	function parseInvoiceAmount( rawValue, decimalMark ) {
		let value = String( rawValue || '' ).trim().replace( /[\s\u00a0]/g, '' );
		if ( ',' === decimalMark ) {
			value = value.replace( /\./g, '' ).replace( ',', '.' );
		} else {
			value = value.replace( /,/g, '' );
		}

		return /^-?\d+(?:\.\d+)?$/.test( value ) ? value : null;
	}

	const mappingProfileStorageKey = 'wpeScmCsvMappingProfilesV1';

	function readMappingProfiles() {
		try {
			const stored = window.localStorage.getItem( mappingProfileStorageKey );
			const profiles = stored ? JSON.parse( stored ) : [];
			return Array.isArray( profiles ) ? profiles.filter( function ( profile ) {
				return profile &&
					'string' === typeof profile.id &&
					'string' === typeof profile.name &&
					profile.name.length <= 60 &&
					[ 'generic', 'woocommerce_shipping_labels' ].indexOf( profile.sourceFormat ) !== -1 &&
					Array.isArray( profile.headers ) &&
					profile.headers.length <= 500 &&
					profile.headers.every( function ( header ) { return 'string' === typeof header && header.length <= 200; } ) &&
					profile.mapping &&
					'string' === typeof profile.mapping.reference &&
					'string' === typeof profile.mapping.amount &&
					'string' === typeof profile.mapping.currency &&
					[ ',', ';', '\t' ].indexOf( profile.delimiter ) !== -1 &&
					[ '.', ',' ].indexOf( profile.decimalMark ) !== -1 &&
					[ 'invoice_final', 'booked_label', 'merchant_confirmed' ].indexOf( profile.evidence ) !== -1 &&
					[ 'unknown', 'exclusive', 'inclusive' ].indexOf( profile.taxBasis ) !== -1;
			} ).slice( 0, 20 ) : [];
		} catch ( error ) {
			return [];
		}
	}

	function statusText( code ) {
		const labels = {
			duplicate: __( 'Duplicate reference in this file', 'shipping-cost-monitor-pro-for-woocommerce' ),
			unmatched: __( 'No matching shipping order', 'shipping-cost-monitor-pro-for-woocommerce' ),
			ambiguous: __( 'More than one order matches', 'shipping-cost-monitor-pro-for-woocommerce' ),
			invalid: __( 'Missing or invalid required value', 'shipping-cost-monitor-pro-for-woocommerce' ),
			order_mismatch: __( 'Order changed since matching; match again', 'shipping-cost-monitor-pro-for-woocommerce' ),
			currency_mismatch: __( 'Currency differs from order', 'shipping-cost-monitor-pro-for-woocommerce' ),
			existing_cost: __( 'Existing cost kept', 'shipping-cost-monitor-pro-for-woocommerce' ),
			committed: __( 'Saved', 'shipping-cost-monitor-pro-for-woocommerce' ),
			already_imported: __( 'Already saved', 'shipping-cost-monitor-pro-for-woocommerce' ),
		};
		return labels[ code ] || String( code || '' );
	}

	function evidenceText( code ) {
		const labels = {
			invoice_final: __( 'Invoice-final', 'shipping-cost-monitor-pro-for-woocommerce' ),
			merchant_confirmed: __( 'Merchant-confirmed', 'shipping-cost-monitor-pro-for-woocommerce' ),
			booked_label: __( 'Booked label / manifest', 'shipping-cost-monitor-pro-for-woocommerce' ),
			estimate: __( 'Estimate only', 'shipping-cost-monitor-pro-for-woocommerce' ),
		};
		return labels[ code ] || String( code || '' );
	}

	function taxText( code ) {
		const labels = {
			exclusive: __( 'Tax-exclusive', 'shipping-cost-monitor-pro-for-woocommerce' ),
			inclusive: __( 'Tax-inclusive', 'shipping-cost-monitor-pro-for-woocommerce' ),
			unknown: __( 'Tax unknown', 'shipping-cost-monitor-pro-for-woocommerce' ),
		};
		return labels[ code ] || String( code || '' );
	}

	function CsvInvoicePreview() {
		const useState = wp.element.useState;
		const useEffect = wp.element.useEffect;
		const useRef = wp.element.useRef;
		const [ rawCsv, setRawCsv ] = useState( '' );
		const [ fileName, setFileName ] = useState( '' );
		const [ delimiter, setDelimiter ] = useState( ',' );
		const [ decimalMark, setDecimalMark ] = useState( '.' );
		const [ parsed, setParsed ] = useState( null );
		const [ mapping, setMapping ] = useState( { reference: '', amount: '', currency: '' } );
		const [ evidence, setEvidence ] = useState( 'invoice_final' );
		const [ taxBasis, setTaxBasis ] = useState( 'unknown' );
		const [ error, setError ] = useState( '' );
		const [ matchResults, setMatchResults ] = useState( {} );
		const [ matching, setMatching ] = useState( false );
		const [ matchError, setMatchError ] = useState( '' );
		const [ commitResults, setCommitResults ] = useState( {} );
		const [ committing, setCommitting ] = useState( false );
		const [ commitError, setCommitError ] = useState( '' );
		const [ rowFilter, setRowFilter ] = useState( 'all' );
		const [ sourceFormat, setSourceFormat ] = useState( 'generic' );
		const [ mappingProfiles, setMappingProfiles ] = useState( readMappingProfiles );
		const [ selectedProfileId, setSelectedProfileId ] = useState( '' );
		const [ profileNotice, setProfileNotice ] = useState( '' );
		const applyingProfileRef = useRef( false );

		useEffect( function () {
			if ( 'shipstation_api' === sourceFormat ) {
				return;
			}
			if ( ! rawCsv ) {
				setParsed( null );
				return;
			}

			try {
				const text = rawCsv.replace( /^\uFEFF/, '' );
				const records = parseCsvRecords( text, delimiter );
				if ( records.length < 2 ) {
					throw new Error( __( 'Select a CSV with a header row and at least one data row.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
				}

				const headers = records[ 0 ].map( function ( value ) {
					return value.trim();
				} );
				if ( headers.some( function ( value ) { return '' === value; } ) ) {
					throw new Error( __( 'Every CSV column needs a non-empty header.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
				}

				const rows = records.slice( 1 ).map( function ( values, index ) {
					return { number: index + 2, values: values };
				} );
				const findHeader = function ( aliases ) {
					const index = headers.findIndex( function ( header ) {
						const normalized = header.toLowerCase().replace( /[^a-z0-9]/g, '' );
						return aliases.indexOf( normalized ) !== -1;
					} );
					return index >= 0 ? String( index ) : '';
				};

				setParsed( { headers: headers, rows: rows } );
				setMatchResults( {} );
				setCommitResults( {} );
				if ( applyingProfileRef.current ) {
					applyingProfileRef.current = false;
				} else {
					const isWooCommerceShipping = 'woocommerce_shipping_labels' === sourceFormat;
					setMapping( {
						reference: findHeader( isWooCommerceShipping ? [ 'order', 'ordernumber', 'orderid', 'ordername' ] : [ 'order', 'ordernumber', 'orderid' ] ),
						amount: findHeader( isWooCommerceShipping ? [ 'price', 'labelprice', 'labelcost', 'amount', 'cost' ] : [ 'amount', 'charge', 'shippingcost', 'shippingcharge', 'cost', 'total', 'price', 'labelprice', 'labelcost' ] ),
						currency: isWooCommerceShipping ? '__order_currency__' : findHeader( [ 'currency', 'currencycode', 'iso' ] ),
					} );
					if ( isWooCommerceShipping ) {
						setEvidence( 'booked_label' );
						setTaxBasis( 'unknown' );
					}
				}
				setError( '' );
			} catch ( parseError ) {
				setParsed( null );
				setError( parseError.message || __( 'Could not read this CSV.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
			}
		}, [ rawCsv, delimiter, sourceFormat ] );

		function useShipStationLabels( items ) {
			const rows = ( Array.isArray( items ) ? items : [] ).slice( 0, 100 ).map( function ( item, index ) {
				return { number: index + 2, values: [ String( item.order_reference || '' ), String( item.amount || '' ), String( item.currency || '' ), String( item.refund_status || '' ), String( item.label_id || '' ), String( item.occurred_at || '' ) ] };
			} );
			setSourceFormat( 'shipstation_api' );
			setRawCsv( '' );
			setFileName( __( 'ShipStation label API preview', 'shipping-cost-monitor-pro-for-woocommerce' ) );
			setParsed( { headers: [ 'Order reference', 'Booked cost', 'Currency', 'Refund status', 'Label ID', 'Created at' ], rows: rows } );
			setMapping( { reference: '0', amount: '1', currency: '2' } );
			setEvidence( 'booked_label' );
			setTaxBasis( 'unknown' );
			setMatchResults( {} );
			setCommitResults( {} );
			setMatchError( '' );
			setCommitError( '' );
			setError( '' );
		}

		function saveMappingProfile() {
			if ( ! parsed || ! mapping.reference || ! mapping.amount ) {
				setProfileNotice( __( 'Choose a file and map its order reference and amount columns first.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
				return;
			}

			const name = window.prompt( __( 'Name this CSV mapping profile', 'shipping-cost-monitor-pro-for-woocommerce' ) );
			if ( ! name ) {
				return;
			}
			const cleanName = name.trim().slice( 0, 60 );
			if ( ! cleanName ) {
				return;
			}
			const profile = {
				id: String( Date.now() ),
				name: cleanName,
				sourceFormat: sourceFormat,
				headers: parsed.headers,
				mapping: mapping,
				delimiter: delimiter,
				decimalMark: decimalMark,
				evidence: evidence,
				taxBasis: taxBasis,
			};
			const nextProfiles = mappingProfiles.filter( function ( item ) {
				return item.name.toLowerCase() !== cleanName.toLowerCase();
			} ).concat( [ profile ] ).slice( -20 );
			try {
				window.localStorage.setItem( mappingProfileStorageKey, JSON.stringify( nextProfiles ) );
				setMappingProfiles( nextProfiles );
				setSelectedProfileId( profile.id );
				setProfileNotice( __( 'Mapping profile saved in this browser. It contains column names and import settings only.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
			} catch ( error ) {
				setProfileNotice( __( 'Browser storage is unavailable, so the mapping profile was not saved.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
			}
		}

		function applyMappingProfile() {
			const profile = mappingProfiles.find( function ( item ) { return item.id === selectedProfileId; } );
			if ( ! profile || ! parsed ) {
				return;
			}
			if ( profile.sourceFormat !== sourceFormat || JSON.stringify( profile.headers ) !== JSON.stringify( parsed.headers ) ) {
				setProfileNotice( __( 'This profile belongs to a different source format or header layout.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
				return;
			}
			setMapping( profile.mapping );
			if ( profile.delimiter !== delimiter ) {
				applyingProfileRef.current = true;
				setDelimiter( profile.delimiter );
			}
			setDecimalMark( profile.decimalMark );
			setEvidence( profile.evidence );
			setTaxBasis( profile.taxBasis );
			setMatchResults( {} );
			setCommitResults( {} );
			setProfileNotice( __( 'Mapping profile applied to the current preview.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
		}

		function deleteMappingProfile() {
			const nextProfiles = mappingProfiles.filter( function ( item ) { return item.id !== selectedProfileId; } );
			try {
				window.localStorage.setItem( mappingProfileStorageKey, JSON.stringify( nextProfiles ) );
				setMappingProfiles( nextProfiles );
				setSelectedProfileId( '' );
				setProfileNotice( __( 'Mapping profile deleted from this browser.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
			} catch ( error ) {
				setProfileNotice( __( 'Browser storage is unavailable, so the mapping profile could not be deleted.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
			}
		}

		function chooseFile( event ) {
			const file = event.target.files && event.target.files[ 0 ];
			if ( ! file ) {
				return;
			}

			setSourceFormat( 'generic' );
			setRawCsv( '' );
			setParsed( null );
			setMatchResults( {} );
			setCommitResults( {} );
			if ( file.size > 5242880 ) {
				setFileName( '' );
				setError( __( 'Files must be 5 MB or smaller.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
				return;
			}
			if ( ! /\.csv$/i.test( file.name ) ) {
				setFileName( '' );
				setError( __( 'Choose a .csv file.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
				return;
			}

			setFileName( file.name );
			setError( '' );
			const reader = new FileReader();
			reader.onload = function () {
				setRawCsv( String( reader.result || '' ) );
			};
			reader.onerror = function () {
				setError( __( 'The selected file could not be read.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
			};
			reader.readAsText( file );
		}

		function selectSourceFormat( event ) {
			const format = event.target.value;
			setSourceFormat( format );
			if ( 'woocommerce_shipping_labels' !== format ) {
				return;
			}

			const headers = parsed ? parsed.headers : [];
			const findColumn = function ( aliases ) {
				const index = headers.findIndex( function ( header ) {
					return aliases.indexOf( header.toLowerCase().replace( /[^a-z0-9]/g, '' ) ) !== -1;
				} );
				return index >= 0 ? String( index ) : '';
			};
			setMapping( {
				reference: findColumn( [ 'order', 'ordernumber', 'orderid', 'ordername' ] ),
				amount: findColumn( [ 'price', 'labelprice', 'labelcost', 'amount', 'cost' ] ),
				currency: '__order_currency__',
			} );
			setEvidence( 'booked_label' );
			setTaxBasis( 'unknown' );
			setDecimalMark( '.' );
			setMatchResults( {} );
			setCommitResults( {} );
			setMatchError( '' );
			setCommitError( '' );
		}

		function clearPreview() {
			setSourceFormat( 'generic' );
			setRawCsv( '' );
			setFileName( '' );
			setParsed( null );
			setMapping( { reference: '', amount: '', currency: '' } );
			setMatchResults( {} );
			setCommitResults( {} );
			setError( '' );
			setMatchError( '' );
			setCommitError( '' );
		}

		function hasRefundStatus( item ) {
			if ( ! parsed ) {
				return false;
			}
			const refundIndex = parsed.headers.findIndex( function ( header ) {
				const normalized = header.toLowerCase().replace( /[^a-z0-9]/g, '' );
				return [ 'refundstatus', 'refundstate', 'labelrefundstatus', 'refund' ].indexOf( normalized ) !== -1;
			} );
			if ( refundIndex < 0 ) {
				return false;
			}
			const value = String( item.values[ refundIndex ] || '' ).toLowerCase().replace( /[^a-z0-9]/g, '' );
			return '' !== value && [ 'none', 'norefund', 'notrefunded', 'no', 'false', 'na' ].indexOf( value ) === -1;
		}

		const validRows = parsed && mapping.reference !== '' && mapping.amount !== '' && mapping.currency !== ''
			? parsed.rows.filter( function ( item ) {
				const reference = item.values[ Number( mapping.reference ) ] || '';
				const amount = parseInvoiceAmount( item.values[ Number( mapping.amount ) ], decimalMark );
				const currency = '__order_currency__' === mapping.currency ? '' : String( item.values[ Number( mapping.currency ) ] || '' ).trim();
				const currencyValid = '__order_currency__' === mapping.currency || /^[A-Za-z]{3}$/.test( currency );
				return '' !== reference.trim() && null !== amount && '-' !== amount.charAt( 0 ) && currencyValid && ! hasRefundStatus( item );
			} )
			: [];

		const matchedRows = validRows.slice( 0, 50 ).filter( function ( item ) {
			const match = matchResults[ item.number ];
			const invoiceCurrency = '__order_currency__' === mapping.currency ? String( match && match.currency || '' ).toUpperCase() : String( item.values[ Number( mapping.currency ) ] || '' ).trim().toUpperCase();
			return match
				&& 'matched' === match.status
				&& invoiceCurrency === String( match.currency || '' ).toUpperCase()
				&& ! commitResults[ item.number ];
		} );

		function getRowStatus( item ) {
			const reference = '' !== mapping.reference ? String( item.values[ Number( mapping.reference ) ] || '' ).trim() : '';
			const amountRaw = '' !== mapping.amount ? item.values[ Number( mapping.amount ) ] || '' : '';
			const amount = '' !== mapping.amount ? parseInvoiceAmount( amountRaw, decimalMark ) : null;
			const currency = '__order_currency__' === mapping.currency ? '' : ( '' !== mapping.currency ? String( item.values[ Number( mapping.currency ) ] || '' ).trim() : '' );
			const currencyValid = '__order_currency__' === mapping.currency || /^[A-Za-z]{3}$/.test( currency );
			const valid = '' !== reference && null !== amount && '-' !== amount.charAt( 0 ) && currencyValid && ! hasRefundStatus( item );
			if ( hasRefundStatus( item ) ) { return 'refund_review'; }
			if ( commitResults[ item.number ] ) {
				return [ 'committed', 'already_imported' ].indexOf( commitResults[ item.number ].status ) !== -1 ? 'saved' : 'exception';
			}
			if ( matchResults[ item.number ] ) {
				const match = matchResults[ item.number ];
				if ( 'matched' !== match.status ) { return 'exception'; }
				const invoiceCurrency = '__order_currency__' === mapping.currency ? String( match.currency || '' ).toUpperCase() : String( item.values[ Number( mapping.currency ) ] || '' ).trim().toUpperCase();
				return invoiceCurrency === String( match.currency || '' ).toUpperCase() ? 'ready' : 'currency_mismatch';
			}
			return valid ? 'unmatched' : 'invalid';
		}

		const previewRows = parsed
			? parsed.rows.slice( 0, Object.keys( matchResults ).length > 0 ? 50 : 10 ).filter( function ( item ) {
				if ( 'all' === rowFilter ) { return true; }
				if ( 'needs_review' === rowFilter ) { return [ 'exception', 'invalid', 'unmatched', 'currency_mismatch', 'refund_review' ].indexOf( getRowStatus( item ) ) !== -1; }
				return getRowStatus( item ) === rowFilter;
			} )
			: [];

		function matchReferences() {
			if ( ! report.ajax_url || ! report.match_nonce || ! parsed ) {
				setMatchError( __( 'Matching is unavailable. Reload the dashboard and try again.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
				return;
			}

			const rowsToMatch = validRows.slice( 0, 50 );
			if ( rowsToMatch.length < 1 ) {
				setMatchError( __( 'Map the order ID/number and amount columns, then map a currency column or choose the matched order currency.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
				return;
			}

			const body = new FormData();
			body.append( 'action', 'wpe_scm_match_preview' );
			body.append( 'nonce', report.match_nonce );
			rowsToMatch.forEach( function ( item, index ) {
				body.append( 'references[' + index + '][row]', String( item.number ) );
				body.append( 'references[' + index + '][reference]', normalizeOrderReference( item.values[ Number( mapping.reference ) ] || '' ) );
			} );

			setMatching( true );
			setMatchError( '' );
			setCommitError( '' );
			setCommitResults( {} );
			fetch( report.ajax_url, { method: 'POST', credentials: 'same-origin', body: body } )
				.then( function ( response ) { return response.json(); } )
				.then( function ( payload ) {
					if ( ! payload || ! payload.success || ! payload.data || ! Array.isArray( payload.data.results ) ) {
						throw new Error( payload && payload.data && payload.data.message ? payload.data.message : __( 'The matching request failed.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
					}
					const resultMap = {};
					payload.data.results.forEach( function ( result ) {
						resultMap[ result.row ] = result;
					} );
					setMatchResults( resultMap );
				} )
				.catch( function ( requestError ) {
					setMatchError( requestError.message || __( 'The matching request failed.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
				} )
				.finally( function () { setMatching( false ); } );
		}

		async function createBatchHash() {
			if ( ! window.crypto || ! window.crypto.subtle || ! window.TextEncoder ) {
				throw new Error( __( 'Secure file fingerprinting is unavailable in this browser. No invoice data was sent.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
			}

			const signature = [
				rawCsv || ( parsed ? JSON.stringify( parsed.rows ) : '' ),
				sourceFormat,
				delimiter,
				decimalMark,
				mapping.reference,
				mapping.amount,
				mapping.currency,
				evidence,
				taxBasis,
			].join( '\n' );
			const digest = await window.crypto.subtle.digest( 'SHA-256', new window.TextEncoder().encode( signature ) );
			return Array.from( new Uint8Array( digest ) ).map( function ( byte ) {
				return byte.toString( 16 ).padStart( 2, '0' );
			} ).join( '' );
		}

		async function commitMatchedRows() {
			if ( ! report.ajax_url || ! report.import_nonce || matchedRows.length < 1 ) {
				setCommitError( __( 'There are no matched rows ready to save.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
				return;
			}

			if ( ! window.confirm( __( 'Save these matched courier costs to their WooCommerce orders? Existing cost records will be left unchanged.', 'shipping-cost-monitor-pro-for-woocommerce' ) ) ) {
				return;
			}

			setCommitting( true );
			setCommitError( '' );
			try {
				const batchHash = await createBatchHash();
				const body = new FormData();
				body.append( 'action', 'wpe_scm_commit_invoice_rows' );
				body.append( 'nonce', report.import_nonce );

				matchedRows.forEach( function ( item, index ) {
					const match = matchResults[ item.number ];
					const amount = parseInvoiceAmount( item.values[ Number( mapping.amount ) ], decimalMark );
					const currency = '__order_currency__' === mapping.currency ? String( match.currency || '' ).toUpperCase() : String( item.values[ Number( mapping.currency ) ] || '' ).trim().toUpperCase();
					body.append( 'rows[' + index + '][row]', String( item.number ) );
					body.append( 'rows[' + index + '][order_id]', String( match.order_id ) );
					body.append( 'rows[' + index + '][reference]', normalizeOrderReference( item.values[ Number( mapping.reference ) ] || '' ) );
					body.append( 'rows[' + index + '][amount]', amount );
					body.append( 'rows[' + index + '][currency]', currency );
					body.append( 'rows[' + index + '][batch]', batchHash );
					body.append( 'rows[' + index + '][evidence]', evidence );
					body.append( 'rows[' + index + '][tax_basis]', taxBasis );
				} );

				const response = await fetch( report.ajax_url, { method: 'POST', credentials: 'same-origin', body: body } );
				const payload = await response.json();
				if ( ! payload || ! payload.success || ! payload.data || ! Array.isArray( payload.data.results ) ) {
					throw new Error( payload && payload.data && payload.data.message ? payload.data.message : __( 'The invoice rows could not be saved.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
				}

				const resultMap = {};
				payload.data.results.forEach( function ( result ) {
					resultMap[ result.row ] = result;
				} );
				setCommitResults( resultMap );
			} catch ( commitRequestError ) {
				setCommitError( commitRequestError.message || __( 'The invoice rows could not be saved.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
			} finally {
				setCommitting( false );
			}
		}

		const headerCounts = parsed ? parsed.headers.reduce( function ( counts, header ) {
			const normalized = header.trim().toLowerCase();
			counts[ normalized ] = ( counts[ normalized ] || 0 ) + 1;
			return counts;
		}, {} ) : {};
		const fieldSelect = function ( label, field ) {
			return h(
				'label',
				{ className: 'wpe-scm-import-field' },
				label,
				h(
					'select',
					{
						value: mapping[ field ],
						onChange: function ( event ) {
							setMapping( Object.assign( {}, mapping, { [ field ]: event.target.value } ) );
							setMatchResults( {} );
							setCommitResults( {} );
						},
					},
					h( 'option', { value: '' }, __( 'Choose a column', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
					field === 'currency' ? h( 'option', { value: '__order_currency__' }, __( 'Use matched order currency', 'shipping-cost-monitor-pro-for-woocommerce' ) ) : null,
					parsed ? parsed.headers.map( function ( header, index ) {
						const normalized = header.trim().toLowerCase();
						const headerLabel = headerCounts[ normalized ] > 1
							? header + ' (' + __( 'Column', 'shipping-cost-monitor-pro-for-woocommerce' ) + ' ' + ( index + 1 ) + ')'
							: header;
						return h( 'option', { key: index, value: String( index ) }, headerLabel );
					} ) : null
				)
			);
		};

		return h(
			'section',
			{ className: 'wpe-scm-card wpe-scm-import-card' },
			h( 'p', { className: 'wpe-scm-eyebrow' }, __( 'INVOICE CSV PREVIEW', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
			h( 'h2', null, __( 'Preview a courier invoice CSV', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
			h( 'p', { className: 'wpe-scm-import-privacy' }, __( 'The file stays in this browser. Matching sends mapped order references to WordPress. Saving sends only matched row values and order IDs; the raw file and other columns are not stored. Mapping profiles are saved only in this browser and contain column names/settings, not invoice rows.', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
			mappingProfiles.length && 'shipstation_api' !== sourceFormat ? h( 'div', { className: 'wpe-scm-import-toolbar' },
				h( 'label', { className: 'wpe-scm-import-field' }, __( 'Saved mapping profile', 'shipping-cost-monitor-pro-for-woocommerce' ), h( 'select', { value: selectedProfileId, onChange: function ( event ) { setSelectedProfileId( event.target.value ); } }, h( 'option', { value: '' }, __( 'Choose a saved profile', 'shipping-cost-monitor-pro-for-woocommerce' ) ), mappingProfiles.map( function ( profile ) { return h( 'option', { key: profile.id, value: profile.id }, profile.name ); } ) ) ),
				h( 'button', { type: 'button', className: 'button', onClick: applyMappingProfile, disabled: ! parsed || ! selectedProfileId }, __( 'Apply profile', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
				h( 'button', { type: 'button', className: 'button', onClick: deleteMappingProfile, disabled: ! selectedProfileId }, __( 'Delete profile', 'shipping-cost-monitor-pro-for-woocommerce' ) )
			) : null,
			parsed && 'shipstation_api' !== sourceFormat ? h( 'div', { className: 'wpe-scm-import-toolbar' }, h( 'button', { type: 'button', className: 'button', onClick: saveMappingProfile }, __( 'Save current mapping', 'shipping-cost-monitor-pro-for-woocommerce' ) ) ) : null,
			profileNotice ? h( 'p', { className: 'wpe-scm-report-notice', role: 'status' }, profileNotice ) : null,
			h( CarrierConnections, { onReviewLabels: useShipStationLabels } ),
			h(
				'div',
				{ className: 'wpe-scm-import-toolbar' },
				h( 'label', { className: 'wpe-scm-import-field' }, __( 'Source format', 'shipping-cost-monitor-pro-for-woocommerce' ), h( 'select', { value: sourceFormat, onChange: selectSourceFormat }, sourceFormat === 'shipstation_api' ? h( 'option', { value: 'shipstation_api', disabled: true }, __( 'ShipStation API label preview', 'shipping-cost-monitor-pro-for-woocommerce' ) ) : null, h( 'option', { value: 'generic' }, __( 'Generic courier CSV', 'shipping-cost-monitor-pro-for-woocommerce' ) ), h( 'option', { value: 'woocommerce_shipping_labels' }, __( 'WooCommerce Shipping label report', 'shipping-cost-monitor-pro-for-woocommerce' ) ) ) ),

				h( 'label', { className: 'wpe-scm-file-field' }, __( 'Choose CSV file (5 MB max)', 'shipping-cost-monitor-pro-for-woocommerce' ), h( 'input', { type: 'file', accept: '.csv,text/csv', onChange: chooseFile } ) ),
				h(
					'label',
					{ className: 'wpe-scm-import-field' },
					__( 'Column separator', 'shipping-cost-monitor-pro-for-woocommerce' ),
					h( 'select', { value: delimiter, onChange: function ( event ) { setDelimiter( event.target.value ); setMatchResults( {} ); setCommitResults( {} ); } },
						h( 'option', { value: ',' }, __( 'Comma', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
						h( 'option', { value: ';' }, __( 'Semicolon', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
						h( 'option', { value: '\t' }, __( 'Tab', 'shipping-cost-monitor-pro-for-woocommerce' ) )
					)
				),
				h(
					'label',
					{ className: 'wpe-scm-import-field' },
					__( 'Decimal mark', 'shipping-cost-monitor-pro-for-woocommerce' ),
					h( 'select', { value: decimalMark, onChange: function ( event ) { setDecimalMark( event.target.value ); setMatchResults( {} ); setCommitResults( {} ); } },
						h( 'option', { value: '.' }, __( 'Period (1,234.56)', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
						h( 'option', { value: ',' }, __( 'Comma (1.234,56)', 'shipping-cost-monitor-pro-for-woocommerce' ) )
					)
				),
				h(
					'label',
					{ className: 'wpe-scm-import-field' },
					__( 'Imported evidence', 'shipping-cost-monitor-pro-for-woocommerce' ),
					h( 'select', { value: evidence, onChange: function ( event ) { setEvidence( event.target.value ); setCommitResults( {} ); } },
						h( 'option', { value: 'invoice_final' }, __( 'Invoice-final', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
						h( 'option', { value: 'booked_label' }, __( 'Booked label / manifest', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
						h( 'option', { value: 'merchant_confirmed' }, __( 'Merchant-confirmed', 'shipping-cost-monitor-pro-for-woocommerce' ) )
					)
				),
				h(
					'label',
					{ className: 'wpe-scm-import-field' },
					__( 'Cost tax treatment', 'shipping-cost-monitor-pro-for-woocommerce' ),
					h( 'select', { value: taxBasis, onChange: function ( event ) { setTaxBasis( event.target.value ); setCommitResults( {} ); } },
						h( 'option', { value: 'unknown' }, __( 'Unknown — do not compare', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
						h( 'option', { value: 'exclusive' }, __( 'Tax-exclusive', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
						h( 'option', { value: 'inclusive' }, __( 'Tax-inclusive', 'shipping-cost-monitor-pro-for-woocommerce' ) )
					)
				)
			),
			fileName ? h( 'p', { className: 'wpe-scm-import-file' }, __( 'Selected:', 'shipping-cost-monitor-pro-for-woocommerce' ) + ' ' + fileName ) : null,
			sourceFormat === 'woocommerce_shipping_labels' ? h( 'p', { className: 'wpe-scm-report-notice', role: 'status' }, __( 'This preset treats label prices as booked costs, uses the matched order currency and holds refund-status rows for review. Orders with multiple label rows may be marked duplicate and require separate reconciliation.', 'shipping-cost-monitor-pro-for-woocommerce' ) ) : null,
			error ? h( 'p', { className: 'wpe-scm-report-notice', role: 'alert' }, error ) : null,
			matchError ? h( 'p', { className: 'wpe-scm-report-notice', role: 'alert' }, matchError ) : null,
			commitError ? h( 'p', { className: 'wpe-scm-report-notice', role: 'alert' }, commitError ) : null,
			parsed ? h(
				'div',
				{ className: 'wpe-scm-import-preview' },
				h( 'div', { className: 'wpe-scm-import-mapping' },
					fieldSelect( __( 'Order ID / number', 'shipping-cost-monitor-pro-for-woocommerce' ), 'reference' ),
					fieldSelect( __( 'Charge amount', 'shipping-cost-monitor-pro-for-woocommerce' ), 'amount' ),
					fieldSelect( __( 'Currency code', 'shipping-cost-monitor-pro-for-woocommerce' ), 'currency' )
				),
				h( 'p', { className: 'wpe-scm-import-count' }, validRows.length + ' / ' + parsed.rows.length + ' ' + __( 'rows have a valid reference, non-negative amount and three-letter currency (or inferred order currency). Negative rows and rows with a refund status require review and are excluded.', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
				h( 'label', { className: 'wpe-scm-import-field' }, __( 'Show rows', 'shipping-cost-monitor-pro-for-woocommerce' ), h( 'select', { value: rowFilter, onChange: function ( event ) { setRowFilter( event.target.value ); } }, h( 'option', { value: 'all' }, __( 'All preview rows', 'shipping-cost-monitor-pro-for-woocommerce' ) ), h( 'option', { value: 'needs_review' }, __( 'Needs review', 'shipping-cost-monitor-pro-for-woocommerce' ) ), h( 'option', { value: 'ready', }, __( 'Ready to save', 'shipping-cost-monitor-pro-for-woocommerce' ) ), h( 'option', { value: 'saved', }, __( 'Saved', 'shipping-cost-monitor-pro-for-woocommerce' ) ) ) ),
				h( 'div', { className: 'wpe-scm-import-actions' },
					h( 'button', { type: 'button', className: 'button', onClick: matchReferences, disabled: matching || validRows.length < 1 }, matching ? __( 'Matching…', 'shipping-cost-monitor-pro-for-woocommerce' ) : __( 'Match first 50 valid rows', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
					matchedRows.length > 0 ? h( 'button', { type: 'button', className: 'button button-primary', onClick: commitMatchedRows, disabled: committing }, committing ? __( 'Saving…', 'shipping-cost-monitor-pro-for-woocommerce' ) : __( 'Save matched costs to orders', 'shipping-cost-monitor-pro-for-woocommerce' ) ) : null,
					h( 'button', { type: 'button', className: 'button', onClick: clearPreview, disabled: matching || committing }, __( 'Clear preview', 'shipping-cost-monitor-pro-for-woocommerce' ) )
				),
				matchedRows.length > 0 ? h( 'p', { className: 'wpe-scm-import-count' }, __( 'Saving updates only matched orders with no existing cost record. Existing costs are never replaced. After saving, reload the dashboard to refresh report totals.', 'shipping-cost-monitor-pro-for-woocommerce' ) ) : null,
				h(
					'div',
					{ className: 'wpe-scm-import-table-wrap' },
					h( 'table', { className: 'widefat striped wpe-scm-import-table' },
						h( 'thead', null, h( 'tr', null,
							h( 'th', null, __( 'Source row', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
							h( 'th', null, __( 'Reference', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
							h( 'th', null, __( 'Amount', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
							h( 'th', null, __( 'Currency', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
							h( 'th', null, __( 'Validation / match result', 'shipping-cost-monitor-pro-for-woocommerce' ) )
						) ),
						h( 'tbody', null, previewRows.map( function ( item ) {
							const reference = '' !== mapping.reference ? item.values[ Number( mapping.reference ) ] || '' : '';
							const amountRaw = '' !== mapping.amount ? item.values[ Number( mapping.amount ) ] || '' : '';
							const amount = '' !== mapping.amount ? parseInvoiceAmount( amountRaw, decimalMark ) : null;
							const currency = '__order_currency__' === mapping.currency ? __( 'Order currency', 'shipping-cost-monitor-pro-for-woocommerce' ) : ( '' !== mapping.currency ? String( item.values[ Number( mapping.currency ) ] || '' ).trim() : '' );
							const valid = '' !== reference.trim() && null !== amount && '-' !== amount.charAt( 0 ) && ( '__order_currency__' === mapping.currency || /^[A-Za-z]{3}$/.test( currency ) ) && ! hasRefundStatus( item );
							const match = matchResults[ item.number ];
							const commitResult = commitResults[ item.number ];
							const status = hasRefundStatus( item )
								? __( 'Refund status needs review', 'shipping-cost-monitor-pro-for-woocommerce' )
								: commitResult
									? ( 'duplicate_order_in_batch' === commitResult.status
										? __( 'Duplicate order in this invoice batch; none of its rows were saved.', 'shipping-cost-monitor-pro-for-woocommerce' )
										: statusText( commitResult.status ) )
								: match && 'matched' === match.status && match.order_number && '__order_currency__' !== mapping.currency && currency.toUpperCase() !== String( match.currency || '' ).toUpperCase()
									? __( 'Currency differs from order', 'shipping-cost-monitor-pro-for-woocommerce' ) + ' (' + match.currency + ')'
									: match && 'existing_cost' === match.status && match.order_number
										? __( 'Existing cost on order', 'shipping-cost-monitor-pro-for-woocommerce' ) + ' #' + match.order_number
										: match && 'matched' === match.status && match.order_number
											? __( 'Ready to save', 'shipping-cost-monitor-pro-for-woocommerce' ) + ': #' + match.order_number + ' (' + ( match.order_status_label || match.order_status ) + ')'
											: match ? statusText( match.status ) : valid ? __( 'Ready to match', 'shipping-cost-monitor-pro-for-woocommerce' ) : amount && '-' === amount.charAt( 0 ) ? __( 'Credit/refund needs review', 'shipping-cost-monitor-pro-for-woocommerce' ) : __( 'Missing or invalid required value', 'shipping-cost-monitor-pro-for-woocommerce' );
							return h( 'tr', { key: item.number },
								h( 'td', null, item.number ),
								h( 'td', null, reference ),
								h( 'td', null, amountRaw ),
								h( 'td', null, currency ),
								h( 'td', null,
									status,
									match && 'existing_cost' === match.status && match.existing_cost
										? h( 'div', { className: 'wpe-scm-import-review-detail' },
											h( 'strong', null, __( 'Review comparison:', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
											' ' + __( 'Recorded', 'shipping-cost-monitor-pro-for-woocommerce' ) + ': ' + match.existing_cost.currency + ' ' + match.existing_cost.amount + ' (' + evidenceText( match.existing_cost.evidence ) + '; ' + taxText( match.existing_cost.tax_basis ) + '). ',
											__( 'CSV row', 'shipping-cost-monitor-pro-for-woocommerce' ) + ': ' + ( '__order_currency__' === mapping.currency ? match.currency : currency.toUpperCase() ) + ' ' + ( amount || amountRaw ) + '. ',
											__( 'Existing value is kept; review the difference before changing the order.', 'shipping-cost-monitor-pro-for-woocommerce' )
										)
										: null
								)
							);
						} ) )
					)
				)
			) : null
		);
	}

	function CarrierConnections( props ) {
		const useState = wp.element.useState;
		const [ connectionState, setConnectionState ] = useState( function () {
			const adapter = carrierAdapters.find( function ( item ) { return 'shipstation' === item.id; } );
			return adapter ? adapter.state : 'disconnected';
		} );
		const [ apiKey, setApiKey ] = useState( '' );
		const [ busy, setBusy ] = useState( false );
		const [ syncing, setSyncing ] = useState( false );
		const [ message, setMessage ] = useState( '' );
		const [ previewItems, setPreviewItems ] = useState( [] );
		const [ nextCursor, setNextCursor ] = useState( '' );
		const [ syncFrom, setSyncFrom ] = useState( report.period ? report.period.start : '' );
		const [ syncTo, setSyncTo ] = useState( report.period ? report.period.end : '' );
		const stateLabels = {
			connected: __( 'Connected', 'shipping-cost-monitor-pro-for-woocommerce' ),
			disconnected: __( 'Not connected', 'shipping-cost-monitor-pro-for-woocommerce' ),
			reauth_required: __( 'Reconnect required', 'shipping-cost-monitor-pro-for-woocommerce' ),
			unavailable: __( 'Unavailable', 'shipping-cost-monitor-pro-for-woocommerce' ),
		};

		async function requestAction( action, nonce, fields ) {
			const body = new FormData();
			body.append( 'action', action );
			body.append( 'nonce', nonce );
			Object.keys( fields || {} ).forEach( function ( key ) {
				body.append( key, fields[ key ] );
			} );
			const response = await fetch( report.ajax_url, { method: 'POST', credentials: 'same-origin', body: body } );
			const payload = await response.json();
			if ( ! payload || ! payload.success || ! payload.data ) {
				throw new Error( payload && payload.data && payload.data.message ? payload.data.message : __( 'The carrier request failed.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
			}
			return payload.data;
		}

		async function connectShipStation() {
			setBusy( true );
			setMessage( '' );
			try {
				const result = await requestAction( 'wpe_scm_shipstation_connect', report.carrier_nonce, { api_key: apiKey } );
				setConnectionState( result.state );
				setApiKey( '' );
				setMessage( result.message );
			} catch ( requestError ) {
				setMessage( requestError.message || __( 'ShipStation could not be connected.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
			} finally {
				setBusy( false );
			}
		}

		async function disconnectShipStation() {
			setBusy( true );
			setMessage( '' );
			try {
				const result = await requestAction( 'wpe_scm_shipstation_disconnect', report.carrier_nonce, {} );
				setConnectionState( result.state );
				setPreviewItems( [] );
				setNextCursor( '' );
				setMessage( result.message );
			} catch ( requestError ) {
				setMessage( requestError.message || __( 'ShipStation could not be disconnected.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
			} finally {
				setBusy( false );
			}
		}

		async function syncLabels( cursor ) {
			setSyncing( true );
			setMessage( '' );
			try {
				const result = await requestAction(
					'wpe_scm_shipstation_sync',
					report.carrier_sync_nonce,
					{ from: syncFrom, to: syncTo, cursor: cursor || '1' }
				);
				setPreviewItems( Array.isArray( result.items ) ? result.items : [] );
				setNextCursor( result.next_cursor || '' );
				setMessage( __( 'Label evidence loaded as a preview. No WooCommerce orders or costs were changed.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
			} catch ( requestError ) {
				setMessage( requestError.message || __( 'ShipStation labels could not be loaded.', 'shipping-cost-monitor-pro-for-woocommerce' ) );
			} finally {
				setSyncing( false );
			}
		}

		const shipStationControls = 'connected' === connectionState
			? h(
				'div',
				{ className: 'wpe-scm-carrier-controls' },
				h( 'p', { className: 'description' }, __( 'ShipStation label shipment_cost is booked-label evidence, not the carrier’s final invoice. Return and void labels are excluded. Sync is read-only and previews a maximum of 100 labels per page.', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
				h( 'div', { className: 'wpe-scm-carrier-date-fields' },
					h( 'label', null, __( 'From', 'shipping-cost-monitor-pro-for-woocommerce' ), h( 'input', { type: 'date', value: syncFrom, onChange: function ( event ) { setSyncFrom( event.target.value ); } } ) ),
					h( 'label', null, __( 'To', 'shipping-cost-monitor-pro-for-woocommerce' ), h( 'input', { type: 'date', value: syncTo, onChange: function ( event ) { setSyncTo( event.target.value ); } } ) )
				),
				h( 'div', { className: 'wpe-scm-import-actions' },
					h( 'button', { type: 'button', className: 'button button-primary', disabled: syncing || busy, onClick: function () { syncLabels( '1' ); } }, syncing ? __( 'Loading labels…', 'shipping-cost-monitor-pro-for-woocommerce' ) : __( 'Preview ShipStation labels', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
					h( 'button', { type: 'button', className: 'button', disabled: busy || syncing, onClick: disconnectShipStation }, __( 'Disconnect', 'shipping-cost-monitor-pro-for-woocommerce' ) )
				),
				previewItems.length
					? h( 'div', { className: 'wpe-scm-import-table-wrap' },
						h( 'table', { className: 'widefat striped wpe-scm-carrier-table' },
							h( 'thead', null, h( 'tr', null,
								h( 'th', null, __( 'Label', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
								h( 'th', null, __( 'External reference', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
								h( 'th', null, __( 'Tracking ID', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
								h( 'th', null, __( 'Booked cost', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
								h( 'th', null, __( 'Created', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
								h( 'th', null, __( 'Review', 'shipping-cost-monitor-pro-for-woocommerce' ) )
							) ),
							h( 'tbody', null, previewItems.map( function ( item, index ) {
								return h( 'tr', { key: item.label_id || item.provider_shipment_id || index },
									h( 'td', null, item.label_id || item.provider_shipment_id || '—' ),
									h( 'td', null, item.order_reference || '—' ),
									h( 'td', null, item.tracking_id || '—' ),
									h( 'td', null, item.currency + ' ' + item.amount ),
									h( 'td', null, item.occurred_at || '—' ),
									h( 'td', null, item.refund_status ? __( 'Refund status: ', 'shipping-cost-monitor-pro-for-woocommerce' ) + item.refund_status : __( 'Booked label; verify invoice', 'shipping-cost-monitor-pro-for-woocommerce' ) )
								);
							} ) )
						)
					)
					: null,
				nextCursor ? h( 'button', { type: 'button', className: 'button', disabled: syncing, onClick: function () { syncLabels( nextCursor ); } }, __( 'Load next page', 'shipping-cost-monitor-pro-for-woocommerce' ) ) : null,
				previewItems.length && props.onReviewLabels ? h( 'button', { type: 'button', className: 'button button-primary', onClick: function () { props.onReviewLabels( previewItems ); } }, __( 'Review and match these labels', 'shipping-cost-monitor-pro-for-woocommerce' ) ) : null
			)
			: h( 'div', { className: 'wpe-scm-carrier-controls' },
				h( 'p', { className: 'description' }, __( 'ShipStation V2 API key. It is tested before saving and stored encrypted with site salts; it is never returned to the browser.', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
				h( 'label', { className: 'wpe-scm-carrier-key-label' }, __( 'API key', 'shipping-cost-monitor-pro-for-woocommerce' ),
					h( 'input', { type: 'password', autoComplete: 'new-password', value: apiKey, onChange: function ( event ) { setApiKey( event.target.value ); }, maxLength: 512 } )
				),
				h( 'p', { className: 'description wpe-scm-api-help' },
					__( 'Where to get it: in ShipStation open Settings → Account → API Settings, choose V2 API, then Generate API Key. The key is shown once.', 'shipping-cost-monitor-pro-for-woocommerce' ),
					' ',
					h( 'a', { href: 'https://help.shipstation.com/hc/articles/360025856212', target: '_blank', rel: 'noopener noreferrer' }, __( 'ShipStation guide: generate an API key', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
					' · ',
					h( 'a', { href: 'https://docs.shipstation.com/authentication', target: '_blank', rel: 'noopener noreferrer' }, __( 'ShipStation API V2 authentication', 'shipping-cost-monitor-pro-for-woocommerce' ) )
				),
				h( 'button', { type: 'button', className: 'button button-primary', disabled: busy || apiKey.trim().length < 12, onClick: connectShipStation }, busy ? __( 'Testing connection…', 'shipping-cost-monitor-pro-for-woocommerce' ) : __( 'Test and connect', 'shipping-cost-monitor-pro-for-woocommerce' ) )
			);

		return h(
			'section',
			{ className: 'wpe-scm-card wpe-scm-carrier-connections' },
			h( 'p', { className: 'wpe-scm-eyebrow' }, __( 'OPTIONAL CARRIER DATA', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
			h( 'h2', null, __( 'Carrier connections', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
			h( 'p', null, __( 'Connect a supported shipping platform to preview booked shipment costs. API evidence never changes checkout rates or order totals automatically.', 'shipping-cost-monitor-pro-for-woocommerce' ) ),
			h( 'div', { className: 'wpe-scm-carrier-provider' },
				h( 'div', { className: 'wpe-scm-carrier-provider-heading' },
					h( 'strong', null, 'ShipStation V2' ),
					h( 'span', { className: 'wpe-scm-status-pill' }, stateLabels[ connectionState ] || stateLabels.unavailable )
				),
				shipStationControls
			),
			message ? h( 'p', { className: 'wpe-scm-report-notice', role: 'status' }, message ) : null,
			carrierAdapters.filter( function ( adapter ) { return 'shipstation' !== adapter.id; } ).map( function ( adapter ) {
				return h( 'p', { key: adapter.id, className: 'wpe-scm-import-count' }, adapter.label + ': ' + ( stateLabels[ adapter.state ] || stateLabels.unavailable ) );
			} )
		);
	}

	window.wpeScmPro = Object.assign( window.wpeScmPro || {}, { InvoicePanel: CsvInvoicePreview } );
} )( window.wp );
