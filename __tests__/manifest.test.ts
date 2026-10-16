import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dump } from 'js-yaml';
import { tmpdir } from 'os';
import { join } from 'path';

import { inspectManifest } from '../src/lib/validate/manifest';
import { derivedConfigConstant, manifestJsonSchema } from '../src/lib/validate/manifest.schema';

type Field = Record< string, unknown >;

/** A complete manifest whose only config fields are `fields`. */
function manifestWith( fields: Field[] ): Record< string, unknown > {
	return {
		manifest_version: 2,
		manifest_kind: 'vip-integration-handoff',
		integration: {
			slug: 'acme-widget',
			display_name: 'Acme Widget',
			summary: 'Example integration used in tests.',
			partner: { name: 'Acme', support_contact: 'support@acme.example' },
		},
		documentation: { public_url: 'https://acme.example/docs/widget' },
		runtime: {
			wordpress_plugin: {
				folder: 'acme-widget',
				entry_file: 'acme-widget.php',
				php_namespace: 'Acme\\Widget',
				scope: 'site',
			},
		},
		runtime_config: { fields },
		release: {
			plugin_version: '1.0.0',
			version_strategy: 'latest',
			migration_required: false,
			changelog: 'Initial release.',
		},
	};
}

// Share a Draft's fields, as its hand-written GOOP validation would declare them.
const GRACE_PERIOD: Field = {
	key: 'dead_link_grace_period',
	label: 'Expired link retention',
	type: 'number',
	integer: true,
	min: 1,
	unit: 'seconds',
	nullable: true,
	default: 1814400,
	example: 1814400,
};
const IP_ALLOWLIST: Field = {
	key: 'ip_allowlist',
	label: 'Trusted IP ranges',
	type: 'list',
	items: { type: 'string', format: 'ip_or_cidr' },
	nullable: true,
	example: [ '192.0.2.0/24', '2001:db8::/32' ],
};

describe( 'manifest field rules', () => {
	let dir: string;

	beforeAll( () => {
		dir = mkdtempSync( join( tmpdir(), 'vip-manifest-' ) );
	} );

	afterAll( () => {
		rmSync( dir, { recursive: true, force: true } );
	} );

	function errorsFor( field: Field ): string[] {
		writeFileSync( join( dir, 'vip-manifest.yaml' ), dump( manifestWith( [ field ] ) ) );
		return inspectManifest( dir ).errors;
	}

	it.each< [ string, Field ] >( [
		[ 'Share a Draft grace period', GRACE_PERIOD ],
		[ 'Share a Draft IP allowlist', IP_ALLOWLIST ],
		[
			'string with lengths, pattern and example',
			{
				key: 'site_id',
				label: 'Site ID',
				type: 'string',
				min_length: 3,
				max_length: 20,
				pattern: '[a-z0-9\\-]+',
				example: 'acme-prod',
				default: 'acme',
			},
		],
		[
			'string with a url format',
			{ key: 'a', label: 'A', type: 'string', format: 'url', default: 'https://acme.example' },
		],
		[
			'string with an email format',
			{ key: 'a', label: 'A', type: 'string', format: 'email', example: 'ops@acme.example' },
		],
		...[
			[ 'string', 'ip_or_cidr', '192.0.2.0/24' ],
			[ 'text', 'ip_or_cidr', '192.0.2.0/24' ],
			[ 'secret', 'ip_or_cidr', '192.0.2.0/24' ],
			[ 'url', 'url', 'https://acme.example' ],
			[ 'email', 'email', 'ops@acme.example' ],
		].map( ( [ type, format, example ] ): [ string, Field ] => [
			`${ type } with an explicit ${ format } format`,
			{ key: 'a', label: 'A', type, format, example },
		] ),
		...[
			[ 'url', 'email' ],
			[ 'email', 'url' ],
		].map( ( [ type, format ] ): [ string, Field ] => [
			`${ type } satisfying both its type and ${ format } format`,
			{
				key: 'a',
				label: 'A',
				type,
				format,
				default: 'https://ops@acme.example',
				example: 'https://ops@acme.example',
			},
		] ),
		[
			'secret with a pattern',
			{ key: 'a', label: 'A', type: 'secret', pattern: 'sk_[a-z0-9]+', example: 'sk_123' },
		],
		[ 'number with max', { key: 'a', label: 'A', type: 'number', max: 10, default: 10 } ],
		[
			'list with max_items and an item pattern',
			{
				key: 'a',
				label: 'A',
				type: 'list',
				items: { type: 'string', pattern: '[a-z]+', max_length: 10 },
				max_items: 2,
				example: [ 'one', 'two' ],
			},
		],
		[
			'IPv4 and IPv6 addresses with and without a prefix',
			{
				...IP_ALLOWLIST,
				default: [ '10.0.0.1', '10.0.0.0/8', '::1', '2001:db8::/128', '0.0.0.0/0' ],
			},
		],
		[
			'optional field with nullable false',
			{ key: 'a', label: 'A', type: 'text', nullable: false },
		],
		[
			'required field with nullable false',
			{ key: 'a', label: 'A', type: 'url', required: true, nullable: false },
		],
		...[ true, false ].map( ( example ): [ string, Field ] => [
			`boolean example ${ example }`,
			{ key: 'a', label: 'A', type: 'boolean', example },
		] ),
		[
			'enum example from its values',
			{ key: 'a', label: 'A', type: 'enum', values: [ 'x', 'y' ], example: 'x' },
		],
		[
			'enum default from its values',
			{ key: 'a', label: 'A', type: 'enum', values: [ 'x', 'y' ], default: 'y' },
		],
	] )( 'accepts %s', ( _name, field ) => {
		expect( errorsFor( field ) ).toEqual( [] );
	} );

	it.each< [ string, Field, RegExp ] >( [
		// Which keys apply to which type.
		[
			'integer on a string',
			{ key: 'a', label: 'A', type: 'string', integer: true },
			/fields\.0: "integer" only applies to type "number"\./,
		],
		[
			'min on a string',
			{ key: 'a', label: 'A', type: 'string', min: 1 },
			/"min" only applies to type "number"/,
		],
		[
			'max on text',
			{ key: 'a', label: 'A', type: 'text', max: 1 },
			/"max" only applies to type "number"/,
		],
		[
			'unit on a string',
			{ key: 'a', label: 'A', type: 'string', unit: 'seconds' },
			/"unit" only applies to type "number"/,
		],
		[
			'min_length on a number',
			{ key: 'a', label: 'A', type: 'number', min_length: 1 },
			/"min_length" only applies to type "string", "text", "url", "email", "secret"/,
		],
		[
			'max_length on a boolean',
			{ key: 'a', label: 'A', type: 'boolean', max_length: 1 },
			/"max_length" only applies/,
		],
		[
			'pattern on an enum',
			{ key: 'a', label: 'A', type: 'enum', values: [ 'x' ], pattern: 'x', example: 'x' },
			/"pattern" only applies/,
		],
		[
			'format on a number field',
			{ key: 'a', label: 'A', type: 'number', format: 'url' },
			/"format" only applies to type "string", "text", "url", "email", "secret"\./,
		],
		[
			'items on a string',
			{ key: 'a', label: 'A', type: 'string', items: { type: 'string' } },
			/"items" only applies to type "list"/,
		],
		[
			'max_items on text',
			{ key: 'a', label: 'A', type: 'text', max_items: 1 },
			/"max_items" only applies to type "list"/,
		],
		[
			'example on a boolean',
			{ key: 'a', label: 'A', type: 'boolean', example: 'yes' },
			/example must be true or false/,
		],
		[
			'an enum example outside its values',
			{ key: 'a', label: 'A', type: 'enum', values: [ 'x' ], example: 'y' },
			/example must be one of: x/,
		],
		// Values the keys themselves take.
		[
			'an unknown unit',
			{ key: 'a', label: 'A', type: 'number', unit: 'weeks' },
			/unit must be one of: seconds, minutes, hours, days/,
		],
		[
			'an unknown format',
			{ key: 'a', label: 'A', type: 'string', format: 'ipv4' },
			/format must be one of: ip_or_cidr, url, email/,
		],
		[
			'integer that is not a boolean',
			{ key: 'a', label: 'A', type: 'number', integer: 'yes' },
			/integer must be boolean/,
		],
		[
			'a negative min_length',
			{ key: 'a', label: 'A', type: 'string', min_length: -1 },
			/min_length must be >= 0/,
		],
		[
			'a max_length of zero',
			{ key: 'a', label: 'A', type: 'string', max_length: 0 },
			/max_length must be >= 1/,
		],
		[
			'a max_items of zero',
			{ key: 'a', label: 'A', type: 'list', items: { type: 'string' }, max_items: 0 },
			/max_items must be >= 1/,
		],
		[
			'nullable that is not a boolean',
			{ key: 'a', label: 'A', type: 'string', nullable: 'yes' },
			/nullable must be boolean/,
		],
		[
			'a field without a type, with only that error',
			{ key: 'a', label: 'A' },
			/^runtime_config\.fields\.0 is missing required field "type"\.$/,
		],
		// Rules between keys.
		[
			'a list without items',
			{ key: 'a', label: 'A', type: 'list' },
			/fields\.0: A list field needs "items"\./,
		],
		[
			'a list item type other than string',
			{ key: 'a', label: 'A', type: 'list', items: { type: 'number' } },
			/items\.type must be one of: string/,
		],
		[
			'an unknown key on a list item',
			{ key: 'a', label: 'A', type: 'list', items: { type: 'string', min: 1 } },
			/items has unknown field "min"/,
		],
		[
			'a pattern without an example',
			{ key: 'a', label: 'A', type: 'string', pattern: '[a-z]+' },
			/needs an "example"/,
		],
		[
			'a list item pattern without an example',
			{ key: 'a', label: 'A', type: 'list', items: { type: 'string', pattern: '[a-z]+' } },
			/needs an "example"/,
		],
		[
			'a required nullable field',
			{ key: 'a', label: 'A', type: 'string', required: true, nullable: true },
			/fields\.0: A required field can't be nullable/,
		],
		[
			'min greater than max',
			{ key: 'a', label: 'A', type: 'number', min: 5, max: 1 },
			/fields\.0 has "min" \(5\) greater than "max" \(1\)\./,
		],
		[
			'min_length greater than max_length',
			{ key: 'a', label: 'A', type: 'text', min_length: 5, max_length: 1 },
			/has "min_length" \(5\) greater than "max_length" \(1\)/,
		],
		[
			'item min_length greater than max_length',
			{
				key: 'a',
				label: 'A',
				type: 'list',
				items: { type: 'string', min_length: 5, max_length: 1 },
			},
			/fields\.0\.items has "min_length" \(5\) greater than "max_length" \(1\)/,
		],
		[
			'a pattern that does not compile',
			{ key: 'a', label: 'A', type: 'string', pattern: '([a-z]', example: 'a' },
			/fields\.0\.pattern is not a valid regular expression/,
		],
		[
			'an invalid pattern concealed by whole-value wrapping',
			{ key: 'a', label: 'A', type: 'string', pattern: '[a-z]+)|(?:[0-9]+', example: 'abc!!!' },
			/fields\.0\.pattern is not a valid regular expression/,
		],
		[
			'an invalid list item pattern concealed by whole-value wrapping',
			{
				key: 'a',
				label: 'A',
				type: 'list',
				items: { type: 'string', pattern: '[a-z]+)|(?:[0-9]+' },
				example: [ 'abc!!!' ],
			},
			/fields\.0\.items\.pattern is not a valid regular expression/,
		],
		[
			// Valid without the `v` flag, but a browser would ignore it as an input's `pattern`.
			'a pattern that only compiles without the v flag',
			{ key: 'a', label: 'A', type: 'string', pattern: '[a-z0-9-]+', example: 'a' },
			/pattern is not a valid regular expression \(inside \[\.\.\.\], escape - /,
		],
		// Default and example values against the field's own rules.
		[
			'a string default on a number',
			{ key: 'a', label: 'A', type: 'number', default: '10' },
			/fields\.0\.default must be a number\./,
		],
		[
			'a fractional default on an integer',
			{ key: 'a', label: 'A', type: 'number', integer: true, default: 1.5 },
			/default must be a whole number/,
		],
		[ 'a default below min', { ...GRACE_PERIOD, default: 0 }, /default is less than "min" \(1\)/ ],
		[
			'an example above max',
			{ key: 'a', label: 'A', type: 'number', max: 10, example: 11 },
			/example is more than "max" \(10\)/,
		],
		[
			'a number default on a string',
			{ key: 'a', label: 'A', type: 'string', default: 1 },
			/default must be a string/,
		],
		[
			'a default shorter than min_length',
			{ key: 'a', label: 'A', type: 'string', min_length: 3, default: 'ab' },
			/default is shorter than "min_length" \(3\)/,
		],
		[
			'an example longer than max_length',
			{ key: 'a', label: 'A', type: 'text', max_length: 3, example: 'abcd' },
			/example is longer than "max_length" \(3\)/,
		],
		[
			'an example that does not match the pattern',
			{ key: 'a', label: 'A', type: 'string', pattern: '[a-z]+', example: 'acme-1' },
			/example doesn't match "pattern"/,
		],
		[
			'a default that does not match the url format',
			{ key: 'a', label: 'A', type: 'string', format: 'url', default: 'acme.example' },
			/default must be an http\(s\) URL/,
		],
		[
			'an invalid IP example on text',
			{ key: 'a', label: 'A', type: 'text', format: 'ip_or_cidr', example: 'acme.example' },
			/example must be an IP address or CIDR range/,
		],
		...[
			[ 'url', 'email', 'ops@acme.example', 'an http(s) URL' ],
			[ 'email', 'url', 'https://acme.example', 'an email address' ],
			[ 'url', 'email', 'https://acme.example', 'an email address' ],
			[ 'email', 'url', 'ops@acme.example', 'an http(s) URL' ],
		].flatMap( ( [ type, format, value, expected ] ) =>
			[ 'default', 'example' ].map( ( key ): [ string, Field, RegExp ] => [
				`${ key } on ${ type } with ${ format } format that is not ${ expected }`,
				{ key: 'a', label: 'A', type, format, [ key ]: value },
				expected === 'an email address' ? /must be an email address/ : /must be an http\(s\) URL/,
			] )
		),
		[
			'a non-http default on a url field',
			{ key: 'a', label: 'A', type: 'url', default: 'ftp://acme.example' },
			/default must be an http\(s\) URL/,
		],
		[
			'an invalid example on an email field',
			{ key: 'a', label: 'A', type: 'email', example: 'acme.example' },
			/example must be an email address/,
		],
		[
			'a boolean default that is not true or false',
			{ key: 'a', label: 'A', type: 'boolean', default: 'yes' },
			/default must be true or false/,
		],
		[
			'an enum default outside its values',
			{ key: 'a', label: 'A', type: 'enum', values: [ 'x', 'y' ], default: 'z' },
			/default must be one of: x, y/,
		],
		[
			'a list default that is not a list',
			{ ...IP_ALLOWLIST, default: '192.0.2.0/24' },
			/default must be a list/,
		],
		[
			'a list example over max_items',
			{ ...IP_ALLOWLIST, max_items: 1 },
			/example has more than "max_items" \(1\) entries/,
		],
		...[
			'10.0.0.0/33',
			'2001:db8::/129',
			'999.0.0.1',
			'acme.example',
			'10.0.0.0/8/1',
			'10.0.0.0/',
		].map( ( entry ): [ string, Field, RegExp ] => [
			`${ entry } as an ip_or_cidr entry`,
			{ ...IP_ALLOWLIST, example: [ '192.0.2.0/24', entry ] },
			/fields\.0\.example\.1 must be an IP address or CIDR range\./,
		] ),
	] )( 'rejects %s', ( _name, field, expected ) => {
		const errors = errorsFor( field );
		expect( errors.join( '\n' ) ).toMatch( expected );
		// One message per broken rule, never Ajv's bare `must match "then" schema`.
		expect( errors.join( '\n' ) ).not.toMatch( /must match "then" schema/ );
	} );
} );

describe( 'manifestJsonSchema', () => {
	it( 'matches docs/vip-manifest.schema.json (run `pnpm schema` if not)', () => {
		const committed: unknown = JSON.parse(
			readFileSync( join( __dirname, '..', 'docs', 'vip-manifest.schema.json' ), 'utf8' )
		);
		expect( committed ).toEqual( manifestJsonSchema() );
	} );
} );

describe( 'derivedConfigConstant', () => {
	it( 'derives VIP_<SLUG>_CONFIG from the slug', () => {
		expect( derivedConfigConstant( 'shareadraft' ) ).toBe( 'VIP_SHAREADRAFT_CONFIG' );
		expect( derivedConfigConstant( 'content-for-agents' ) ).toBe( 'VIP_CONTENT_FOR_AGENTS_CONFIG' );
		expect( derivedConfigConstant( 'acme-widget' ) ).toBe( 'VIP_ACME_WIDGET_CONFIG' );
	} );

	it( 'strips characters outside [A-Za-z0-9_-] so the result is always a regex-safe identifier', () => {
		// Regression guard: a hostile slug used to reach the defined() RegExp
		// construction verbatim (see the config guard in validate.ts). An
		// all-hostile slug degrades to the empty identifier, which the schema
		// already rejects upstream (slug minLength 3).
		expect( derivedConfigConstant( '[' ) ).toBe( 'VIP__CONFIG' );
		expect( derivedConfigConstant( 'a[b' ) ).toBe( 'VIP_AB_CONFIG' );
		expect( derivedConfigConstant( 'a(b)c$d' ) ).toBe( 'VIP_ABCD_CONFIG' );
		for ( const hostile of [
			'a]b',
			'a.b',
			'a*b',
			'a+b',
			'a?b',
			'a\\b',
			'a$b',
			'a^b',
			'a|b',
			'a/b',
			'a b',
		] ) {
			const constant = derivedConfigConstant( hostile );
			expect( constant ).toMatch( /^VIP_[A-Z0-9_]+_CONFIG$/ );
			expect(
				// eslint-disable-next-line security/detect-non-literal-regexp
				() => new RegExp( String.raw`defined\s*\(\s*(self::CONSTANT_NAME|'${ constant }')` )
			).not.toThrow();
		}
	} );
} );

describe( 'constant_name deprecation window', () => {
	let dir: string;

	beforeAll( () => {
		dir = mkdtempSync( join( tmpdir(), 'vip-manifest-constant-' ) );
	} );

	afterAll( () => {
		rmSync( dir, { recursive: true, force: true } );
	} );

	const FIELD: Field = { key: 'api_base_url', label: 'API base URL', type: 'url' };

	function inspect( manifest: Record< string, unknown > ) {
		writeFileSync( join( dir, 'vip-manifest.yaml' ), dump( manifest ) );
		return inspectManifest( dir );
	}

	it( 'accepts a v1 constant_name equal to the derived name, with a warning', () => {
		const inspection = inspect( {
			...manifestWith( [] ),
			manifest_version: 1,
			runtime_config: { constant_name: 'VIP_ACME_WIDGET_CONFIG', fields: [ FIELD ] },
		} );
		expect( inspection.errors ).toEqual( [] );
		expect( inspection.warnings ).toHaveLength( 1 );
		expect( inspection.warnings[ 0 ] ).toMatch( /deprecated.*VIP_ACME_WIDGET_CONFIG/s );
	} );

	it( 'fails a v1 constant_name that differs from the derived name', () => {
		const inspection = inspect( {
			...manifestWith( [] ),
			manifest_version: 1,
			runtime_config: { constant_name: 'VIP_ACME_CONFIG', fields: [ FIELD ] },
		} );
		expect( inspection.errors ).toHaveLength( 1 );
		expect( inspection.errors[ 0 ] ).toMatch( /"VIP_ACME_CONFIG".*VIP_ACME_WIDGET_CONFIG/ );
		expect( inspection.warnings ).toEqual( [] );
	} );

	it( 'rejects a v2 manifest that still declares constant_name', () => {
		const inspection = inspect( {
			...manifestWith( [] ),
			runtime_config: { constant_name: 'VIP_ACME_WIDGET_CONFIG', fields: [ FIELD ] },
		} );
		expect( inspection.errors.join( '\n' ) ).toMatch( /constant_name.*version 1/i );
	} );
} );
