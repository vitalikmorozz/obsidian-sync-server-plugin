import { readFileSync, writeFileSync } from "fs";

const arg = process.argv[2];
if (!arg) {
	console.error("Usage: node version-bump.mjs <version>  (e.g. v0.2.2 or 0.2.2)");
	process.exit(1);
}

// Strip leading "v" if present
const targetVersion = arg.replace(/^v/, "");

// Validate semver format
if (!/^\d+\.\d+\.\d+$/.test(targetVersion)) {
	console.error(`Invalid version format: "${targetVersion}". Expected x.y.z (e.g. 0.2.2)`);
	process.exit(1);
}

// Update package.json
let pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.version = targetVersion;
writeFileSync("package.json", JSON.stringify(pkg, null, "\t"));

// Update manifest.json (read minAppVersion, bump version)
let manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"));

// Update versions.json with target version and minAppVersion
let versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t"));

console.log(`Version bumped to ${targetVersion}`);
