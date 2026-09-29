export function getThetaUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `theta/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}

