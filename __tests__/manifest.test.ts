import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dump } from 'js-yaml';
import { tmpdir } from 'os';
import { join } from 'path';

import { inspectManifest } from '../src/lib/validate/manifest';
import { manifestJsonSchema } from '../src/lib/validate/manifest.schema';

type Field = Record< string, unknown >;

/** A complete manifest whose only config fields are `fields`. */
function manifestWith( fields: Field[] ): Record< string, unknown > {
	return {
		manifest_version: 1,
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
		runtime_config: { constant_name: 'VIP_ACME_WIDGET_CONFIG', fields },
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
		[
			'required field with nullable true',
			{ key: 'a', label: 'A', type: 'string', required: true, nullable: true },
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
