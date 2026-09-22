/**
 * Conformance checker for WordPress VIP partner integrations.
 *
 * Encodes the VIP integration conformance checklist as automated, static checks
 * a partner can run locally and in CI to get an objective
 * conformant / not-conformant answer before submitting.
 *
 * The checks here are deliberately static (file and config inspection). Some
 * rules can only be partially verified this way; those return `warn` and say
 * so rather than pretending a clean pass. Two items — the plugin/platform
 * config-schema match and the security review — are not automatable at all and
 * are surfaced separately as human-review, never as an automated pass/fail.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

import { MANIFEST_FILENAMES, inspectManifest } from './manifest';
import { MANIFEST_PLACEHOLDER } from './manifest.schema';
import {
	REQUIRED_PHP_VERSIONS,
	REQUIRED_WP_VERSIONS,
	WP_BASELINE_LAST_VERIFIED,
} from './wp-baseline';

import type { ManifestInspection } from './manifest';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'not_applicable';

export interface CheckResult {
	/** Stable machine identifier for the rule. */
	id: string;
	/** Checklist number (1-9) this rule maps to. */
	rule: number;
	title: string;
	status: CheckStatus;
	/** One-line explanation of the verdict. */
	message: string;
	/** Optional supporting evidence lines. */
	details?: string[];
}

export interface HumanReviewItem {
	title: string;
	reason: string;
}

export interface ValidationReport {
	path: string;
	results: CheckResult[];
	humanReview: HumanReviewItem[];
	/** True when no check failed. Warnings do not break conformance. */
	conformant: boolean;
	/**
	 * True when no runtime config constant was detected, so the config rules
	 * (4-6) were skipped rather than checked. Surfaced prominently because an
	 * all-skipped config result must not read as a clean pass.
	 */
	configChecksSkipped: boolean;
}

interface ComposerJson {
	type?: string;
	autoload?: Record< string, unknown >;
	scripts?: Record< string, unknown >;
	require?: Record< string, string >;
	extra?: Record< string, unknown >;
}

interface Context {
	root: string;
	composer: ComposerJson | null;
	/** True when composer.json is present, even if it failed to parse. */
	composerExists: boolean;
	/** npm scripts, so a `composer test` that shells to `npm test` can be resolved. */
	packageScripts: Record< string, unknown > | null;
	/** Concatenated markdown from README plus every file under docs/. */
	docsText: string;
	/** Concatenated PHP source, excluding vendor/ and node_modules/. */
	phpSource: string;
	/** Concatenated YAML from .github/workflows/. */
	workflowsText: string;
	/** The runtime config constant referenced by the integration, if any. */
	configConstant: string | null;
	/** Root-level plugin entry file (with a "Plugin Name:" header), if any. */
	entryFile: string | null;
	/** Result of reading and validating the handoff manifest at the root. */
	manifest: ManifestInspection;
}

const SKIP_DIRS = new Set( [ 'vendor', 'node_modules', '.git', 'dist', 'coverage' ] );

function readFileSafe( filePath: string ): string {
	try {
		return readFileSync( filePath, 'utf8' );
	} catch {
		return '';
	}
}

function parseComposer( root: string ): ComposerJson | null {
	const composerPath = join( root, 'composer.json' );
	if ( ! existsSync( composerPath ) ) {
		return null;
	}
	try {
		return JSON.parse( readFileSafe( composerPath ) ) as ComposerJson;
	} catch {
		return null;
	}
}

function parsePackageScripts( root: string ): Record< string, unknown > | null {
	const packagePath = join( root, 'package.json' );
	if ( ! existsSync( packagePath ) ) {
		return null;
	}
	try {
		const parsed = JSON.parse( readFileSafe( packagePath ) ) as {
			scripts?: Record< string, unknown >;
		};
		return parsed.scripts ?? null;
	} catch {
		return null;
	}
}

/**
 * Collect files with one of the given extensions, skipping dependency and build
 * directories. Bounded to a shallow-ish walk so a stray large tree can't hang.
 */
function collectFiles( root: string, extensions: string[], maxDepth = 6 ): string[] {
	const found: string[] = [];

	const walk = ( dir: string, depth: number ): void => {
		if ( depth > maxDepth ) {
			return;
		}
		let entries: string[];
		try {
			entries = readdirSync( dir );
		} catch {
			return;
		}
		for ( const entry of entries ) {
			const full = join( dir, entry );
			let isDir = false;
			try {
				isDir = statSync( full ).isDirectory();
			} catch {
				continue;
			}
			if ( isDir ) {
				if ( ! SKIP_DIRS.has( entry ) && ! entry.startsWith( '.' ) ) {
					walk( full, depth + 1 );
				}
				continue;
			}
			if ( extensions.includes( extname( entry ).toLowerCase() ) ) {
				found.push( full );
			}
		}
	};

	walk( root, 0 );
	return found;
}

function collectDocsText( root: string ): string {
	const parts: string[] = [];
	const readme = join( root, 'README.md' );
	if ( existsSync( readme ) ) {
		parts.push( readFileSafe( readme ) );
	}
	const docsDir = join( root, 'docs' );
	if ( existsSync( docsDir ) ) {
		for ( const file of collectFiles( docsDir, [ '.md' ] ) ) {
			parts.push( readFileSafe( file ) );
		}
	}
	return parts.join( '\n\n' );
}

function collectWorkflowsText( root: string ): string {
	const dir = join( root, '.github', 'workflows' );
	if ( ! existsSync( dir ) ) {
		return '';
	}
	return collectFiles( dir, [ '.yml', '.yaml' ], 2 ).map( readFileSafe ).join( '\n\n' );
}

function detectConfigConstant( phpSource: string ): string | null {
	// Prefer the Starter Kit pattern: a Config class declaring
	// `const CONSTANT_NAME = '<CONSTANT>'`. This catches integrations that follow
	// the convention even if they don't use the VIP_*_CONFIG suffix.
	const declared = /CONSTANT_NAME\s*=\s*'([A-Z_][A-Z0-9_]*)'/.exec( phpSource );
	if ( declared ) {
		return declared[ 1 ];
	}
	// Fall back to a VIP_<NAME>_CONFIG constant referenced anywhere.
	const referenced = /\bVIP_[A-Z0-9_]+_CONFIG\b/.exec( phpSource );
	return referenced ? referenced[ 0 ] : null;
}

function detectEntryFile( root: string ): string | null {
	// The plugin entry file lives at the repo root and carries a plugin header.
	let entries: string[];
	try {
		entries = readdirSync( root );
	} catch {
		return null;
	}
	for ( const entry of entries ) {
		if ( extname( entry ).toLowerCase() !== '.php' ) {
			continue;
		}
		const contents = readFileSafe( join( root, entry ) );
		if ( /Plugin Name:/i.test( contents ) ) {
			return entry;
		}
	}
	return null;
}

function buildContext( root: string ): Context {
	const composer = parseComposer( root );
	const phpFiles = collectFiles( root, [ '.php' ] );
	const phpSource = phpFiles.map( readFileSafe ).join( '\n\n' );

	return {
		root,
		composer,
		composerExists: existsSync( join( root, 'composer.json' ) ),
		packageScripts: parsePackageScripts( root ),
		docsText: collectDocsText( root ),
		phpSource,
		workflowsText: collectWorkflowsText( root ),
		configConstant: detectConfigConstant( phpSource ),
		entryFile: detectEntryFile( root ),
		manifest: inspectManifest( root ),
	};
}

/**
 * Expand a Composer script into the concrete commands it runs, following
 * `@other-script` references. `@php ...` and other non-script `@` calls are
 * kept as literal commands.
 */
function resolveComposerScript(
	scripts: Record< string, unknown >,
	name: string,
	seen: Set< string > = new Set()
): string[] {
	if ( seen.has( name ) ) {
		return [];
	}
	seen.add( name );

	const raw = scripts[ name ];
	if ( raw === undefined || raw === null ) {
		return [];
	}

	// Composer script values are a command string or an array of them.
	const rawEntries: unknown[] = Array.isArray( raw ) ? raw : [ raw ];
	const entries = rawEntries.filter( ( item ): item is string => typeof item === 'string' );
	const commands: string[] = [];

	for ( const entry of entries ) {
		const trimmed = entry.trim();
		if ( trimmed.startsWith( '@' ) ) {
			const refName = trimmed.slice( 1 ).split( /\s+/ )[ 0 ];
			if ( Object.hasOwn( scripts, refName ) ) {
				commands.push( ...resolveComposerScript( scripts, refName, seen ) );
				continue;
			}
		}
		commands.push( trimmed );
	}

	return commands;
}

/**
 * Expand `npm test` / `npm run <script>` commands into the package.json script
 * body they run, so a `composer test` that delegates to npm is judged by what
 * npm actually runs (e.g. `playwright test`), not by the word "test".
 */
function expandNpmDelegations(
	commands: string[],
	packageScripts: Record< string, unknown > | null
): string[] {
	if ( ! packageScripts ) {
		return commands;
	}
	const expanded: string[] = [];
	for ( const cmd of commands ) {
		expanded.push( cmd );
		const match = /\bnpm (?:run )?([a-z0-9:_-]+)/i.exec( cmd );
		if ( match ) {
			const body = packageScripts[ match[ 1 ] ];
			if ( typeof body === 'string' ) {
				expanded.push( body );
			}
		}
	}
	return expanded;
}

/**
 * Drop no-op commands (echo/comment/true) that do not actually run anything.
 * Each entry is split on shell separators first, so a real command chained after
 * a banner — `echo "Running tests" && phpunit` — keeps its `phpunit` segment
 * instead of the whole entry being discarded because it starts with `echo`.
 */
function realCommands( commands: string[] ): string[] {
	return commands
		.flatMap( cmd => cmd.split( /\s*(?:&&|\|\||;|\|)\s*/ ) )
		.map( segment => segment.trim() )
		.filter( segment => segment !== '' && ! /^(echo|:|true|#)\b/.test( segment ) );
}

/** Fenced code blocks (```...```) that mention the given needle. */
function codeBlocksMentioning( markdown: string, needle: string ): string[] {
	const blocks = markdown.match( /```[\s\S]*?```/g ) ?? [];
	return blocks.filter( block => block.includes( needle ) );
}

/**
 * Whether any resolved command actually *invokes* one of the given runners.
 * The runner must be the command being run — at the start of the segment,
 * optionally via a package runner (npx/pnpm/yarn) or `@php`, or from a
 * `vendor/bin/` path — not merely a substring. So `rm -rf cypress-artifacts`
 * does not count as running Cypress.
 */
function invokesRunner( commands: string[], runners: string[] ): boolean {
	const alternation = runners.join( '|' );
	// runners are fixed alphabetic keywords, so interpolation is safe.
	// eslint-disable-next-line security/detect-non-literal-regexp
	const re = new RegExp(
		String.raw`^(?:(?:npx|pnpm|yarn|bunx|@php)\s+)?(?:[\w./@-]*/)?(?:${ alternation })(?:\b|$)`,
		'i'
	);
	return commands.some( command => re.test( command.trim() ) );
}

/**
 * Concatenate the text windows around each occurrence of any needle, so a check
 * can be scoped to the neighbourhood of the thing it cares about (a config
 * constant, a telemetry call) instead of the whole source. Returns '' when no
 * needle occurs.
 */
function windowsAround( source: string, needles: string[], radius: number ): string {
	const parts: string[] = [];
	for ( const needle of needles ) {
		if ( needle === '' ) {
			continue;
		}
		let from = source.indexOf( needle );
		while ( from !== -1 ) {
			parts.push( source.slice( Math.max( 0, from - radius ), from + needle.length + radius ) );
			from = source.indexOf( needle, from + needle.length );
		}
	}
	return parts.join( '\n' );
}

// Precondition stated out loud when the config checks are skipped: detection
// keys off a `Config::CONSTANT_NAME` declaration or a VIP_*_CONFIG constant. An
// integration that uses runtime config under a different pattern is not exempt —
// it must follow the convention or be flagged for human review.
const CONFIG_DETECTION_NOTE =
	'No runtime config constant detected (looked for a `Config::CONSTANT_NAME` declaration or a `VIP_*_CONFIG` constant). If this integration uses runtime config under another name, adopt the convention or flag it for human review — these config checks were skipped, not passed.';

// --- Individual checks -----------------------------------------------------

function checkLoadsThroughStarterKit( ctx: Context ): CheckResult {
	const base = {
		id: 'loads-through-starter-kit',
		rule: 1,
		title: 'Loads through the Starter Kit workflow',
	};
	const details: string[] = [];

	if ( ! ctx.composer ) {
		return {
			...base,
			status: 'fail',
			message: ctx.composerExists
				? 'composer.json is present but is not valid JSON.'
				: 'No composer.json found — VIP loads integrations as Composer wordpress-plugin packages.',
		};
	}
	if ( ! ctx.entryFile ) {
		return {
			...base,
			status: 'fail',
			message: 'No root-level plugin entry file with a "Plugin Name:" header was found.',
		};
	}
	details.push( `Entry file: ${ ctx.entryFile }` );

	// A wrong Composer "type" or a missing autoload both stop the integration
	// from loading through the Starter Kit workflow. These are deterministic, so
	// they fail the gate rather than merely warn.
	const problems: string[] = [];
	if ( ctx.composer.type !== 'wordpress-plugin' ) {
		problems.push(
			`composer.json "type" is "${
				ctx.composer.type ?? 'unset'
			}"; it must be "wordpress-plugin" so VIP loads it as a plugin`
		);
	}
	if ( ! ctx.composer.autoload ) {
		problems.push(
			'composer.json has no "autoload" section, so the integration\'s classes will not load'
		);
	}

	if ( problems.length > 0 ) {
		return { ...base, status: 'fail', message: `${ problems.join( '; ' ) }.`, details };
	}

	details.push( 'composer.json type is "wordpress-plugin" with an autoload section.' );
	return {
		...base,
		status: 'pass',
		message: 'Plugin entry file and Composer wordpress-plugin package are present.',
		details,
	};
}

function checkComposerTest( ctx: Context ): CheckResult {
	const base = {
		id: 'composer-test',
		rule: 2,
		title: '`composer test` runs PHPUnit and e2e tests',
	};
	const scripts = ctx.composer?.scripts;
	if ( ! scripts || ! Object.hasOwn( scripts, 'test' ) ) {
		return { ...base, status: 'fail', message: 'composer.json has no "test" script.' };
	}

	// Resolve @script references, then drop no-op (echo/comment) commands *before*
	// following npm delegations — otherwise a fake `echo npm test` would expand
	// into the real `npm test` body and smuggle a passing e2e run past the filter.
	// Filter again after expansion in case a delegated body is itself a no-op.
	const commands = realCommands(
		expandNpmDelegations(
			realCommands( resolveComposerScript( scripts, 'test' ) ),
			ctx.packageScripts
		)
	);
	const combined = commands.join( ' • ' );
	// Match the runner as the command actually invoked, not a substring — a
	// segment like `rm -rf cypress-artifacts` must not count as running Cypress.
	const hasUnit = invokesRunner( commands, [ 'phpunit' ] );
	const hasE2e = invokesRunner( commands, [ 'playwright', 'cypress', 'codeception', 'puppeteer' ] );

	if ( hasUnit && hasE2e ) {
		return {
			...base,
			status: 'pass',
			message: 'composer test declares a PHPUnit run and an e2e runner (Playwright/Cypress).',
			details: [
				`Resolved commands: ${ combined }`,
				'Static check: it verifies the test commands are wired, not that the tests pass.',
			],
		};
	}

	const missing: string[] = [];
	if ( ! hasUnit ) {
		missing.push( 'PHPUnit (no `phpunit` invocation)' );
	}
	if ( ! hasE2e ) {
		missing.push( 'an e2e runner (no Playwright/Cypress invocation)' );
	}
	return {
		...base,
		status: 'fail',
		message: `composer test does not wire up: ${ missing.join( ' and ' ) }.`,
		details: [ `Resolved commands: ${ combined || '(none)' }` ],
	};
}

/**
 * Strip PHP comments so a `REQUIRED_FIELDS` / `SENSITIVE_FIELDS` mention inside a
 * `//`, `#`, or block comment isn't read as the real config contract. Best-effort
 * and does not track string literals — fine for reading a `const` array. The `//`
 * and `#` passes require a non-`:` / whitespace lead-in so a `https://` or `#fff`
 * inside a string isn't mistaken for a comment start.
 */
function stripPhpComments( source: string ): string {
	return source
		.replace( /\/\*[\s\S]*?\*\//g, '' )
		.replace( /(^|[^:])\/\/[^\n]*/g, '$1' )
		.replace( /(^|\s)#[^\n]*/g, '$1' );
}

/**
 * Pull a PHP `const NAME = [ 'a', 'b' ]` string array out of the source. Used to
 * read the config contract the Starter Kit's Config class declares. Anchored on a
 * `const <NAME>` declaration with a word boundary, so an unrelated constant whose
 * name merely ends in `<NAME>` (e.g. `CUSTOM_REQUIRED_FIELDS`) is not mistaken for
 * it. Keys may be single- or double-quoted.
 */
function phpConstStringArray( source: string, constName: string ): string[] {
	// constName is a fixed alphabetic keyword, so interpolation is safe.
	// eslint-disable-next-line security/detect-non-literal-regexp
	const re = new RegExp( String.raw`\bconst\s+${ constName }\s*=\s*\[([^\]]*)\]` );
	const match = re.exec( source );
	if ( ! match ) {
		return [];
	}
	return [ ...match[ 1 ].matchAll( /['"]([a-z0-9_]+)['"]/g ) ].map( entry => entry[ 1 ] );
}

interface ManifestField {
	type?: string;
	required: boolean;
}

/** Index the manifest's declared `runtime_config.fields` by key. */
function manifestConfigFields(
	parsed: Record< string, unknown > | null
): Map< string, ManifestField > {
	const byKey = new Map< string, ManifestField >();
	const runtimeConfig = parsed?.runtime_config;
	const fields =
		runtimeConfig && typeof runtimeConfig === 'object'
			? ( runtimeConfig as Record< string, unknown > ).fields
			: undefined;
	if ( ! Array.isArray( fields ) ) {
		return byKey;
	}
	for ( const field of fields ) {
		if ( field && typeof field === 'object' ) {
			const record = field as Record< string, unknown >;
			if ( typeof record.key === 'string' ) {
				byKey.set( record.key, {
					type: typeof record.type === 'string' ? record.type : undefined,
					required: record.required === true,
				} );
			}
		}
	}
	return byKey;
}

/**
 * Cross-check the config keys the plugin declares (`Config::REQUIRED_FIELDS` and
 * `Config::SENSITIVE_FIELDS`) against the manifest's `runtime_config.fields`, so
 * a field the code reads from the config constant can't be missing from — or
 * mis-typed in — the manifest VIP registers from. Deterministic for integrations
 * following the Starter Kit Config convention; skipped (empty) for any plugin
 * that declares neither array.
 */
function configFieldMismatches( ctx: Context, fields: Map< string, ManifestField > ): string[] {
	const source = stripPhpComments( ctx.phpSource );
	const required = phpConstStringArray( source, 'REQUIRED_FIELDS' );
	const sensitive = phpConstStringArray( source, 'SENSITIVE_FIELDS' );
	const issues: string[] = [];

	for ( const key of required ) {
		const field = fields.get( key );
		if ( ! field ) {
			issues.push(
				`Config field "${ key }" is required by the plugin (Config::REQUIRED_FIELDS) but is not declared in runtime_config.fields.`
			);
		} else if ( ! field.required ) {
			issues.push(
				`Config field "${ key }" is required by the plugin but is not marked "required: true" in the manifest.`
			);
		}
	}
	for ( const key of sensitive ) {
		const field = fields.get( key );
		if ( ! field ) {
			issues.push(
				`Config field "${ key }" is a secret (Config::SENSITIVE_FIELDS) but is not declared in runtime_config.fields.`
			);
		} else if ( field.type !== 'secret' ) {
			issues.push(
				`Config field "${ key }" holds a secret but is declared as type "${
					field.type ?? 'unset'
				}" instead of "secret" in the manifest.`
			);
		}
	}
	return issues;
}

function checkHandoffManifest( ctx: Context ): CheckResult {
	const base = {
		id: 'handoff-manifest',
		rule: 3,
		title: 'Handoff manifest is present and complete',
	};
	const { manifest } = ctx;

	if ( ! manifest.file ) {
		return {
			...base,
			status: 'fail',
			message: `No handoff manifest found (expected ${ MANIFEST_FILENAMES.join(
				' or '
			) } at the integration root).`,
			details: [
				'VIP registers and loads the integration from this manifest alone, so it is required.',
			],
		};
	}
	if ( manifest.parseError ) {
		return {
			...base,
			status: 'fail',
			message: `${ manifest.file } could not be read as YAML: ${ manifest.parseError }.`,
		};
	}

	if ( manifest.errors.length > 0 ) {
		return {
			...base,
			status: 'fail',
			message: `${ manifest.file } does not match the manifest schema — VIP cannot register the integration from it as-is.`,
			details: manifest.errors,
		};
	}

	// An unfilled init placeholder is a definite, blocking gap — VIP cannot
	// register a manifest that still carries one. The config cross-check is
	// different: it reads the plugin's contract heuristically from the
	// concatenated PHP source and takes the first matching `REQUIRED_FIELDS` /
	// `SENSITIVE_FIELDS` const, so it can't be certain it matched the real Config
	// class. A mismatch is therefore surfaced as a non-blocking warning to verify,
	// not a hard failure that could wrongly mark a conformant integration.
	const placeholderIssues = manifest.placeholders.map(
		path =>
			`${ path } still contains the "${ MANIFEST_PLACEHOLDER }" placeholder — replace it with your integration's value.`
	);

	if ( placeholderIssues.length > 0 ) {
		return {
			...base,
			status: 'fail',
			message: `${ manifest.file } is incomplete — resolve the following before submitting.`,
			details: placeholderIssues,
		};
	}

	const configIssues = configFieldMismatches( ctx, manifestConfigFields( manifest.parsed ) );
	if ( configIssues.length > 0 ) {
		return {
			...base,
			status: 'warn',
			message: `${ manifest.file } is schema-valid, but its config fields may not line up with what the plugin declares — double-check the following.`,
			details: [
				...configIssues,
				"Best-effort cross-check: the plugin's config contract is read heuristically from the PHP source, so treat this as a prompt to verify — not a definitive failure.",
			],
		};
	}

	return {
		...base,
		status: 'pass',
		message: `${ manifest.file } is schema-valid, placeholder-free, and its config fields line up with the plugin.`,
		details: [
			'Static check: it confirms the manifest is present, well-formed, and covers the config the code reads, not that the values themselves are correct (that is confirmed in human review).',
		],
	};
}

function checkConfigConstantDocumented( ctx: Context ): CheckResult {
	const base = {
		id: 'config-constant-documented',
		rule: 4,
		title: 'Config constant is documented and referenced in code',
	};
	if ( ! ctx.configConstant ) {
		return { ...base, status: 'not_applicable', message: CONFIG_DETECTION_NOTE };
	}
	if ( ctx.docsText.includes( ctx.configConstant ) ) {
		return {
			...base,
			status: 'pass',
			message: `Config constant ${ ctx.configConstant } is referenced in code and documented.`,
		};
	}
	return {
		...base,
		status: 'fail',
		message: `Config constant ${ ctx.configConstant } is used in code but not documented in README/docs.`,
	};
}

function checkGracefulConfigHandling( ctx: Context ): CheckResult {
	const base = {
		id: 'graceful-config-handling',
		rule: 5,
		title: 'Missing/invalid config is handled without fataling',
	};
	if ( ! ctx.configConstant ) {
		return { ...base, status: 'not_applicable', message: CONFIG_DETECTION_NOTE };
	}

	// Scope the guard search to the neighbourhood of the config constant, so a
	// generic `is_array()` elsewhere in the plugin does not read as a guard on
	// the config access itself. Both the constant literal and the Starter Kit's
	// `CONSTANT_NAME` declaration anchor the window.
	const configWindow = windowsAround( ctx.phpSource, [ ctx.configConstant, 'CONSTANT_NAME' ], 600 );

	const guards = [
		{ re: /is_ready\s*\(/, label: 'is_ready()' },
		{ re: /missing_fields\s*\(/, label: 'missing_fields()' },
		{ re: /is_available\s*\(/, label: 'is_available()' },
		{
			// configConstant is matched from source as [A-Z0-9_]+ only, so it is
			// safe to interpolate into a pattern here.
			// eslint-disable-next-line security/detect-non-literal-regexp
			re: new RegExp( String.raw`defined\s*\(\s*(self::CONSTANT_NAME|'${ ctx.configConstant }')` ),
			label: 'defined() guard',
		},
		{ re: /is_array\s*\(/, label: 'is_array() guard' },
	];
	const present = guards
		.filter( guard => guard.re.test( configWindow ) )
		.map( guard => guard.label );

	if ( present.length > 0 ) {
		return {
			...base,
			status: 'pass',
			message: 'Config access is guarded against a missing or invalid constant.',
			details: [
				`Guards found: ${ present.join( ', ' ) }`,
				"Static signal only — behavioral proof comes from the integration's own tests (rule 2).",
			],
		};
	}

	return {
		...base,
		status: 'warn',
		message:
			'Could not find a static guard (is_ready()/defined()/is_array()) around config access.',
		details: [
			'Verify via tests that missing or invalid config degrades gracefully instead of fataling.',
		],
	};
}

function checkConfigExamplesInDocs( ctx: Context ): CheckResult {
	const base = {
		id: 'config-examples-in-docs',
		rule: 6,
		title: 'Docs include valid and incomplete config examples',
	};
	if ( ! ctx.configConstant ) {
		return { ...base, status: 'not_applicable', message: CONFIG_DETECTION_NOTE };
	}

	const blocks = codeBlocksMentioning( ctx.docsText, ctx.configConstant );
	if ( blocks.length === 0 ) {
		return {
			...base,
			status: 'fail',
			message: `No documented config example references ${ ctx.configConstant }.`,
		};
	}
	if ( blocks.length < 2 ) {
		return {
			...base,
			status: 'fail',
			message:
				'Only one config example is documented; both a valid and an incomplete example are required.',
		};
	}

	// Whether an example is "incomplete" (missing a required field) can't be told
	// apart from a shorter-but-valid example by counting keys — fewer keys usually
	// just means fewer optional settings. So require the docs to label it
	// explicitly rather than guessing.
	const mentionsIncomplete = /incomplete|missing (a )?required|setup in progress/i.test(
		ctx.docsText
	);

	if ( mentionsIncomplete ) {
		return {
			...base,
			status: 'pass',
			message: 'Docs include both a valid and an explicitly labeled incomplete config example.',
		};
	}
	return {
		...base,
		status: 'warn',
		message:
			'Multiple config examples are documented, but none is explicitly labeled as the incomplete/missing-field case. Label it (e.g. "incomplete" or "missing a required field") so the check is not guessing.',
	};
}

/** Whether composer.json declares an approved compatibility exception under
 * the structured `extra.vip.compatibility-exception` key. */
function claimsCompatibilityException( composer: ComposerJson | null ): boolean {
	const extra = composer?.extra;
	if ( ! extra || typeof extra !== 'object' ) {
		return false;
	}
	const vip = extra.vip;
	if ( ! vip || typeof vip !== 'object' ) {
		return false;
	}
	return ( vip as Record< string, unknown > )[ 'compatibility-exception' ] === 'approved';
}

/**
 * The version tokens in a matrix key's same-line value. A flow array (`[…]`) is
 * read to its closing bracket; any other value stops at the next flow-mapping
 * entry boundary (`,` / `}`) or an inline `#` comment — so `wp: 6.9, php: '8.5'`
 * doesn't bleed the PHP value into the WordPress scan, and a trailing comment's
 * versions aren't mistaken for coverage.
 */
function valueTokens( rawValue: string, tokenRe: RegExp ): RegExpMatchArray | null {
	const value = rawValue.trim();
	if ( value.startsWith( '[' ) ) {
		const end = value.indexOf( ']' );
		return ( end === -1 ? value : value.slice( 1, end ) ).match( tokenRe );
	}
	return value.split( /[,}#]/ )[ 0 ].match( tokenRe );
}

/**
 * Collect the version tokens a CI matrix lists against a given key (`php`, `wp`,
 * …), scoped so unrelated tokens elsewhere in the workflow aren't counted — a
 * bare `mysql:8.4` or a `node: [6.9, 7.0]` matrix must not read as PHP or
 * WordPress coverage. Handles the three common GitHub Actions matrix forms: a
 * same-line scalar (`php: '8.5'`), a flow array (`php: [8.2, 8.3]`), and a block
 * sequence (`php:` then `- '8.2'` items on the next lines). Returns `x.y`
 * version numbers plus the literal `latest`.
 */
function collectMatrixVersions( workflowsText: string, keyPattern: string ): Set< string > {
	const versions = new Set< string >();
	const lines = workflowsText.split( /\r?\n/ );
	// keyPattern is a fixed internal literal, so interpolation is safe.
	// eslint-disable-next-line security/detect-non-literal-regexp
	const keyRe = new RegExp( String.raw`\b(?:${ keyPattern })['"]?\s*[:=]\s*([^\n]*)`, 'gi' );
	const tokenRe = /\d+\.\d+|latest/gi;
	const itemRe = /^\s*-\s*['"]?(\d+\.\d+|latest)/i;

	for ( let line = 0; line < lines.length; line++ ) {
		for ( const key of lines[ line ].matchAll( keyRe ) ) {
			for ( const token of valueTokens( key[ 1 ], tokenRe ) ?? [] ) {
				versions.add( token.toLowerCase() );
			}
			if ( key[ 1 ].trim() !== '' ) {
				continue;
			}
			// Nothing follows the key: a block sequence carries the values on the
			// next lines as `- 8.2` items. Read them until the sequence ends.
			for ( let next = line + 1; next < lines.length; next++ ) {
				const item = itemRe.exec( lines[ next ] );
				if ( ! item ) {
					break;
				}
				versions.add( item[ 1 ].toLowerCase() );
			}
		}
	}
	return versions;
}

function checkCompatibilityMatrix( ctx: Context ): CheckResult {
	const [ currentWpVersion, previousWpVersion ] = REQUIRED_WP_VERSIONS;
	const wpRangeLabel = `${ previousWpVersion }/${ currentWpVersion }`;
	const phpRangeLabel = `${ REQUIRED_PHP_VERSIONS[ 0 ] }-${
		REQUIRED_PHP_VERSIONS[ REQUIRED_PHP_VERSIONS.length - 1 ]
	}`;
	const base = {
		id: 'compatibility-matrix',
		rule: 7,
		title: `Compatibility evidence covers WP ${ wpRangeLabel } and PHP ${ phpRangeLabel }`,
	};
	// Evidence must be a real CI matrix (.github/workflows) or an explicit,
	// structured exception flag — not a version number or phrase that happens to
	// appear in a changelog or prose. A prose scan lets a line like "there is no
	// approved exception on file" pass, so the exception is claimed through a
	// dedicated composer.json field instead, and it downgrades to a warning that
	// still needs reviewer sign-off rather than an automated clean pass.
	if ( claimsCompatibilityException( ctx.composer ) ) {
		return {
			...base,
			status: 'warn',
			message:
				'A compatibility exception is claimed in composer.json (extra.vip.compatibility-exception). It does not fail conformance, but a reviewer must confirm the exception.',
		};
	}

	if ( ctx.workflowsText.trim() === '' ) {
		return {
			...base,
			status: 'fail',
			message: `No CI workflows found to evidence the compatibility matrix (WP ${ wpRangeLabel }, PHP ${ phpRangeLabel }).`,
			details: [
				'Add a CI matrix under .github/workflows, or document an approved compatibility exception note.',
			],
		};
	}

	const missing: string[] = [];
	// Scope the WordPress scan to a `wp` / `wordpress` matrix key, exactly as PHP
	// is scoped below — a bare version number elsewhere (a `node` matrix, an
	// action tag, `runs-on: ubuntu-latest`) is not WordPress evidence. The
	// current release in CI is often written as `wp: latest`, so that counts too
	// — it tracks whatever WordPress ships next with no edits needed here.
	const wpVersions = collectMatrixVersions(
		ctx.workflowsText,
		'w(?:p|ordpress)(?:[-_]versions?)?'
	);
	if ( ! wpVersions.has( previousWpVersion ) ) {
		missing.push( `WordPress ${ previousWpVersion }` );
	}
	if ( ! wpVersions.has( currentWpVersion ) && ! wpVersions.has( 'latest' ) ) {
		missing.push( `WordPress ${ currentWpVersion } (or 'latest')` );
	}
	// Accept `php-versions` (plural) alongside `php` / `php-version` — the plural
	// is the key `shivammathur/setup-php` examples use, so a conformant matrix
	// must not be failed just for pluralizing it.
	const phpVersions = collectMatrixVersions( ctx.workflowsText, 'php(?:[-_]versions?)?' );
	for ( const php of REQUIRED_PHP_VERSIONS ) {
		if ( ! phpVersions.has( php ) ) {
			missing.push( `PHP ${ php }` );
		}
	}

	if ( missing.length === 0 ) {
		return {
			...base,
			status: 'pass',
			message: `CI matrix covers WP ${ wpRangeLabel } and PHP ${ phpRangeLabel }.`,
		};
	}
	return {
		...base,
		status: 'fail',
		message: `CI compatibility matrix is missing: ${ missing.join( ', ' ) }.`,
		details: [
			'Cover the matrix in CI (.github/workflows) or add an approved compatibility exception note.',
			`Required baseline: WordPress ${ wpRangeLabel } (or 'latest' for ${ currentWpVersion }), PHP ${ phpRangeLabel }. Last verified ${ WP_BASELINE_LAST_VERIFIED } — see src/lib/validate/wp-baseline.ts.`,
		],
	};
}

function checkBuildTestCommandsDocumented( ctx: Context ): CheckResult {
	const base = {
		id: 'build-test-commands-documented',
		rule: 8,
		title: 'Build and test commands are documented',
	};
	// Keep the e2e runner vocabulary aligned with Rule 2 so docs that use a
	// different runner (Cypress, Codeception, Puppeteer) aren't dinged here.
	const hasTest =
		/composer (run )?test|phpunit|\b(playwright|cypress|codeception|puppeteer)\b/i.test(
			ctx.docsText
		);
	const hasBuild = /npm run build|npm ci|composer install|npm install/i.test( ctx.docsText );

	if ( hasTest && hasBuild ) {
		return {
			...base,
			status: 'pass',
			message: 'Docs document both build/install and test commands.',
		};
	}

	const missing: string[] = [];
	if ( ! hasBuild ) {
		missing.push( 'build/install commands' );
	}
	if ( ! hasTest ) {
		missing.push( 'test commands' );
	}
	return { ...base, status: 'fail', message: `Docs are missing: ${ missing.join( ' and ' ) }.` };
}

function checkTelemetryTracksOnly( ctx: Context ): CheckResult {
	const base = {
		id: 'telemetry-tracks-only',
		rule: 9,
		title: 'Telemetry uses the Starter Kit pattern (Tracks only, no secrets)',
	};
	const usesTelemetry = /Telemetry|record_event\s*\(/.test( ctx.phpSource );
	if ( ! usesTelemetry ) {
		return {
			...base,
			status: 'not_applicable',
			message: 'The integration does not record telemetry.',
		};
	}

	// Scope the guard and Tracks-API detection to the neighbourhood of the
	// telemetry calls, so an unrelated `class_exists()` elsewhere in the plugin
	// doesn't read as a guard on the telemetry itself.
	const telemetryWindow = windowsAround(
		ctx.phpSource,
		[ 'record_event', 'Telemetry', 'record_pixel' ],
		600
	);
	const usesVipTelemetryApi = /Automattic\\VIP\\Telemetry/.test( telemetryWindow );
	const guarded = /class_exists\s*\(/.test( telemetryWindow );
	const usesStats = /Automattic\\VIP\\Stats|record_pixel|->pixel\b/.test( ctx.phpSource );

	if ( usesStats ) {
		return {
			...base,
			status: 'fail',
			message: 'Telemetry uses Stats/Pixel; VIP integrations must use Tracks events only.',
		};
	}

	// Best-effort scan for obvious secret/PII keys in event properties. This is
	// advisory: real secret review stays in the human-review layer.
	const suspicious = (
		ctx.phpSource.match(
			/record_event\s*\([\s\S]{0,400}?['"](password|secret|api_token|token|credential|email)['"]/gi
		) ?? []
	).length;

	if ( ! usesVipTelemetryApi || ! guarded ) {
		return {
			...base,
			status: 'warn',
			message:
				'Telemetry is recorded, but the VIP Telemetry (Tracks) helper pattern with a class_exists guard was not detected.',
		};
	}
	if ( suspicious > 0 ) {
		return {
			...base,
			status: 'warn',
			message:
				'Telemetry uses the Tracks helper, but event properties may include secret/PII keys — review before submitting.',
		};
	}

	return {
		...base,
		status: 'pass',
		message: 'Telemetry uses the guarded VIP Tracks helper with no obvious secrets in properties.',
	};
}

const HUMAN_REVIEW: HumanReviewItem[] = [
	{
		title: 'Plugin - platform config-schema match',
		reason:
			"Whether the plugin's expected config matches the platform schema is not fully deterministic and is confirmed in human review, not by this checker.",
	},
	{
		title: 'Security review',
		reason:
			'Security posture (input handling, secret storage, capability checks) is assessed in human review, not by this checker.',
	},
];

/**
 * Run every conformance check against an integration directory and return a
 * structured report. `conformant` is false when any check has status `fail`.
 */
export function validateIntegration( root: string ): ValidationReport {
	const ctx = buildContext( root );

	const results: CheckResult[] = [
		checkLoadsThroughStarterKit( ctx ),
		checkComposerTest( ctx ),
		checkHandoffManifest( ctx ),
		checkConfigConstantDocumented( ctx ),
		checkGracefulConfigHandling( ctx ),
		checkConfigExamplesInDocs( ctx ),
		checkCompatibilityMatrix( ctx ),
		checkBuildTestCommandsDocumented( ctx ),
		checkTelemetryTracksOnly( ctx ),
	];

	return {
		path: root,
		results,
		humanReview: HUMAN_REVIEW,
		conformant: ! results.some( result => result.status === 'fail' ),
		configChecksSkipped: ctx.configConstant === null,
	};
}

/** Whether the given path looks like an integration we can check at all. */
export function looksLikeIntegration( root: string ): boolean {
	return existsSync( join( root, 'composer.json' ) ) || detectEntryFile( root ) !== null;
}
