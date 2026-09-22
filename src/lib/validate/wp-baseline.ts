/**
 * The WordPress and PHP versions `checkCompatibilityMatrix` (Rule 7) requires
 * CI evidence for.
 *
 * This is data, not logic, and lives in its own file so bumping it after a
 * WordPress release is a one-line diff here instead of a hunt through the
 * rule's conditionals. Update `REQUIRED_WP_VERSIONS` (and
 * `WP_BASELINE_LAST_VERIFIED`) when a new WordPress minor ships.
 */

/** ISO date this baseline was last verified. */
export const WP_BASELINE_LAST_VERIFIED = '2026-09-22';

/**
 * The two WordPress minor releases CI must cover: `[current, previous]`.
 * `checkCompatibilityMatrix` also accepts a literal `latest` in the matrix in
 * place of `current`, since that value tracks the current release on its own
 * with no edits needed here.
 */
export const REQUIRED_WP_VERSIONS: readonly [ current: string, previous: string ] = [
	'7.1',
	'7.0',
];

/** The PHP versions CI must cover (VIP's supported PHP range). */
export const REQUIRED_PHP_VERSIONS: readonly string[] = [ '8.2', '8.3', '8.4', '8.5' ];
