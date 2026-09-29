import { describe, expect, it } from "vitest";
import { getThetaUserAgent } from "../src/utils/theta-user-agent.ts";

describe("getThetaUserAgent", () => {
	it("formats the user agent expected by the version endpoint", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getThetaUserAgent("1.2.3");

		expect(userAgent).toBe(`theta/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^theta\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});

