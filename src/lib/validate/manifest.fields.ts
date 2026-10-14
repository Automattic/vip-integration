/**
 * Checks on `runtime_config.fields` that a JSON Schema can't express: that a
 * field's `default` and `example` follow the field's own rules, that `min` /
 * `max` and the length bounds are in order, and that a `pattern` compiles.
 *
 * They run only after the manifest passes `MANIFEST_SCHEMA`, so every field
 * already has the right shape (a `min` is a number and only sits on a number
 * field). The value checks mirror what VIP enforces on the values a customer
 * saves, so a default or placeholder VIP would reject fails here first.
 */

import { isIP } from 'node:net';

/** The validation rules of a config field, or of a list field's entries. */
interface ValueRules {
	type: string;
	integer?: boolean;
	min?: number;
	max?: number;
	min_length?: number;
	max_length?: number;
	pattern?: string;
	format?: string;
	values?: string[];
	items?: ValueRules;
	max_items?: number;
}

interface ConfigField extends ValueRules {
	default?: unknown;
	example?: unknown;
}

// Same email and URL rules as the VIP Dashboard's config form, so a value that
// passes here passes there too.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isHttpUrl( value: string ): boolean {
	try {
		const { protocol } = new URL( value );
		return protocol === 'http:' || protocol === 'https:';
	} catch {
		return false;
	}
}

/** An IPv4 or IPv6 address, optionally with a CIDR prefix (`192.0.2.0/24`). */
function isIpOrCidr( value: string ): boolean {
	const [ address, prefix, ...rest ] = value.split( '/' );
	const version = isIP( address );
	if ( version === 0 || rest.length > 0 ) {
		return false;
	}
	if ( prefix === undefined ) {
		return true;
	}
	return /^\d{1,3}$/.test( prefix ) && Number( prefix ) <= ( version === 4 ? 32 : 128 );
}

const FORMATS: Record< string, { test: ( value: string ) => boolean; noun: string } > = {
	ip_or_cidr: { test: isIpOrCidr, noun: 'an IP address or CIDR range' },
	url: { test: isHttpUrl, noun: 'an http(s) URL' },
	email: { test: value => EMAIL_PATTERN.test( value ), noun: 'an email address' },
};

/**
 * Compile a field's `pattern` to match the whole value, or return why it
 * doesn't compile. Uses the `v` flag, like a browser does for an input's
 * `pattern` attribute, so a pattern that compiles here works in the form too.
 */
function compilePattern( pattern: string ): RegExp | string {
	// The pattern comes from the partner's own manifest and only runs against
	// their own default and example values.
	const source = `^(?:${ pattern })$`;
	try {
		// eslint-disable-next-line security/detect-non-literal-regexp
		new RegExp( pattern, 'v' );
		// eslint-disable-next-line security/detect-non-literal-regexp
		return new RegExp( source, 'v' );
	} catch ( error ) {
		try {
			// eslint-disable-next-line security/detect-non-literal-regexp
			new RegExp( pattern, 'u' );
		} catch {
			return error instanceof Error ? error.message.replace( /^.*: /, '' ) : String( error );
		}
		// Most often an unescaped `-` in a class, as in `[a-z0-9-]`.
		return 'inside [...], escape - ( ) [ ] { } / | with a backslash, e.g. [a-z0-9\\-]';
	}
}

/** Problems with the rules themselves: bounds out of order, a pattern that doesn't compile. */
function ruleIssues( rules: ValueRules, where: string ): string[] {
	const issues: string[] = [];
	const bounds = [
		[ 'min', 'max' ],
		[ 'min_length', 'max_length' ],
	] as const;
	for ( const [ low, high ] of bounds ) {
		const lowValue = rules[ low ];
		const highValue = rules[ high ];
		if ( lowValue !== undefined && highValue !== undefined && lowValue > highValue ) {
			issues.push(
				`${ where } has "${ low }" (${ lowValue }) greater than "${ high }" (${ highValue }).`
			);
		}
	}
	if ( rules.pattern !== undefined ) {
		const compiled = compilePattern( rules.pattern );
		if ( typeof compiled === 'string' ) {
			issues.push( `${ where }.pattern is not a valid regular expression (${ compiled }).` );
		}
	}
	return issues;
}

function numberIssue( rules: ValueRules, value: unknown ): string | null {
	if ( typeof value !== 'number' || ! Number.isFinite( value ) ) {
		return 'must be a number';
	}
	if ( rules.integer && ! Number.isInteger( value ) ) {
		return 'must be a whole number';
	}
	if ( rules.min !== undefined && value < rules.min ) {
		return `is less than "min" (${ rules.min })`;
	}
	if ( rules.max !== undefined && value > rules.max ) {
		return `is more than "max" (${ rules.max })`;
	}
	return null;
}

function stringIssue( rules: ValueRules, value: unknown ): string | null {
	if ( typeof value !== 'string' ) {
		return 'must be a string';
	}
	if ( rules.min_length !== undefined && value.length < rules.min_length ) {
		return `is shorter than "min_length" (${ rules.min_length })`;
	}
	if ( rules.max_length !== undefined && value.length > rules.max_length ) {
		return `is longer than "max_length" (${ rules.max_length })`;
	}
	// A `url` or `email` field carries its format in the type.
	const format = FORMATS[ rules.format ?? rules.type ];
	if ( format && ! format.test( value ) ) {
		return `must be ${ format.noun }`;
	}
	if ( rules.pattern !== undefined ) {
		const compiled = compilePattern( rules.pattern );
		// An invalid pattern is already reported by ruleIssues.
		if ( compiled instanceof RegExp && ! compiled.test( value ) ) {
			return 'doesn\'t match "pattern"';
		}
	}
	return null;
}

/** Messages for each way `value` breaks the rules, located at `where`. */
function valueIssues( rules: ValueRules, value: unknown, where: string ): string[] {
	if ( rules.type === 'list' ) {
		if ( ! Array.isArray( value ) ) {
			return [ `${ where } must be a list.` ];
		}
		const issues: string[] = [];
		if ( rules.max_items !== undefined && value.length > rules.max_items ) {
			issues.push( `${ where } has more than "max_items" (${ rules.max_items }) entries.` );
		}
		if ( rules.items ) {
			for ( const [ index, entry ] of value.entries() ) {
				issues.push( ...valueIssues( rules.items, entry, `${ where }.${ index }` ) );
			}
		}
		return issues;
	}

	const issue = singleValueIssue( rules, value );
	return issue ? [ `${ where } ${ issue }.` ] : [];
}

/** Why a single (non-list) value breaks the rules, or null when it follows them. */
function singleValueIssue( rules: ValueRules, value: unknown ): string | null {
	switch ( rules.type ) {
		case 'number':
			return numberIssue( rules, value );
		case 'boolean':
			return typeof value === 'boolean' ? null : 'must be true or false';
		case 'enum':
			return typeof value === 'string' && rules.values?.includes( value )
				? null
				: `must be one of: ${ ( rules.values ?? [] ).join( ', ' ) }`;
		default:
			// Every other type the schema allows holds a string.
			return stringIssue( rules, value );
	}
}

/**
 * Rule problems across the manifest's `runtime_config.fields`. Expects a
 * manifest that already passed the schema.
 */
export function fieldRuleIssues( manifest: Record< string, unknown > ): string[] {
	const { fields } = manifest.runtime_config as { fields: ConfigField[] };
	return fields.flatMap( ( field, index ) => {
		const where = `runtime_config.fields.${ index }`;
		const issues = ruleIssues( field, where );
		if ( field.items ) {
			issues.push( ...ruleIssues( field.items, `${ where }.items` ) );
		}
		for ( const key of [ 'default', 'example' ] as const ) {
			if ( field[ key ] !== undefined ) {
				issues.push( ...valueIssues( field, field[ key ], `${ where }.${ key }` ) );
			}
		}
		return issues;
	} );
}
