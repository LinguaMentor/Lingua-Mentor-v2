const path = require("node:path");

/** @type {import('next').NextConfig} */
const nextConfig = {
	output: "standalone",
	// Workspace packages live outside apps/frontend; the default trace root
	// would omit them and the standalone server would miss shared-schemas.
	outputFileTracingRoot: path.join(__dirname, "../.."),
};

module.exports = nextConfig;
