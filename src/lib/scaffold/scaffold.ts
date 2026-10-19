/**
 * Scaffolding transforms for `vip-integration init`.
 *
 * Ports the Starter Kit's `composer setup` rewrite (bin/setup.php) into
 * TypeScript so scaffolding needs no PHP. It rewrites the example prefix set
 * ("ExampleVendor", "example-integration", "VIP_EXAMPLE_INTEGRATION", …) to the
 * partner's own names across the laid-down skeleton, then renames the entry
 * file. Kept as pure fs functions so the rewrite is unit-testable on its own,
 * separate from cloning the skeleton.
 */

import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { MANIFEST_FILENAMES } from '../validate/manifest';
import { MANIFEST_PLACEHOLDER, SLUG_MAX_LENGTH } from '../validate/manifest.schema';

/** Everything from this heading onward in a file is left un-rewritten: it is a
 * token table that must keep the example prefix so its mapping stays readable. */
const PRESERVE_MARKER = '## Making it your own';

/** Paths (relative, forward-slash) that must not be rewritten. Mirrors the
 * skip set in bin/setup.php: dependencies, lockfiles, the scaffolder itself,
 * and binary assets. */
const SKIP_PATTERN =
	/^(vendor\/|node_modules\/|bin\/setup\.php|composer\.lock|package-lock\.json|\.playwright\/)|\.(png|jpg|jpeg|gif|webp)$/;

export interface PrefixSet {
	vendorPascal: string;
	namePascal: string;
	vendorKebab: string;
	nameKebab: string;
	nameSnake: string;
	nameSquashed: string;
	nameUpper: string;
	configConstant: string;
}

export function pascalCase( value: string ): string {
	return value
		.replace( /[^a-zA-Z0-9]+/g, ' ' )
		.toLowerCase()
		.split( ' ' )
		.filter( Boolean )
		.map( word => word.charAt( 0 ).toUpperCase() + word.slice( 1 ) )
		.join( '' );
}

export function kebabCase( value: string ): string {
	return value
		.replace( /[^a-zA-Z0-9]+/g, '-' )
		.toLowerCase()
		.replace( /^-+|-+$/g, '' );
}

function wordsCase( kebab: string ): string {
	return kebab
		.split( '-' )
		.filter( Boolean )
		.map( word => word.charAt( 0 ).toUpperCase() + word.slice( 1 ) )
		.join( ' ' );
}

/**
 * Derive the full prefix set from a vendor and integration name. Throws if
 * either would produce an invalid PHP namespace identifier (must start with a
 * letter or underscore), matching the guard in bin/setup.php.
 */
export function derivePrefixSet( vendor: string, name: string ): PrefixSet {
	if ( vendor.trim() === '' || name.trim() === '' ) {
		throw new Error( 'Vendor and integration name are both required.' );
	}

	const vendorPascal = pascalCase( vendor );
	const namePascal = pascalCase( name );

	for ( const [ label, identifier ] of [
		[ 'Vendor', vendorPascal ],
		[ 'Integration', namePascal ],
	] as const ) {
		if ( ! /^[A-Za-z_][A-Za-z0-9_]*$/.test( identifier ) ) {
			throw new Error(
				`${ label } name must start with a letter to produce a valid PHP namespace (got "${ identifier }").`
			);
		}
	}

	const nameKebab = kebabCase( name );
	const nameSnake = nameKebab.replace( /-/g, '_' );

	// The manifest schema caps the integration slug at 30 chars
	// (integration_definition.slug); reject the name up front rather than
	// laying down a skeleton whose manifest fails validation.
	if ( nameKebab.length > SLUG_MAX_LENGTH ) {
		throw new Error(
			`Integration name is too long: the derived slug "${ nameKebab }" is ${ nameKebab.length } characters (max ${ SLUG_MAX_LENGTH }). Shorten the integration name so its kebab-case slug fits within ${ SLUG_MAX_LENGTH } characters.`
		);
	}

	return {
		vendorPascal,
		namePascal,
		vendorKebab: kebabCase( vendor ),
		nameKebab,
		nameSnake,
		// Tracks prefixes are a single token, so the telemetry prefix squashes the
		// name instead of joining its words: "Content Sync" becomes `contentsync_`.
		nameSquashed: nameKebab.replace( /-/g, '' ),
		nameUpper: nameSnake.toUpperCase(),
		configConstant: `VIP_${ nameSnake.toUpperCase() }_CONFIG`,
	};
}

/** The ordered example-token → replacement map for a prefix set. */
export function buildReplacements( prefix: PrefixSet ): Array< [ string, string ] > {
	return [
		[ 'example-vendor/example-integration', `${ prefix.vendorKebab }/${ prefix.nameKebab }` ],
		[ 'ExampleVendor', prefix.vendorPascal ],
		[ 'ExampleIntegration', prefix.namePascal ],
		[ 'VIP_EXAMPLE_INTEGRATION', `VIP_${ prefix.nameUpper }` ],
		[ 'exampleintegration', prefix.nameSquashed ],
		[ 'example_integration', prefix.nameSnake ],
		[ 'example-integration', prefix.nameKebab ],
		[ 'Example Integration', wordsCase( prefix.nameKebab ) ],
		[ 'Example Vendor', wordsCase( prefix.vendorKebab ) ],
	];
}

/**
 * Simultaneous, non-overlapping string replacement — PHP's `strtr` semantics.
 * At each position the longest matching key wins and its replacement is not
 * re-scanned, so an earlier substitution can never cascade into a later key.
 */
export function strtr( input: string, replacements: Array< [ string, string ] > ): string {
	const sorted = [ ...replacements ].sort(
		( first, second ) => second[ 0 ].length - first[ 0 ].length
	);
	let out = '';
	let pos = 0;

	outer: while ( pos < input.length ) {
		for ( const [ from, to ] of sorted ) {
			if ( from.length > 0 && input.startsWith( from, pos ) ) {
				out += to;
				pos += from.length;
				continue outer;
			}
		}
		out += input[ pos ];
		pos += 1;
	}

	return out;
}

/** Rewrite one file's contents, preserving everything from the marker onward. */
export function rewriteContents(
	contents: string,
	replacements: Array< [ string, string ] >
): string {
	const marker = contents.indexOf( PRESERVE_MARKER );
	if ( marker === -1 ) {
		return strtr( contents, replacements );
	}
	return strtr( contents.slice( 0, marker ), replacements ) + contents.slice( marker );
}

function listFiles( root: string ): string[] {
	const found: string[] = [];

	const walk = ( dir: string ): void => {
		for ( const entry of readdirSync( dir ) ) {
			if ( entry === '.git' ) {
				continue;
			}
			const full = join( dir, entry );
			// lstat (not stat) so a symlink is never followed — a symlinked
			// directory can't send the walk into a cycle, and we don't rewrite
			// through links either.
			const stats = lstatSync( full );
			if ( stats.isSymbolicLink() ) {
				continue;
			}
			if ( stats.isDirectory() ) {
				walk( full );
			} else {
				found.push( full );
			}
		}
	};

	walk( root );
	return found;
}

export interface ScaffoldResult {
	changed: number;
	entryFile: string | null;
	prefix: PrefixSet;
}

/**
 * Rewrite the example prefix set to the partner's names across the laid-down
 * skeleton at `root`, then rename the example entry file. Returns how many
 * files changed and the new entry file name.
 */
export function scaffoldTree( root: string, vendor: string, name: string ): ScaffoldResult {
	const prefix = derivePrefixSet( vendor, name );
	const replacements = buildReplacements( prefix );

	let changed = 0;
	for ( const file of listFiles( root ) ) {
		const relative = file
			.slice( root.length + 1 )
			.split( '\\' )
			.join( '/' );
		if ( SKIP_PATTERN.test( relative ) ) {
			continue;
		}

		// The extension list only covers a few image types. Any other binary the
		// kit ships (.ico, .woff2, .ttf, .pdf) read as utf8 would have its invalid
		// bytes replaced with U+FFFD and be written back corrupted. Sniff for a
		// NUL byte — the reliable text/binary tell — and skip anything binary.
		const raw = readFileSync( file );
		if ( raw.includes( 0 ) ) {
			continue;
		}

		const contents = raw.toString( 'utf8' );
		const updated = rewriteContents( contents, replacements );
		if ( updated !== contents ) {
			writeFileSync( file, updated );
			changed += 1;
		}
	}

	let entryFile: string | null = null;
	const exampleEntry = join( root, 'example-integration.php' );
	if ( existsSync( exampleEntry ) ) {
		entryFile = `${ prefix.nameKebab }.php`;
		renameSync( exampleEntry, join( root, entryFile ) );
	}

	personalizeManifest( root, prefix );
	removeRedundantScaffolder( root );

	return { changed, entryFile, prefix };
}

/**
 * Rewrite the handoff manifest for a fresh scaffold. Two jobs:
 *
 * 1. Fill the fields `init` can derive from the integration name but the token
 *    rewrite can't — the Starter-Kit-self-referential `summary` and
 *    `release.changelog`.
 * 2. Blank the fields only the partner can supply — the support contact and the
 *    documentation URLs — with the `MANIFEST_PLACEHOLDER` sentinel, so
 *    `vip-integration validate` fails until the partner replaces them. The
 *    sentinel is a valid value for each field, so the failure is a clear
 *    "fill this in", not a schema error.
 *
 * The rest is either already set by the prefix rewrite (slug, names, namespace,
 * constant, telemetry prefix) or is real integration content (the config fields,
 * telemetry declarations) the partner edits as they build. All edits preserve
 * comments, so the `# yaml-language-server` modeline and inline notes survive.
 */
function personalizeManifest( root: string, prefix: PrefixSet ): void {
	const file = MANIFEST_FILENAMES.map( name => join( root, name ) ).find( existsSync );
	if ( ! file ) {
		return;
	}
	const displayName = wordsCase( prefix.nameKebab );
	const original = readFileSync( file, 'utf8' );
	const updated = original
		.replace( /^( *)summary: .*/m, `$1summary: ${ displayName } integration for WordPress VIP.` )
		.replace( /^( *)changelog: .*/m, '$1changelog: Initial release.' )
		.replace( /^( *)support_contact: .*/m, `$1support_contact: ${ MANIFEST_PLACEHOLDER }` )
		.replace( /^( *)public_url: .*/m, `$1public_url: https://${ MANIFEST_PLACEHOLDER }` )
		.replace( /^( *)support_url: .*/m, `$1support_url: https://${ MANIFEST_PLACEHOLDER }` );
	if ( updated !== original ) {
		writeFileSync( file, updated );
	}
}

/**
 * `vip-integration init` replaces the Starter Kit's own `composer setup`, so the
 * `bin/setup.php` scaffolder and its composer script are dead weight in a
 * generated integration — and re-running them would re-mangle the prefix set.
 * Drop both, leaving nothing that dangles.
 */
function removeRedundantScaffolder( root: string ): void {
	rmSync( join( root, 'bin', 'setup.php' ), { force: true } );

	const composerPath = join( root, 'composer.json' );
	if ( ! existsSync( composerPath ) ) {
		return;
	}

	type ComposerScripts = {
		scripts?: Record< string, unknown >;
		'scripts-descriptions'?: Record< string, unknown >;
	};
	let composer: ComposerScripts;
	try {
		composer = JSON.parse( readFileSync( composerPath, 'utf8' ) ) as ComposerScripts;
	} catch {
		// A malformed composer.json is the integration's problem, not ours to
		// rewrite; leave it untouched.
		return;
	}

	let touched = false;
	for ( const section of [ 'scripts', 'scripts-descriptions' ] as const ) {
		const bag = composer[ section ];
		if ( bag && Object.hasOwn( bag, 'setup' ) ) {
			delete bag.setup;
			touched = true;
		}
	}
	if ( touched ) {
		writeFileSync( composerPath, `${ JSON.stringify( composer, null, 2 ) }\n` );
	}
}
