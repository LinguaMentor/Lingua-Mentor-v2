// Stay on ESLint 8 + .eslintrc.json: `next lint` on Next 14 only finds legacy
// config (useEslintrc), so ESLint 9's flat config would leave it with none.
/** @type {import('next').NextConfig} */
const nextConfig = {
	// PWA config, image domains (R2/Cloudflare), etc. go here.
};

module.exports = nextConfig;
