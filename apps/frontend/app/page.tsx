// Public landing page.
export default function HomePage() {
	return (
		<main style={{ fontFamily: "system-ui, -apple-system, sans-serif", padding: 24 }}>
			<h1>LinguaMentor</h1>
			<p>Welcome — the frontend is connected and ready.</p>
			<p>
				To verify connectivity, the app expects `NEXT_PUBLIC_API_BASE_URL` to point at the API
				gateway. A basic health check is available at
				<code>/health</code> on that host.
			</p>
		</main>
	);
}
