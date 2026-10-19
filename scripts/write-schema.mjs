#!/usr/bin/env node

/**
 * Write the manifest JSON Schema to docs/vip-manifest.schema.json from the
 * compiled source in dist/, formatted with the repo's Prettier config. Run it
 * through `pnpm schema`, which builds first. A test fails while the committed
 * file is out of date.
 *
 * Usage: pnpm schema
 */

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const rootDir = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const require = createRequire( import.meta.url );
const { manifestJsonSchema } = require(
	resolve( rootDir, 'dist/lib/validate/manifest.schema.js' )
);

const outputPath = resolve( rootDir, 'docs/vip-manifest.schema.json' );
const options = await resolveConfig( outputPath );
const json = await format( JSON.stringify( manifestJsonSchema() ), {
	...options,
	filepath: outputPath,
} );

writeFileSync( outputPath, json );
console.log( `Wrote ${ outputPath }` );
