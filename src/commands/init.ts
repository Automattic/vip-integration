/**
 * `vip-integration init` — start a new integration.
 *
 * Lays down the VIP Integrations Starter Kit as the project skeleton, collects
 * the same inputs `composer setup` collects (vendor + integration name), then
 * rewrites the example prefix set to the partner's names. The result is a
 * ready-to-edit integration; the developer runs `vip-integration validate` when
 * they are ready to check conformance.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { bold, cyan, gray, green } from '../lib/colors';
import { derivePrefixSet, kebabCase, scaffoldTree } from '../lib/scaffold/scaffold';

import type { PrefixSet } from '../lib/scaffold/scaffold';

const STARTER_KIT_URL = 'https://github.com/Automattic/vip-integrations-starter-kit.git';

/**
 * Internal offline-test override for the Starter Kit source (a local path or
 * URL). Deliberately not a CLI option: the source is never the user's choice —
 * `init` always builds from the canonical VIP Starter Kit. When set, `init`
 * clones the override directly at its default branch.
 */
const STARTER_KIT_SOURCE_ENV = 'A8C_STARTER_KIT_SOURCE';

/**
 * A final release tag: `1.2.3` or `v1.2.3`, nothing after the patch number.
 * Pre-releases carry a `-<suffix>` (`1.1.0-rc1`, `3.25.3-dev.0`) and are
 * deliberately excluded — `init` pins to released, tested versions only. Note
 * that git's version sort can't do this for us: a pre-release is a *higher*
 * version than the last release (its final tag doesn't exist yet), so it sorts
 * on top; the only reliable filter is to reject the suffix outright.
 */
const RELEASE_TAG = /^v?\d+\.\d+\.\d+$/;

/**
 * Pick the newest final-release tag out of `git ls-remote --tags --refs
 * --sort=-v:refname` output. Lines arrive newest-first by version, so we walk
 * them and return the first plain release tag, skipping any pre-release/`-dev`
 * tag that outranks it. Throws when no release tag exists. Kept pure and
 * separate from the `git` call so it can be unit-tested against real `ls-remote`
 * output, including the pre-release-only and no-tags cases.
 */
export function parseLatestReleaseTag( lsRemoteOutput: string, source: string ): string {
	for ( const line of lsRemoteOutput.split( '\n' ) ) {
		const tag = line.split( 'refs/tags/' )[ 1 ]?.trim();
		if ( tag && RELEASE_TAG.test( tag ) ) {
			return tag;
		}
	}
	throw new Error( `The Starter Kit (${ source }) has no release tags to pin to.` );
}

/**
 * The Starter Kit's newest release tag, read straight from the remote's tag list
 * with the `git` we already shell out to — no GitHub API, no auth. `init` pins
 * to this so it builds from the latest released, tested version rather than the
 * moving `main` tip. `--sort=-v:refname` orders tags newest-first by version and
 * `--refs` drops the peeled `^{}` duplicates; `parseLatestReleaseTag` then skips
 * any pre-release tag. stderr inherits so a network/git failure surfaces git's
 * own message rather than a bare "Command failed".
 */
function latestReleaseTag( source: string ): string {
	const output = execFileSync(
		'git',
		[ 'ls-remote', '--tags', '--refs', '--sort=-v:refname', '--', source ],
		{ encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'inherit' ] }
	);
	return parseLatestReleaseTag( output, source );
}

export interface InitOptions {
	vendor?: string;
	name?: string;
	dir?: string;
}

async function prompt( label: string ): Promise< string > {
	const rl = createInterface( { input: process.stdin, output: process.stdout } );
	try {
		return ( await rl.question( `${ label }: ` ) ).trim();
	} finally {
		rl.close();
	}
}

function hasInput( value: string | undefined ): value is string {
	return typeof value === 'string' && value.trim() !== '';
}

function printInteractiveWelcome(): void {
	console.log( bold( 'Welcome to vip-integration init' ) );
	console.log(
		gray(
			[
				'This creates a new Integration Center add-on from the latest released VIP Integrations Starter Kit.',
				'It personalizes identifiers from your answers, writes to a new or empty target directory,',
				'and leaves a plain directory without the Starter Kit Git history.',
			].join( '\n' )
		)
	);
}

/** Resolve a required input from a flag or an interactive prompt. Errors in a
 * non-interactive shell instead of hanging on a prompt nobody can answer. */
async function resolveInput(
	label: string,
	provided: string | undefined,
	context: string
): Promise< string > {
	if ( hasInput( provided ) ) {
		return provided.trim();
	}
	if ( ! process.stdin.isTTY ) {
		throw new Error(
			`Missing ${ label }. Pass it as a flag (e.g. --vendor, --name) when running non-interactively.`
		);
	}
	console.log( `\n${ bold( label.split( ' (' )[ 0 ] ) }` );
	console.log( gray( `  ${ context }` ) );
	return prompt( label );
}

function isEmptyOrMissing( dir: string ): boolean {
	return ! existsSync( dir ) || readdirSync( dir ).length === 0;
}

/**
 * `git clone --branch <ref>` warns when `ref` is an annotated tag — it resolves
 * to the tag object, says so, then dereferences to the commit anyway. The clone
 * is correct, but the line lands under "Laying down..." and reads like a failure.
 * No flag suppresses it (`--no-tags`, `--single-branch` and dropping `--depth`
 * all still warn on git 2.54.0) and it is a warning, not advice, so `advice.*`
 * does nothing.
 *
 * Anchored tightly so every other line git writes still reaches the partner.
 * Fetching the ref instead would avoid the warning, but cannot read a shallow
 * source, which is how CI checks the kit out — don't swap it back.
 */
const ANNOTATED_TAG_WARNING = /^warning: refs\/tags\/\S+ [0-9a-f]{40} is not a commit!$/;

/**
 * Lay the canonical VIP Starter Kit down into `target` and drop its git history,
 * leaving a clean tree. Clones only the tip of `ref` shallowly (no history),
 * then removes `.git`. The source is fixed to the Starter Kit URL; the env
 * override exists only so tests can run offline against a local clone.
 */
export function laySkeleton( target: string, source: string, ref: string | undefined ): void {
	const isRemote = /^[a-z]+:\/\/|^git@|\.git$/i.test( source );
	// Shallow-clone remotes so no history is pulled; a local override path is
	// cloned plainly (git ignores --depth for local paths and warns).
	const depth = isRemote ? [ '--depth', '1' ] : [];
	// Pin to the release tag when we have one; an override with no ref clones its
	// default branch (the offline-test path).
	const branch = ref ? [ '--branch', ref ] : [];
	// Cloning a tag lands on a detached HEAD; silence that advice since we drop
	// `.git` immediately anyway. `--` ends option parsing so the source can never
	// be read as a git flag.
	const result = spawnSync(
		'git',
		[
			'-c',
			'advice.detachedHead=false',
			'clone',
			...depth,
			...branch,
			'--quiet',
			'--',
			source,
			target,
		],
		{ stdio: [ 'ignore', 'ignore', 'pipe' ], encoding: 'utf8' }
	);

	// Pass git's own diagnostics through, minus the one harmless line above, so a
	// real failure still explains itself.
	const stderr = ( result.stderr ?? '' )
		.split( '\n' )
		.filter( line => ! ANNOTATED_TAG_WARNING.test( line.trim() ) )
		.join( '\n' );
	if ( stderr.trim() !== '' ) {
		process.stderr.write( stderr.endsWith( '\n' ) ? stderr : `${ stderr }\n` );
	}

	if ( result.error ) {
		throw result.error;
	}
	if ( result.status !== 0 ) {
		throw new Error( `git clone of the Starter Kit (${ source }) failed.` );
	}

	rmSync( resolve( target, '.git' ), { recursive: true, force: true } );
}

export async function initCommand( opts: InitOptions = {} ): Promise< void > {
	const needsPrompt = ! hasInput( opts.vendor ) || ! hasInput( opts.name );
	if ( needsPrompt && process.stdin.isTTY ) {
		printInteractiveWelcome();
	}

	const vendor = await resolveInput(
		'Vendor name (e.g. "WordPress")',
		opts.vendor,
		'Use the company or team that owns the integration, such as "Acme". This sets the package vendor and PHP namespace prefix.'
	);
	const name = await resolveInput(
		'Integration name (e.g. "Content Sync")',
		opts.name,
		'Use the product or add-on name. This sets the package name, namespace, code prefixes, slug, config constant, and default directory.'
	);

	// Validate the names before touching the filesystem, so bad input fails fast
	// instead of leaving a half-laid-down directory behind.
	derivePrefixSet( vendor, name );

	const target = resolve( opts.dir ?? kebabCase( name ) );
	if ( ! isEmptyOrMissing( target ) ) {
		throw new Error( `Target directory is not empty: ${ target }` );
	}
	const existedBefore = existsSync( target );

	// A local override (tests/offline) is cloned at its default branch; otherwise
	// pin to the Starter Kit's latest release tag, not the moving `main` tip.
	const override = process.env[ STARTER_KIT_SOURCE_ENV ];
	const source = override ?? STARTER_KIT_URL;
	const ref = override ? undefined : latestReleaseTag( source );

	console.log(
		gray( `Laying down the VIP Starter Kit${ ref ? ` (${ ref })` : '' } into ${ target }` )
	);

	let entryFile: string | null;
	let prefix: PrefixSet;
	try {
		laySkeleton( target, source, ref );
		( { entryFile, prefix } = scaffoldTree( target, vendor, name ) );
		// The scaffold is left as a plain directory, not a git repo — the partner
		// initializes version control themselves when and how they want.
	} catch ( error ) {
		// A clone that dies partway or a scaffold that throws would otherwise leave
		// a half-populated directory that blocks the next run. Remove what we laid
		// down, restoring the empty directory the user may have created themselves.
		rmSync( target, { recursive: true, force: true } );
		if ( existedBefore ) {
			mkdirSync( target, { recursive: true } );
		}
		throw error;
	}

	console.log( green( `\n✓ Created ${ prefix.namePascal } integration at ${ target }` ) );
	console.log(
		gray(
			`  slug=${ prefix.nameKebab }, namespace=${ prefix.vendorPascal }\\${ prefix.namePascal }, config=${ prefix.configConstant }` +
				( entryFile ? `, entry=${ entryFile }` : '' )
		)
	);

	console.log( bold( '\nNext steps:' ) );
	for ( const step of [
		cyan( `cd ${ target }` ),
		cyan( 'composer install && npm install' ),
		`Follow the Runtime Config section in ${ cyan(
			'docs/vip-integration.md'
		) } to learn how to use your runtime config (${
			prefix.configConstant
		}) and complete the integration.`,
		`Follow ${ cyan(
			'docs/manifest.md'
		) } to configure vip-manifest.yaml, which is required before submitting the integration.`,
		`Run it locally: ${ cyan( 'vip dev-env create && vip dev-env start' ) }`,
		`Edit the integration, then run ${ cyan(
			'vip-integration validate'
		) } in the integration folder to check whether it is ready to submit.`,
	] ) {
		console.log( `  ${ cyan( '→' ) } ${ step }` );
	}
}
