import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { looksLikeIntegration, validateIntegration } from '../src/lib/validate/validate';
import { REQUIRED_PHP_VERSIONS, REQUIRED_WP_VERSIONS } from '../src/lib/validate/wp-baseline';

import type { CheckStatus } from '../src/lib/validate/validate';

const [ CURRENT_WP, PREVIOUS_WP ] = REQUIRED_WP_VERSIONS;
const [ PHP_LOW, PHP_MID_A, PHP_MID_B, PHP_HIGH ] = REQUIRED_PHP_VERSIONS;

/** A complete handoff manifest matching the conformant fixture's names. */
function conformantManifest(): string {
	return [
		'manifest_version: 1',
		'manifest_kind: vip-integration-handoff',
		'integration:',
		'  slug: acme-widget',
		'  display_name: Acme Widget',
		'  summary: Example integration used in tests.',
		'  partner:',
		'    name: Acme',
		'    support_contact: support@acme.example',
		'documentation:',
		'  public_url: https://acme.example/docs/widget',
		'  support_url: https://acme.example/docs/widget/support',
		'runtime:',
		'  wordpress_plugin:',
		'    folder: acme-widget',
		'    entry_file: acme-widget.php',
		"    php_namespace: 'Acme\\Widget'",
		'    scope: site',
		'runtime_config:',
		'  constant_name: VIP_ACME_WIDGET_CONFIG',
		'  fields:',
		'    - key: api_base_url',
		'      label: API base URL',
		'      type: url',
		'      required: true',
		'    - key: sync_mode',
		'      label: Sync mode',
		'      type: enum',
		'      required: true',
		'      values:',
		'        - export',
		'        - import',
		'telemetry:',
		'  prefix: acme_widget_',
		'  default_properties:',
		'    - plugin_version',
		'  events:',
		'    - name: acme_widget_sync_started',
		'      type: tracks',
		'      trigger: A sync starts.',
		'      properties:',
		'        - trigger',
		'release:',
		'  plugin_version: 1.0.0',
		'  version_strategy: latest',
		'  migration_required: false',
		'  changelog: Initial release.',
	].join( '\n' );
}

/** Write a minimal but fully conformant integration into `root`. */
function scaffoldConformant( root: string ): void {
	mkdirSync( join( root, 'docs' ), { recursive: true } );
	mkdirSync( join( root, 'inc' ), { recursive: true } );
	mkdirSync( join( root, '.github', 'workflows' ), { recursive: true } );

	writeFileSync(
		join( root, 'composer.json' ),
		JSON.stringify( {
			name: 'acme/widget',
			type: 'wordpress-plugin',
			autoload: { classmap: [ 'inc/' ] },
			scripts: {
				test: [ '@test:unit', '@test:e2e' ],
				'test:unit': 'phpunit',
				'test:e2e': 'npm test',
				'validate-integration': '@php bin/validate-integration.php',
			},
		} )
	);

	writeFileSync(
		join( root, 'package.json' ),
		JSON.stringify( { name: 'e2e', scripts: { test: 'playwright test', build: 'echo none' } } )
	);

	writeFileSync(
		join( root, 'acme-widget.php' ),
		`<?php\n/**\n * Plugin Name: Acme Widget\n */\nrequire_once __DIR__ . '/vendor/autoload.php';\n`
	);

	writeFileSync( join( root, 'vip-manifest.yaml' ), conformantManifest() );

	writeFileSync(
		join( root, 'inc', 'class-config.php' ),
		`<?php\nfinal class Config {\n\tpublic const CONSTANT_NAME = 'VIP_ACME_WIDGET_CONFIG';\n\tpublic function __construct( $raw ) { if ( is_array( $raw ) ) {} }\n\tpublic function is_ready(): bool { return true; }\n\tpublic function missing_fields(): array { return []; }\n\tpublic function is_available(): bool { return defined( self::CONSTANT_NAME ); }\n}\n`
	);

	writeFileSync(
		join( root, 'inc', 'class-telemetry.php' ),
		`<?php\nfinal class Telemetry {\n\tprivate function __construct() {\n\t\tif ( class_exists( \\Automattic\\VIP\\Telemetry\\Telemetry::class ) ) {}\n\t}\n\tpublic function record_event( string $name, array $props = [] ): void {}\n}\n`
	);

	writeFileSync(
		join( root, 'docs', 'integration.md' ),
		[
			'# Integration',
			'',
			'## Build and test',
			'Run `composer install` and `npm ci`, then `composer test`. `npm run build` ships no assets.',
			'',
			'## Runtime config',
			'Config constant: `VIP_ACME_WIDGET_CONFIG`.',
			'',
			'Valid config:',
			'```php',
			"define( 'VIP_ACME_WIDGET_CONFIG', [ 'api_base_url' => 'x', 'api_token' => 'y' ] );",
			'```',
			'',
			'Incomplete config (a required value is missing):',
			'```php',
			"define( 'VIP_ACME_WIDGET_CONFIG', [ 'api_base_url' => 'x' ] );",
			'```',
		].join( '\n' )
	);

	writeFileSync(
		join( root, '.github', 'workflows', 'unit-tests.yml' ),
		[
			'jobs:',
			'  test:',
			'    strategy:',
			'      matrix:',
			'        config:',
			`          - { wp: ${ PREVIOUS_WP }.x, php: '${ PHP_LOW }' }`,
			`          - { wp: latest, php: '${ PHP_MID_A }' }`,
			`          - { wp: latest, php: '${ PHP_MID_B }' }`,
			`          - { wp: ${ CURRENT_WP }, php: '${ PHP_HIGH }' }`,
		].join( '\n' )
	);
}

function statusById( root: string ): Record< string, CheckStatus > {
	const report = validateIntegration( root );
	return Object.fromEntries( report.results.map( result => [ result.id, result.status ] ) );
}

describe( 'validateIntegration', () => {
	let dir: string;

	beforeAll( () => {
		dir = mkdtempSync( join( tmpdir(), 'a8c-validate-' ) );
	} );

	afterAll( () => {
		rmSync( dir, { recursive: true, force: true } );
	} );

	it( 'passes every rule for a conformant integration', () => {
		const root = join( dir, 'conformant' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );

		const report = validateIntegration( root );

		expect( report.conformant ).toBe( true );
		expect( report.results.every( result => result.status !== 'fail' ) ).toBe( true );
		expect( report.humanReview ).toHaveLength( 2 );
		expect( report.configChecksSkipped ).toBe( false );
	} );

	it( 'fails and reports which rules broke for a non-conformant integration', () => {
		const root = join( dir, 'broken' );
		mkdirSync( root, { recursive: true } );
		writeFileSync(
			join( root, 'composer.json' ),
			JSON.stringify( { name: 'acme/broken', type: 'library' } )
		);

		const report = validateIntegration( root );
		const status = statusById( root );

		expect( report.conformant ).toBe( false );
		expect( report.configChecksSkipped ).toBe( true );
		expect( status[ 'loads-through-starter-kit' ] ).toBe( 'fail' );
		expect( status[ 'composer-test' ] ).toBe( 'fail' );
		expect( status[ 'handoff-manifest' ] ).toBe( 'fail' );
		expect( status[ 'compatibility-matrix' ] ).toBe( 'fail' );
		// No config constant and no telemetry -> not applicable, not a failure.
		expect( status[ 'config-constant-documented' ] ).toBe( 'not_applicable' );
		expect( status[ 'telemetry-tracks-only' ] ).toBe( 'not_applicable' );
	} );

	it( 'fails rule 2 when composer test omits the e2e suite', () => {
		const root = join( dir, 'unit-only' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'composer.json' ),
			JSON.stringify( {
				type: 'wordpress-plugin',
				autoload: { classmap: [ 'inc/' ] },
				scripts: { test: 'phpunit', 'validate-integration': 'echo ok' },
			} )
		);

		expect( statusById( root )[ 'composer-test' ] ).toBe( 'fail' );
	} );

	it( 'fails rule 1 when the composer type is not wordpress-plugin', () => {
		const root = join( dir, 'wrong-type' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'composer.json' ),
			JSON.stringify( {
				type: 'library',
				autoload: { classmap: [ 'inc/' ] },
				scripts: { test: [ 'phpunit', 'playwright test' ], 'validate-integration': 'x' },
			} )
		);

		expect( statusById( root )[ 'loads-through-starter-kit' ] ).toBe( 'fail' );
	} );

	it( 'resolves npm-delegated e2e through package.json for rule 2', () => {
		const root = join( dir, 'npm-delegated' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		// composer test -> `npm test`, and package.json test -> `playwright test`.
		writeFileSync(
			join( root, 'composer.json' ),
			JSON.stringify( {
				type: 'wordpress-plugin',
				autoload: { classmap: [ 'inc/' ] },
				scripts: { test: [ 'phpunit', 'npm test' ], 'validate-integration': 'x' },
			} )
		);

		expect( statusById( root )[ 'composer-test' ] ).toBe( 'pass' );
	} );

	it( 'does not accept no-op echo commands as tests for rule 2', () => {
		const root = join( dir, 'echo-tests' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'composer.json' ),
			JSON.stringify( {
				type: 'wordpress-plugin',
				autoload: { classmap: [ 'inc/' ] },
				scripts: { test: [ 'echo phpunit', 'echo npm test' ], 'validate-integration': 'x' },
			} )
		);

		expect( statusById( root )[ 'composer-test' ] ).toBe( 'fail' );
	} );

	it( 'does not let an echo-ed npm delegation smuggle in an e2e pass for rule 2', () => {
		// `echo npm test` is a no-op, so even though package.json test is a real
		// `playwright test`, it must not be expanded into a passing e2e run.
		const root = join( dir, 'echo-delegation' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'composer.json' ),
			JSON.stringify( {
				type: 'wordpress-plugin',
				autoload: { classmap: [ 'inc/' ] },
				scripts: { test: [ 'phpunit', 'echo npm test' ], 'validate-integration': 'x' },
			} )
		);

		expect( statusById( root )[ 'composer-test' ] ).toBe( 'fail' );
	} );

	it( 'passes rule 2 when test commands are prefixed with a banner echo', () => {
		const root = join( dir, 'banner-tests' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'composer.json' ),
			JSON.stringify( {
				type: 'wordpress-plugin',
				autoload: { classmap: [ 'inc/' ] },
				scripts: {
					test: [ '@test:unit', '@test:e2e' ],
					'test:unit': 'echo "Running PHPUnit" && phpunit',
					'test:e2e': 'echo "Running e2e" && playwright test',
					'validate-integration': 'x',
				},
			} )
		);

		expect( statusById( root )[ 'composer-test' ] ).toBe( 'pass' );
	} );

	it( 'does not count a runner name inside another command as an e2e run for rule 2', () => {
		// `rm -rf cypress-artifacts` mentions Cypress but runs no tests; it must
		// not satisfy the e2e requirement just by containing the runner name.
		const root = join( dir, 'e2e-substring' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'composer.json' ),
			JSON.stringify( {
				type: 'wordpress-plugin',
				autoload: { classmap: [ 'inc/' ] },
				scripts: { test: [ 'phpunit', 'rm -rf cypress-artifacts' ] },
			} )
		);

		expect( statusById( root )[ 'composer-test' ] ).toBe( 'fail' );
	} );

	it( 'passes rule 3 when a complete handoff manifest is present', () => {
		const root = join( dir, 'manifest-ok' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );

		expect( statusById( root )[ 'handoff-manifest' ] ).toBe( 'pass' );
	} );

	it( 'fails rule 3 when the handoff manifest is missing', () => {
		const root = join( dir, 'manifest-missing' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		rmSync( join( root, 'vip-manifest.yaml' ) );

		expect( statusById( root )[ 'handoff-manifest' ] ).toBe( 'fail' );
	} );

	it( 'fails rule 3 when a required manifest field is missing', () => {
		const root = join( dir, 'manifest-incomplete' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		// Drop runtime_config.constant_name — VIP needs it to define the config.
		writeFileSync(
			join( root, 'vip-manifest.yaml' ),
			conformantManifest().replace( '  constant_name: VIP_ACME_WIDGET_CONFIG\n', '' )
		);

		const rule3 = validateIntegration( root ).results.find(
			result => result.id === 'handoff-manifest'
		);
		expect( rule3?.status ).toBe( 'fail' );
		expect( rule3?.details?.join( '\n' ) ).toMatch( /constant_name/ );
	} );

	it( 'fails rule 3 when an enum config field declares no values', () => {
		const root = join( dir, 'manifest-enum' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'vip-manifest.yaml' ),
			conformantManifest().replace( /\n {6}values:[\s\S]*$/, '' )
		);

		const rule3 = validateIntegration( root ).results.find(
			result => result.id === 'handoff-manifest'
		);
		expect( rule3?.status ).toBe( 'fail' );
		expect( rule3?.details?.join( '\n' ) ).toMatch( /values/ );
	} );

	it( 'fails rule 3 when a manifest key is misspelled (unknown field)', () => {
		const root = join( dir, 'manifest-typo' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'vip-manifest.yaml' ),
			conformantManifest().replace( '    entry_file:', '    entryfile:' )
		);

		const rule3 = validateIntegration( root ).results.find(
			result => result.id === 'handoff-manifest'
		);
		expect( rule3?.status ).toBe( 'fail' );
		expect( rule3?.details?.join( '\n' ) ).toMatch( /unknown field "entryfile"/ );
	} );

	it( 'fails rule 3 when constant_name does not match VIP_*_CONFIG', () => {
		const root = join( dir, 'manifest-bad-constant' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'vip-manifest.yaml' ),
			conformantManifest().replace( 'VIP_ACME_WIDGET_CONFIG', 'ACME_WIDGET' )
		);

		const rule3 = validateIntegration( root ).results.find(
			result => result.id === 'handoff-manifest'
		);
		expect( rule3?.status ).toBe( 'fail' );
		expect( rule3?.details?.join( '\n' ) ).toMatch( /constant_name is malformed/ );
	} );

	it( 'rejects a YAML alias bomb manifest fast instead of hanging (rule 3)', () => {
		const root = join( dir, 'manifest-alias-bomb' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'vip-manifest.yaml' ),
			[
				'manifest_version: 1',
				'a: &a ["x","x","x","x","x","x","x","x","x"]',
				'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
				'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
				'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
				'e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]',
				'f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]',
				'g: &g [*f,*f,*f,*f,*f,*f,*f,*f,*f]',
				'h: &h [*g,*g,*g,*g,*g,*g,*g,*g,*g]',
				'i: &i [*h,*h,*h,*h,*h,*h,*h,*h,*h]',
			].join( '\n' )
		);

		const start = Date.now();
		const rule3 = validateIntegration( root ).results.find(
			result => result.id === 'handoff-manifest'
		);
		// The old code walked the expanded alias tree and burned tens of seconds;
		// rejecting at parse time must return effectively instantly.
		expect( Date.now() - start ).toBeLessThan( 2000 );
		expect( rule3?.status ).toBe( 'fail' );
		expect( rule3?.message ).toMatch( /could not be read as YAML/ );
	} );

	it( 'fails rule 3 when manifest_kind is wrong', () => {
		const root = join( dir, 'manifest-kind' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'vip-manifest.yaml' ),
			conformantManifest().replace( 'vip-integration-handoff', 'something-else' )
		);

		const rule3 = validateIntegration( root ).results.find(
			result => result.id === 'handoff-manifest'
		);
		expect( rule3?.status ).toBe( 'fail' );
		expect( rule3?.details?.join( '\n' ) ).toMatch( /manifest_kind must be/ );
	} );

	it( 'fails rule 3 when the documentation section is missing', () => {
		const root = join( dir, 'manifest-no-docs' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'vip-manifest.yaml' ),
			conformantManifest().replace(
				'documentation:\n  public_url: https://acme.example/docs/widget\n  support_url: https://acme.example/docs/widget/support\n',
				''
			)
		);

		const rule3 = validateIntegration( root ).results.find(
			result => result.id === 'handoff-manifest'
		);
		expect( rule3?.status ).toBe( 'fail' );
		expect( rule3?.details?.join( '\n' ) ).toMatch( /missing required field "documentation"/ );
	} );

	it( 'fails rule 3 when documentation.public_url is not a URL', () => {
		const root = join( dir, 'manifest-bad-doc-url' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'vip-manifest.yaml' ),
			conformantManifest().replace( 'https://acme.example/docs/widget/support', 'not-a-url' )
		);

		const rule3 = validateIntegration( root ).results.find(
			result => result.id === 'handoff-manifest'
		);
		expect( rule3?.status ).toBe( 'fail' );
		expect( rule3?.details?.join( '\n' ) ).toMatch( /support_url is malformed/ );
	} );

	it( 'fails rule 3 when the telemetry prefix does not end in an underscore', () => {
		const root = join( dir, 'manifest-bad-telemetry' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'vip-manifest.yaml' ),
			conformantManifest().replace( 'prefix: acme_widget_', 'prefix: acme_widget' )
		);

		const rule3 = validateIntegration( root ).results.find(
			result => result.id === 'handoff-manifest'
		);
		expect( rule3?.status ).toBe( 'fail' );
		expect( rule3?.details?.join( '\n' ) ).toMatch( /prefix is malformed/ );
	} );

	it( 'passes rule 3 with no telemetry section (telemetry is optional)', () => {
		const root = join( dir, 'manifest-no-telemetry' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'vip-manifest.yaml' ),
			conformantManifest().replace(
				'telemetry:\n  prefix: acme_widget_\n  default_properties:\n    - plugin_version\n  events:\n    - name: acme_widget_sync_started\n      type: tracks\n      trigger: A sync starts.\n      properties:\n        - trigger\n',
				''
			)
		);

		expect( statusById( root )[ 'handoff-manifest' ] ).toBe( 'pass' );
	} );

	it( 'fails rule 3 when release.plugin_version is not semver', () => {
		const root = join( dir, 'manifest-bad-version' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'vip-manifest.yaml' ),
			conformantManifest().replace( 'plugin_version: 1.0.0', 'plugin_version: v1' )
		);

		const rule3 = validateIntegration( root ).results.find(
			result => result.id === 'handoff-manifest'
		);
		expect( rule3?.status ).toBe( 'fail' );
		expect( rule3?.details?.join( '\n' ) ).toMatch( /plugin_version is malformed/ );
	} );

	it( 'passes rule 3 when a config field declares autogen and note', () => {
		const root = join( dir, 'manifest-autogen' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'vip-manifest.yaml' ),
			conformantManifest().replace(
				'    - key: api_base_url\n      label: API base URL\n      type: url\n      required: true',
				'    - key: api_base_url\n      label: API base URL\n      type: url\n      required: true\n      autogen: false\n      note: Provided by the vendor.'
			)
		);

		expect( statusById( root )[ 'handoff-manifest' ] ).toBe( 'pass' );
	} );

	it( 'fails rule 3 when autogen is not a boolean', () => {
		const root = join( dir, 'manifest-bad-autogen' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'vip-manifest.yaml' ),
			conformantManifest().replace(
				'      required: true\n    - key: sync_mode',
				'      required: true\n      autogen: not-a-bool\n    - key: sync_mode'
			)
		);

		const rule3 = validateIntegration( root ).results.find(
			result => result.id === 'handoff-manifest'
		);
		expect( rule3?.status ).toBe( 'fail' );
		expect( rule3?.details?.join( '\n' ) ).toMatch( /autogen/ );
	} );

	it( 'fails rule 3 when the manifest still has an init placeholder', () => {
		const root = join( dir, 'manifest-placeholder' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'vip-manifest.yaml' ),
			conformantManifest().replace(
				'support_contact: support@acme.example',
				'support_contact: REPLACE_ME'
			)
		);

		const rule3 = validateIntegration( root ).results.find(
			result => result.id === 'handoff-manifest'
		);
		expect( rule3?.status ).toBe( 'fail' );
		expect( rule3?.details?.join( '\n' ) ).toMatch( /support_contact.*REPLACE_ME/ );
	} );

	it( 'does not flag a real value that merely embeds the placeholder token', () => {
		const root = join( dir, 'manifest-placeholder-embedded' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'vip-manifest.yaml' ),
			conformantManifest().replace(
				'changelog: Initial release.',
				'changelog: Removed the REPLACE_ME_TOKEN debug flag.'
			)
		);

		expect( statusById( root )[ 'handoff-manifest' ] ).toBe( 'pass' );
	} );

	it( 'warns without blocking conformance when a REQUIRED_FIELDS key is missing from the manifest', () => {
		const root = join( dir, 'manifest-config-missing' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'inc', 'class-config.php' ),
			"<?php\nfinal class Config {\n\tpublic const CONSTANT_NAME = 'VIP_ACME_WIDGET_CONFIG';\n\tpublic const REQUIRED_FIELDS = [ 'api_base_url', 'webhook_secret' ];\n}\n"
		);

		const report = validateIntegration( root );
		const rule3 = report.results.find( result => result.id === 'handoff-manifest' );
		expect( rule3?.status ).toBe( 'warn' );
		expect( rule3?.details?.join( '\n' ) ).toMatch( /webhook_secret.*not declared/ );
		// The cross-check is heuristic, so it must not fail an otherwise-conformant integration.
		expect( report.conformant ).toBe( true );
	} );

	it( 'warns without blocking conformance when a SENSITIVE_FIELDS key is not typed secret', () => {
		const root = join( dir, 'manifest-config-secret' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'inc', 'class-config.php' ),
			"<?php\nfinal class Config {\n\tpublic const CONSTANT_NAME = 'VIP_ACME_WIDGET_CONFIG';\n\tpublic const SENSITIVE_FIELDS = [ 'api_base_url' ];\n}\n"
		);

		const report = validateIntegration( root );
		const rule3 = report.results.find( result => result.id === 'handoff-manifest' );
		expect( rule3?.status ).toBe( 'warn' );
		expect( rule3?.details?.join( '\n' ) ).toMatch( /api_base_url.*secret/ );
		expect( report.conformant ).toBe( true );
	} );

	it( 'passes rule 3 when the config contract matches the manifest', () => {
		const root = join( dir, 'manifest-config-ok' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'inc', 'class-config.php' ),
			"<?php\nfinal class Config {\n\tpublic const CONSTANT_NAME = 'VIP_ACME_WIDGET_CONFIG';\n\tpublic const REQUIRED_FIELDS = [ 'api_base_url' ];\n}\n"
		);

		expect( statusById( root )[ 'handoff-manifest' ] ).toBe( 'pass' );
	} );

	it( 'ignores a REQUIRED_FIELDS mention that lives only in a PHP comment', () => {
		const root = join( dir, 'manifest-config-comment' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'inc', 'class-config.php' ),
			"<?php\n/**\n * Example: REQUIRED_FIELDS = [ 'webhook_secret' ] would force that key.\n */\nfinal class Config {\n\t// SENSITIVE_FIELDS = [ 'api_base_url' ] is documented here, not declared.\n\tpublic const CONSTANT_NAME = 'VIP_ACME_WIDGET_CONFIG';\n\tpublic const REQUIRED_FIELDS = [ 'api_base_url' ];\n}\n"
		);

		expect( statusById( root )[ 'handoff-manifest' ] ).toBe( 'pass' );
	} );

	it( 'ignores an unrelated constant whose name ends in REQUIRED_FIELDS', () => {
		const root = join( dir, 'manifest-config-suffix' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		// Sorts before class-config.php, so first-match order would pick it up.
		writeFileSync(
			join( root, 'inc', 'aaa-flags.php' ),
			"<?php\nfinal class Flags {\n\tpublic const CUSTOM_REQUIRED_FIELDS = [ 'ghost_field' ];\n\tpublic const APP_SENSITIVE_FIELDS = [ 'api_base_url' ];\n}\n"
		);
		writeFileSync(
			join( root, 'inc', 'class-config.php' ),
			"<?php\nfinal class Config {\n\tpublic const CONSTANT_NAME = 'VIP_ACME_WIDGET_CONFIG';\n\tpublic const REQUIRED_FIELDS = [ 'api_base_url' ];\n}\n"
		);

		expect( statusById( root )[ 'handoff-manifest' ] ).toBe( 'pass' );
	} );

	it( 'reads a double-quoted config contract', () => {
		const root = join( dir, 'manifest-config-double-quote' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, 'inc', 'class-config.php' ),
			'<?php\nfinal class Config {\n\tpublic const CONSTANT_NAME = "VIP_ACME_WIDGET_CONFIG";\n\tpublic const REQUIRED_FIELDS = [ "webhook_secret" ];\n}\n'
		);

		const rule3 = validateIntegration( root ).results.find(
			result => result.id === 'handoff-manifest'
		);
		expect( rule3?.status ).toBe( 'warn' );
		expect( rule3?.details?.join( '\n' ) ).toMatch( /webhook_secret.*not declared/ );
	} );

	it( 'fails rule 7 when compatibility is only prose, with no CI matrix', () => {
		const root = join( dir, 'no-ci' );
		mkdirSync( join( root, 'docs' ), { recursive: true } );
		scaffoldConformant( root );
		rmSync( join( root, '.github' ), { recursive: true, force: true } );
		writeFileSync(
			join( root, 'docs', 'compat.md' ),
			`Tested against WordPress ${ PREVIOUS_WP } and ${ CURRENT_WP }, PHP ${ REQUIRED_PHP_VERSIONS.join(
				', '
			) }. Install the latest release.`
		);

		expect( statusById( root )[ 'compatibility-matrix' ] ).toBe( 'fail' );
	} );

	it( 'does not count `runs-on: ubuntu-latest` as WordPress evidence for the current release', () => {
		const root = join( dir, 'ubuntu-latest' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		// A matrix that covers the previous release and the PHP range but
		// expresses no current release or `wp: latest` — only an unrelated
		// `runs-on: ubuntu-latest` runner label.
		writeFileSync(
			join( root, '.github', 'workflows', 'unit-tests.yml' ),
			[
				'jobs:',
				'  test:',
				'    runs-on: ubuntu-latest',
				'    strategy:',
				'      matrix:',
				'        config:',
				`          - { wp: ${ PREVIOUS_WP }.x, php: '${ PHP_LOW }' }`,
				`          - { wp: ${ PREVIOUS_WP }.x, php: '${ PHP_MID_A }' }`,
				`          - { wp: ${ PREVIOUS_WP }.x, php: '${ PHP_MID_B }' }`,
				`          - { wp: ${ PREVIOUS_WP }.x, php: '${ PHP_HIGH }' }`,
			].join( '\n' )
		);

		const rule7 = validateIntegration( root ).results.find(
			result => result.id === 'compatibility-matrix'
		);
		expect( rule7?.status ).toBe( 'fail' );
		expect( rule7?.message ).toContain( `WordPress ${ CURRENT_WP }` );
	} );

	it( 'accepts `wp: latest` in the matrix as current-release evidence', () => {
		const root = join( dir, 'wp-latest' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, '.github', 'workflows', 'unit-tests.yml' ),
			[
				'jobs:',
				'  test:',
				'    runs-on: ubuntu-latest',
				'    strategy:',
				'      matrix:',
				'        config:',
				`          - { wp: ${ PREVIOUS_WP }.x, php: '${ PHP_LOW }' }`,
				`          - { wp: latest, php: '${ PHP_MID_A }' }`,
				`          - { wp: latest, php: '${ PHP_MID_B }' }`,
				`          - { wp: latest, php: '${ PHP_HIGH }' }`,
			].join( '\n' )
		);

		expect( statusById( root )[ 'compatibility-matrix' ] ).toBe( 'pass' );
	} );

	it( 'does not count a non-php version token as PHP coverage for rule 7', () => {
		const root = join( dir, 'php-scoping' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		// mysql:8.4 and a node 18.5 matrix must not be read as PHP coverage.
		writeFileSync(
			join( root, '.github', 'workflows', 'unit-tests.yml' ),
			[
				'jobs:',
				'  test:',
				'    services:',
				'      db:',
				'        image: mysql:8.4',
				'    strategy:',
				'      matrix:',
				'        node-version: [ 18.2, 18.5 ]',
				'        config:',
				`          - { wp: ${ PREVIOUS_WP }.x, php: '${ PHP_LOW }' }`,
				`          - { wp: ${ CURRENT_WP }, php: '${ PHP_MID_A }' }`,
			].join( '\n' )
		);

		const rule7 = validateIntegration( root ).results.find(
			result => result.id === 'compatibility-matrix'
		);
		expect( rule7?.status ).toBe( 'fail' );
		expect( rule7?.message ).toContain( `PHP ${ PHP_MID_B }` );
		expect( rule7?.message ).toContain( `PHP ${ PHP_HIGH }` );
	} );

	it( 'accepts a PHP matrix written as a YAML flow array for rule 7', () => {
		const root = join( dir, 'php-flow-array' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, '.github', 'workflows', 'unit-tests.yml' ),
			[
				'jobs:',
				'  test:',
				'    strategy:',
				'      matrix:',
				`        wp: [${ PREVIOUS_WP }, ${ CURRENT_WP }]`,
				`        php: [${ REQUIRED_PHP_VERSIONS.join( ', ' ) }]`,
			].join( '\n' )
		);

		expect( statusById( root )[ 'compatibility-matrix' ] ).toBe( 'pass' );
	} );

	it( 'accepts a PHP matrix written as a YAML block sequence for rule 7', () => {
		const root = join( dir, 'php-block-sequence' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, '.github', 'workflows', 'unit-tests.yml' ),
			[
				'jobs:',
				'  test:',
				'    strategy:',
				'      matrix:',
				`        wp: [${ PREVIOUS_WP }, ${ CURRENT_WP }]`,
				'        php-version:',
				...REQUIRED_PHP_VERSIONS.map( php => `          - '${ php }'` ),
			].join( '\n' )
		);

		expect( statusById( root )[ 'compatibility-matrix' ] ).toBe( 'pass' );
	} );

	it( 'fails rule 7 when the WP versions sit against a non-WordPress key (no WP evidence)', () => {
		const root = join( dir, 'php-wp-unscoped' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		// `node: [...]` is not WordPress evidence — Rule 7 must not read it as WP
		// coverage just because the version tokens appear somewhere in the workflow.
		writeFileSync(
			join( root, '.github', 'workflows', 'unit-tests.yml' ),
			[
				'jobs:',
				'  test:',
				'    strategy:',
				'      matrix:',
				`        node: [${ PREVIOUS_WP }, ${ CURRENT_WP }]`,
				`        php: [${ REQUIRED_PHP_VERSIONS.join( ', ' ) }]`,
			].join( '\n' )
		);

		const rule7 = validateIntegration( root ).results.find(
			result => result.id === 'compatibility-matrix'
		);
		expect( rule7?.status ).toBe( 'fail' );
		expect( rule7?.message ).toContain( `WordPress ${ PREVIOUS_WP }` );
		expect( rule7?.message ).toContain( `WordPress ${ CURRENT_WP }` );
	} );

	it( 'accepts the `php-versions` (plural) matrix key for rule 7', () => {
		const root = join( dir, 'php-versions-plural' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		writeFileSync(
			join( root, '.github', 'workflows', 'unit-tests.yml' ),
			[
				'jobs:',
				'  test:',
				'    strategy:',
				'      matrix:',
				`        wp: [${ PREVIOUS_WP }, ${ CURRENT_WP }]`,
				`        php-versions: [${ REQUIRED_PHP_VERSIONS.map( php => `'${ php }'` ).join(
					', '
				) }]`,
			].join( '\n' )
		);

		expect( statusById( root )[ 'compatibility-matrix' ] ).toBe( 'pass' );
	} );

	it( 'does not count PHP versions that only appear in a trailing comment', () => {
		const root = join( dir, 'php-comment' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		// The highest PHP version only appears in a comment — must not count as coverage.
		writeFileSync(
			join( root, '.github', 'workflows', 'unit-tests.yml' ),
			[
				'jobs:',
				'  test:',
				'    strategy:',
				'      matrix:',
				`        wp: [${ PREVIOUS_WP }, ${ CURRENT_WP }]`,
				`        php: [${ PHP_LOW }, ${ PHP_MID_A }, ${ PHP_MID_B }] # ${ PHP_HIGH } dropped for now`,
			].join( '\n' )
		);

		const rule7 = validateIntegration( root ).results.find(
			result => result.id === 'compatibility-matrix'
		);
		expect( rule7?.status ).toBe( 'fail' );
		expect( rule7?.message ).toContain( `PHP ${ PHP_HIGH }` );
	} );

	it( 'warns (not passes) rule 7 when a structured compatibility exception is claimed', () => {
		const root = join( dir, 'compat-exception' );
		mkdirSync( root, { recursive: true } );
		scaffoldConformant( root );
		rmSync( join( root, '.github' ), { recursive: true, force: true } );
		writeFileSync(
			join( root, 'composer.json' ),
			JSON.stringify( {
				type: 'wordpress-plugin',
				autoload: { classmap: [ 'inc/' ] },
				scripts: { test: [ 'phpunit', 'playwright test' ] },
				extra: { vip: { 'compatibility-exception': 'approved' } },
			} )
		);

		const report = validateIntegration( root );
		const rule7 = report.results.find( result => result.id === 'compatibility-matrix' );
		expect( rule7?.status ).toBe( 'warn' );
		// A claimed exception is a warning, so it must not break conformance.
		expect( report.conformant ).toBe( true );
	} );

	it( 'distinguishes a malformed composer.json from a missing one', () => {
		const root = join( dir, 'malformed' );
		mkdirSync( root, { recursive: true } );
		writeFileSync( join( root, 'composer.json' ), '{ "type": "wordpress-plugin", ' );
		writeFileSync( join( root, 'plugin.php' ), '<?php\n/** Plugin Name: M */\n' );

		const rule1 = validateIntegration( root ).results.find(
			result => result.id === 'loads-through-starter-kit'
		);
		expect( rule1?.status ).toBe( 'fail' );
		expect( rule1?.message ).toMatch( /not valid JSON/ );
	} );

	it( 'warns on rule 5 when config access is not guarded', () => {
		const root = join( dir, 'unguarded' );
		mkdirSync( join( root, 'docs' ), { recursive: true } );
		writeFileSync(
			join( root, 'widget.php' ),
			`<?php\n/** Plugin Name: W */\n$c = constant( 'VIP_WIDGET_CONFIG' );\necho $c['api_token'];\n`
		);
		writeFileSync( join( root, 'composer.json' ), JSON.stringify( { type: 'wordpress-plugin' } ) );
		writeFileSync( join( root, 'docs', 'x.md' ), 'Config: `VIP_WIDGET_CONFIG`' );

		expect( statusById( root )[ 'graceful-config-handling' ] ).toBe( 'warn' );
	} );

	it( 'recognizes an integration directory', () => {
		const root = join( dir, 'conformant' );
		expect( looksLikeIntegration( root ) ).toBe( true );
		expect( looksLikeIntegration( join( dir, 'does-not-exist' ) ) ).toBe( false );
	} );
} );
