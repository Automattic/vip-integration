import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

const mockQuestion = jest.fn< Promise< string >, [ string ] >();
const mockClose = jest.fn();

jest.mock( 'node:readline/promises', () => ( {
	createInterface: jest.fn( () => ( { question: mockQuestion, close: mockClose } ) ),
} ) );

import { initCommand, laySkeleton, parseLatestReleaseTag } from '../src/commands/init';

const SOURCE = 'https://github.com/Automattic/vip-integrations-starter-kit.git';

/** Build `git ls-remote --tags --refs` style output from tag names (newest first). */
function lsRemote( ...tags: string[] ): string {
	return tags.map( ( tag, idx ) => `hash${ idx }\trefs/tags/${ tag }` ).join( '\n' );
}

describe( 'parseLatestReleaseTag', () => {
	it( 'takes the newest release when all tags are final', () => {
		expect( parseLatestReleaseTag( lsRemote( '1.0.2', '1.0.1', '1.0.0' ), SOURCE ) ).toBe(
			'1.0.2'
		);
	} );

	it( 'skips a pre-release that outranks the newest final release', () => {
		// The "first RC of a new version" case: 1.1.0 has no final tag yet, so
		// 1.1.0-rc1 sorts on top — we must fall through to 1.0.2.
		expect( parseLatestReleaseTag( lsRemote( '1.1.0-rc1', '1.0.2', '1.0.1' ), SOURCE ) ).toBe(
			'1.0.2'
		);
	} );

	it( "skips -dev tags (Andrea's vip-cli case)", () => {
		expect(
			parseLatestReleaseTag(
				lsRemote( '3.25.3-dev.0', '3.25.2', '2.40.0-dev.4', '2.39.7' ),
				SOURCE
			)
		).toBe( '3.25.2' );
	} );

	it( 'accepts a v-prefixed release tag', () => {
		expect( parseLatestReleaseTag( lsRemote( 'v2.3.0', 'v2.2.0' ), SOURCE ) ).toBe( 'v2.3.0' );
	} );

	it( 'trims trailing whitespace from the tag name', () => {
		expect( parseLatestReleaseTag( 'hash\trefs/tags/2.3.0\n', SOURCE ) ).toBe( '2.3.0' );
	} );

	it( 'throws when the remote lists no tags', () => {
		expect( () => parseLatestReleaseTag( '', SOURCE ) ).toThrow( /no release tags/ );
	} );

	it( 'throws when only pre-release tags exist', () => {
		expect( () => parseLatestReleaseTag( lsRemote( '1.1.0-rc1', '1.1.0-rc2' ), SOURCE ) ).toThrow(
			/no release tags/
		);
	} );

	it( 'throws when a line carries no tag ref', () => {
		expect( () => parseLatestReleaseTag( 'hash\trefs/heads/trunk', SOURCE ) ).toThrow(
			/no release tags/
		);
	} );
} );

describe( 'laySkeleton', () => {
	let root: string;

	beforeAll( () => {
		root = mkdtempSync( join( tmpdir(), 'vip-integration-lay-' ) );
	} );

	afterAll( () => {
		rmSync( root, { recursive: true, force: true } );
	} );

	/**
	 * A throwaway source repository with one commit tagged `1.0.0`. `annotated`
	 * picks the tag object kind, which is the whole point of these cases: the
	 * Starter Kit's own tags have been both kinds, and `clone --branch` warns on
	 * the annotated one.
	 */
	function sourceRepo( name: string, annotated: boolean ): { path: string; commit: string } {
		const path = join( root, name );
		// A CI runner has no git identity, and both `commit` and `tag -a` need one,
		// so every invocation carries it rather than just the commit.
		const git = ( ...args: string[] ): string =>
			execFileSync(
				'git',
				[
					'-C',
					path,
					'-c',
					'user.email=t@example.com',
					'-c',
					'user.name=T',
					'-c',
					'tag.gpgsign=false',
					...args,
				],
				{ encoding: 'utf8' }
			).trim();

		execFileSync( 'git', [ 'init', '--quiet', '-b', 'main', path ] );
		writeFileSync( join( path, 'marker.txt' ), 'starter kit\n' );
		git( 'add', 'marker.txt' );
		git( 'commit', '--quiet', '-m', 'kit' );
		if ( annotated ) {
			git( 'tag', '-a', '1.0.0', '-m', 'release' );
		} else {
			git( 'tag', '1.0.0' );
		}

		return { path, commit: git( 'rev-parse', 'HEAD' ) };
	}

	it.each( [
		[ 'an annotated tag', true ],
		[ 'a lightweight tag', false ],
	] )( 'lays the kit down from %s', ( _label, annotated ) => {
		const source = sourceRepo( `src-${ annotated ? 'annotated' : 'lightweight' }`, annotated );
		const target = join( root, `out-${ annotated ? 'annotated' : 'lightweight' }` );

		laySkeleton( target, source.path, '1.0.0' );

		expect( readFileSync( join( target, 'marker.txt' ), 'utf8' ) ).toBe( 'starter kit\n' );
		// History is dropped, so the partner starts from a clean tree.
		expect( existsSync( join( target, '.git' ) ) ).toBe( false );
	} );

	it( 'hides the harmless annotated-tag warning but keeps other git output', () => {
		const source = sourceRepo( 'src-warning', true );
		const target = join( root, 'out-warning' );
		const stderr = jest.spyOn( process.stderr, 'write' ).mockImplementation( () => true );

		laySkeleton( target, source.path, '1.0.0' );

		const written = stderr.mock.calls.flat().join( '' );
		expect( written ).not.toMatch( /is not a commit/ );
		stderr.mockRestore();
	} );

	it( 'reports git failures rather than swallowing them', () => {
		const target = join( root, 'out-missing-ref' );
		const source = sourceRepo( 'src-missing-ref', false );
		const stderr = jest.spyOn( process.stderr, 'write' ).mockImplementation( () => true );

		expect( () => laySkeleton( target, source.path, '9.9.9' ) ).toThrow( /failed/ );
		// git's own explanation survives the filter.
		expect( stderr.mock.calls.flat().join( '' ) ).toMatch( /9\.9\.9|not found|Remote branch/ );
		stderr.mockRestore();
	} );

	it( 'falls back to the default branch when there is no ref', () => {
		const source = sourceRepo( 'src-noref', false );
		const target = join( root, 'out-noref' );

		laySkeleton( target, source.path, undefined );

		expect( readFileSync( join( target, 'marker.txt' ), 'utf8' ) ).toBe( 'starter kit\n' );
	} );
} );

describe( 'initCommand', () => {
	let root: string;
	let starterKit: string;
	let stdinTTY: PropertyDescriptor | undefined;
	let stdoutTTY: PropertyDescriptor | undefined;
	let starterKitSource: string | undefined;
	let noColor: string | undefined;

	beforeAll( () => {
		root = mkdtempSync( join( tmpdir(), 'vip-integration-init-' ) );
		starterKit = join( __dirname, '..' );
	} );

	beforeEach( () => {
		stdinTTY = Object.getOwnPropertyDescriptor( process.stdin, 'isTTY' );
		stdoutTTY = Object.getOwnPropertyDescriptor( process.stdout, 'isTTY' );
		starterKitSource = process.env.A8C_STARTER_KIT_SOURCE;
		noColor = process.env.NO_COLOR;
		process.env.A8C_STARTER_KIT_SOURCE = starterKit;
		Object.defineProperty( process.stdin, 'isTTY', { configurable: true, value: true } );
		mockQuestion.mockReset();
		mockClose.mockReset();
	} );

	afterEach( () => {
		if ( stdinTTY ) {
			Object.defineProperty( process.stdin, 'isTTY', stdinTTY );
		} else {
			Reflect.deleteProperty( process.stdin, 'isTTY' );
		}
		if ( stdoutTTY ) {
			Object.defineProperty( process.stdout, 'isTTY', stdoutTTY );
		} else {
			Reflect.deleteProperty( process.stdout, 'isTTY' );
		}
		if ( starterKitSource === undefined ) {
			Reflect.deleteProperty( process.env, 'A8C_STARTER_KIT_SOURCE' );
		} else {
			process.env.A8C_STARTER_KIT_SOURCE = starterKitSource;
		}
		if ( noColor === undefined ) {
			Reflect.deleteProperty( process.env, 'NO_COLOR' );
		} else {
			process.env.NO_COLOR = noColor;
		}
		jest.restoreAllMocks();
	} );

	afterAll( () => {
		rmSync( root, { recursive: true, force: true } );
	} );

	it( 'uses ANSI colors when stdout supports them', async () => {
		const target = join( root, 'color-result' );
		const log = jest.spyOn( console, 'log' ).mockImplementation();
		Object.defineProperty( process.stdout, 'isTTY', { configurable: true, value: true } );
		Reflect.deleteProperty( process.env, 'NO_COLOR' );

		await initCommand( { vendor: 'Acme', name: 'Content Sync', dir: target } );

		const output = log.mock.calls.flat().join( '\n' );
		expect( output ).toContain( '\x1b[36mcomposer install && npm install\x1b[39m' );
		expect( output ).toContain( '\x1b[36mvip-integration validate\x1b[39m' );
	} );

	it( 'uses plain text when NO_COLOR disables ANSI colors', async () => {
		const target = join( root, 'no-color-result' );
		const log = jest.spyOn( console, 'log' ).mockImplementation();
		Object.defineProperty( process.stdout, 'isTTY', { configurable: true, value: true } );
		process.env.NO_COLOR = '1';

		await initCommand( { vendor: 'Acme', name: 'Content Sync', dir: target } );

		const output = log.mock.calls.flat().join( '\n' );
		expect( output ).not.toContain( '\x1b[' );
		expect( output ).toContain( 'composer install && npm install' );
		expect( output ).toContain( 'vip-integration validate' );
	} );

	it( 'explains init and each value before asking an interactive user', async () => {
		const target = join( root, 'interactive-result' );
		const log = jest.spyOn( console, 'log' ).mockImplementation();
		mockQuestion.mockResolvedValueOnce( 'Acme' ).mockResolvedValueOnce( 'Content Sync' );

		await initCommand( { dir: target } );

		const output = stripVTControlCharacters( log.mock.calls.flat().join( '\n' ) );
		expect( output ).toContain( 'Welcome to vip-integration init' );
		expect( output ).toContain( 'latest released VIP Integrations Starter Kit' );
		expect( output ).toContain( 'new or empty target directory' );
		expect( output ).toContain( 'without the Starter Kit Git history' );
		expect( output ).toContain( 'package vendor and PHP namespace prefix' );
		expect( output ).toContain(
			'package name, namespace, code prefixes, slug, config constant, and default directory'
		);

		const welcomeCall = log.mock.calls.findIndex( call =>
			String( call[ 0 ] ).includes( 'Welcome' )
		);
		const vendorCall = log.mock.calls.findIndex( call =>
			String( call[ 0 ] ).includes( 'package vendor' )
		);
		const integrationCall = log.mock.calls.findIndex( call =>
			String( call[ 0 ] ).includes( 'package name' )
		);
		expect( stripVTControlCharacters( String( log.mock.calls[ vendorCall ][ 0 ] ) ) ).toMatch(
			/^ {2}Use/
		);
		expect( stripVTControlCharacters( String( log.mock.calls[ integrationCall ][ 0 ] ) ) ).toMatch(
			/^ {2}Use/
		);
		expect( log.mock.invocationCallOrder[ welcomeCall ] ).toBeLessThan(
			mockQuestion.mock.invocationCallOrder[ 0 ]
		);
		expect( log.mock.invocationCallOrder[ vendorCall ] ).toBeLessThan(
			mockQuestion.mock.invocationCallOrder[ 0 ]
		);
		expect( log.mock.invocationCallOrder[ integrationCall ] ).toBeGreaterThan(
			mockQuestion.mock.invocationCallOrder[ 0 ]
		);
		expect( log.mock.invocationCallOrder[ integrationCall ] ).toBeLessThan(
			mockQuestion.mock.invocationCallOrder[ 1 ]
		);
	} );

	it( 'uses complete flags without interactive guidance in a non-TTY shell', async () => {
		const target = join( root, 'flag-result' );
		const log = jest.spyOn( console, 'log' ).mockImplementation();
		Object.defineProperty( process.stdin, 'isTTY', { configurable: true, value: false } );

		await initCommand( { vendor: 'Acme', name: 'Content Sync', dir: target } );

		const output = stripVTControlCharacters( log.mock.calls.flat().join( '\n' ) );
		expect( mockQuestion ).not.toHaveBeenCalled();
		expect( output ).not.toContain( 'Welcome to vip-integration init' );
		expect( output ).not.toContain( 'package vendor and PHP namespace prefix' );
		expect( output ).not.toContain( 'default directory' );
		expect( output ).toContain( 'Created ContentSync integration' );
		expect( output ).toContain(
			'Follow the Runtime Config section in docs/vip-integration.md to learn how to use your runtime config (VIP_CONTENT_SYNC_CONFIG) and complete the integration.'
		);
		expect( output ).toContain(
			'Follow docs/manifest.md to configure vip-manifest.yaml, which is required before submitting the integration.'
		);
		expect( output ).toContain(
			'Edit the integration, then run vip-integration validate in the integration folder to check whether it is ready to submit.'
		);
		expect( existsSync( join( target, 'README.md' ) ) ).toBe( true );
		expect( existsSync( join( target, '.git' ) ) ).toBe( false );
	} );

	it( 'rejects a missing non-interactive answer without writing the target', async () => {
		const target = join( root, 'missing-answer' );
		const log = jest.spyOn( console, 'log' ).mockImplementation();
		Object.defineProperty( process.stdin, 'isTTY', { configurable: true, value: false } );

		await expect( initCommand( { vendor: 'Acme', dir: target } ) ).rejects.toThrow(
			'Missing Integration name'
		);

		expect( log ).not.toHaveBeenCalled();
		expect( mockQuestion ).not.toHaveBeenCalled();
		expect( existsSync( target ) ).toBe( false );
	} );

	it( 'rejects invalid flag values before writing the target', async () => {
		const target = join( root, 'invalid-name' );
		Object.defineProperty( process.stdin, 'isTTY', { configurable: true, value: false } );

		await expect(
			initCommand( { vendor: 'Acme', name: '123 demo', dir: target } )
		).rejects.toThrow( 'valid PHP namespace' );

		expect( existsSync( target ) ).toBe( false );
	} );
} );
