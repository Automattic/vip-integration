import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
	buildReplacements,
	derivePrefixSet,
	kebabCase,
	pascalCase,
	rewriteContents,
	scaffoldTree,
	strtr,
} from '../src/lib/scaffold/scaffold';

describe( 'case transforms', () => {
	it( 'pascal-cases across separators and casing', () => {
		expect( pascalCase( 'content sync' ) ).toBe( 'ContentSync' );
		expect( pascalCase( 'acme-widgets' ) ).toBe( 'AcmeWidgets' );
		expect( pascalCase( 'ACME co.' ) ).toBe( 'AcmeCo' );
	} );

	it( 'kebab-cases and trims stray separators', () => {
		expect( kebabCase( 'Content Sync' ) ).toBe( 'content-sync' );
		expect( kebabCase( '  Acme!!Co  ' ) ).toBe( 'acme-co' );
	} );
} );

describe( 'derivePrefixSet', () => {
	it( 'derives the full prefix set', () => {
		const prefix = derivePrefixSet( 'Acme', 'Content Sync' );
		expect( prefix ).toMatchObject( {
			vendorPascal: 'Acme',
			namePascal: 'ContentSync',
			vendorKebab: 'acme',
			nameKebab: 'content-sync',
			nameSnake: 'content_sync',
			nameSquashed: 'contentsync',
			nameUpper: 'CONTENT_SYNC',
			configConstant: 'VIP_CONTENT_SYNC_CONFIG',
		} );
	} );

	it( 'rejects empty inputs', () => {
		expect( () => derivePrefixSet( '', 'X' ) ).toThrow( /required/ );
		expect( () => derivePrefixSet( 'X', '  ' ) ).toThrow( /required/ );
	} );

	it( 'rejects names that cannot form a valid PHP namespace', () => {
		expect( () => derivePrefixSet( 'Acme', '123 demo' ) ).toThrow( /valid PHP namespace/ );
	} );

	it( 'rejects names whose derived slug exceeds the 30-character manifest cap', () => {
		// Exactly at the cap: still valid.
		const atCap = derivePrefixSet( 'Acme', 'A'.repeat( 30 ) );
		expect( atCap.nameKebab ).toBe( 'a'.repeat( 30 ) );
		// One over the cap: the confirmed review finding's repro, a 32-char
		// slug `init` previously wrote and reported success for.
		expect( () => derivePrefixSet( 'Acme', 'Acme Enterprise Content Delivery' ) ).toThrow(
			/too long|"acme-enterprise-content-delivery" is 32 characters \(max 30\)/
		);
		// Far over the cap.
		expect( () => derivePrefixSet( 'Acme', 'A'.repeat( 31 ) ) ).toThrow( /max 30/ );
	} );
} );

describe( 'strtr', () => {
	it( 'replaces the longest key first and does not re-scan replacements', () => {
		const pairs: Array< [ string, string ] > = [
			[ 'ab', 'X' ],
			[ 'abc', 'Y' ],
		];
		expect( strtr( 'abc ab', pairs ) ).toBe( 'Y X' );
	} );

	it( 'does not cascade a replacement into a later key', () => {
		// 'a' -> 'b' must not then match a 'b' -> 'c' rule.
		const pairs: Array< [ string, string ] > = [
			[ 'a', 'b' ],
			[ 'b', 'c' ],
		];
		expect( strtr( 'a', pairs ) ).toBe( 'b' );
	} );
} );

describe( 'rewriteContents', () => {
	const replacements = buildReplacements( derivePrefixSet( 'Acme', 'Content Sync' ) );

	it( 'rewrites the example prefix set', () => {
		expect( rewriteContents( 'namespace ExampleVendor\\ExampleIntegration;', replacements ) ).toBe(
			'namespace Acme\\ContentSync;'
		);
		expect( rewriteContents( 'define( VIP_EXAMPLE_INTEGRATION_CONFIG )', replacements ) ).toBe(
			'define( VIP_CONTENT_SYNC_CONFIG )'
		);
		expect( rewriteContents( 'example-vendor/example-integration', replacements ) ).toBe(
			'acme/content-sync'
		);
	} );

	it( 'squashes the telemetry prefix into a single word', () => {
		expect(
			rewriteContents(
				'prefix: exampleintegration_\noption: example_integration_settings',
				replacements
			)
		).toBe( 'prefix: contentsync_\noption: content_sync_settings' );
	} );

	it( 'preserves everything from the token-table marker onward', () => {
		const input = 'ExampleIntegration\n## Making it your own\nExampleIntegration stays';
		expect( rewriteContents( input, replacements ) ).toBe(
			'ContentSync\n## Making it your own\nExampleIntegration stays'
		);
	} );
} );

describe( 'scaffoldTree', () => {
	let dir: string;

	beforeAll( () => {
		dir = mkdtempSync( join( tmpdir(), 'a8c-scaffold-' ) );
	} );

	afterAll( () => {
		rmSync( dir, { recursive: true, force: true } );
	} );

	it( 'rewrites tracked files, renames the entry file, and honors skips', () => {
		const root = join( dir, 'kit' );
		mkdirSync( join( root, 'inc' ), { recursive: true } );
		mkdirSync( join( root, 'vendor' ), { recursive: true } );

		writeFileSync(
			join( root, 'composer.json' ),
			'{ "name": "example-vendor/example-integration" }'
		);
		writeFileSync(
			join( root, 'inc', 'class-plugin.php' ),
			'<?php namespace ExampleVendor\\ExampleIntegration;'
		);
		writeFileSync(
			join( root, 'example-integration.php' ),
			'<?php /* Plugin Name: Example Integration */'
		);
		// Skipped: vendor/ must stay untouched.
		writeFileSync( join( root, 'vendor', 'autoload.php' ), 'ExampleVendor' );

		const result = scaffoldTree( root, 'Acme', 'Content Sync' );

		expect( result.entryFile ).toBe( 'content-sync.php' );
		expect( existsSync( join( root, 'content-sync.php' ) ) ).toBe( true );
		expect( existsSync( join( root, 'example-integration.php' ) ) ).toBe( false );
		expect( readFileSync( join( root, 'composer.json' ), 'utf8' ) ).toContain(
			'acme/content-sync'
		);
		expect( readFileSync( join( root, 'inc', 'class-plugin.php' ), 'utf8' ) ).toContain(
			'Acme\\ContentSync'
		);
		// vendor/ was skipped.
		expect( readFileSync( join( root, 'vendor', 'autoload.php' ), 'utf8' ) ).toBe(
			'ExampleVendor'
		);
		expect( result.changed ).toBeGreaterThanOrEqual( 3 );
	} );

	it( 'personalizes derivable manifest fields and placeholders the rest', () => {
		const root = join( dir, 'manifest' );
		mkdirSync( root, { recursive: true } );
		writeFileSync(
			join( root, 'vip-manifest.yaml' ),
			[
				'# yaml-language-server: $schema=./vip-manifest.schema.json',
				'integration:',
				'  slug: example-integration',
				'  summary: Reference integration built from the VIP Integrations Starter Kit.',
				'  partner:',
				'    support_contact: support@example.com',
				'documentation:',
				'  public_url: https://example.com/docs/example-integration',
				'  support_url: https://example.com/docs/example-integration/support',
				'release:',
				'  changelog: Initial VIP integration starter kit example.',
				'',
			].join( '\n' )
		);

		scaffoldTree( root, 'Acme', 'Content Sync' );

		const manifest = readFileSync( join( root, 'vip-manifest.yaml' ), 'utf8' );
		// Derivable fields get real values.
		expect( manifest ).toContain( 'summary: Content Sync integration for WordPress VIP.' );
		expect( manifest ).toContain( 'changelog: Initial release.' );
		// Partner-only fields become placeholders so validate fails until filled.
		expect( manifest ).toContain( 'support_contact: REPLACE_ME' );
		expect( manifest ).toContain( 'public_url: https://REPLACE_ME' );
		expect( manifest ).toContain( 'support_url: https://REPLACE_ME' );
		// The schema modeline comment survives the edit.
		expect( manifest ).toContain( '# yaml-language-server: $schema=./vip-manifest.schema.json' );
		// The token pass still ran: the example slug was rewritten.
		expect( manifest ).toContain( 'slug: content-sync' );
	} );

	it( 'leaves a binary file untouched even when it contains a token', () => {
		const root = join( dir, 'binary' );
		mkdirSync( root, { recursive: true } );
		writeFileSync(
			join( root, 'composer.json' ),
			'{ "name": "example-vendor/example-integration" }'
		);
		// A binary asset (e.g. a .ico) whose bytes happen to include a token, with a
		// NUL byte marking it as binary. Reading it as utf8 and rewriting would
		// corrupt the untokened bytes into U+FFFD.
		const binary = Buffer.from( [ 0x00, 0x45, 0x78, 0x00, 0xff, 0xfe ] ); // includes NUL
		writeFileSync( join( root, 'logo.ico' ), binary );

		scaffoldTree( root, 'Acme', 'Content Sync' );

		expect( readFileSync( join( root, 'logo.ico' ) ).equals( binary ) ).toBe( true );
	} );

	it( 'drops the redundant Starter Kit scaffolder and its composer script', () => {
		const root = join( dir, 'cleanup' );
		mkdirSync( join( root, 'bin' ), { recursive: true } );

		writeFileSync( join( root, 'bin', 'setup.php' ), '<?php // scaffolder' );
		writeFileSync( join( root, 'bin', 'validate-integration.php' ), '<?php // keep me' );
		writeFileSync(
			join( root, 'composer.json' ),
			JSON.stringify( {
				name: 'example-vendor/example-integration',
				scripts: { setup: '@php bin/setup.php', test: 'phpunit' },
				'scripts-descriptions': { setup: 'Rewrite the example prefix set', test: 'Run tests' },
			} )
		);
		writeFileSync(
			join( root, 'example-integration.php' ),
			'<?php /* Plugin Name: Example Integration */'
		);

		scaffoldTree( root, 'Acme', 'Content Sync' );

		expect( existsSync( join( root, 'bin', 'setup.php' ) ) ).toBe( false );
		// Unrelated bin scripts are left alone.
		expect( existsSync( join( root, 'bin', 'validate-integration.php' ) ) ).toBe( true );

		const composer = JSON.parse( readFileSync( join( root, 'composer.json' ), 'utf8' ) ) as {
			scripts: Record< string, unknown >;
			'scripts-descriptions': Record< string, unknown >;
		};
		expect( composer.scripts.setup ).toBeUndefined();
		expect( composer.scripts.test ).toBe( 'phpunit' );
		expect( composer[ 'scripts-descriptions' ].setup ).toBeUndefined();
		expect( composer[ 'scripts-descriptions' ].test ).toBe( 'Run tests' );
	} );
} );
